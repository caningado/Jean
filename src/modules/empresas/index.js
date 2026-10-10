// Módulo empresas: clientes que são empresas (oficinas, dealers) com vários solicitantes.
// Cada solicitante é um contato ligado à empresa. O extrato junta os serviços da empresa,
// separados por quem pediu, num PDF só para cobrar tudo de uma vez.
import crypto from 'node:crypto';
import { simplify, nowIso, HttpError } from '../../lib/util.js';
import { monthRange } from '../planilha/index.js';
import { renderStatement } from './statement.js';

const migrations = [
  `CREATE TABLE companies (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     bill_to TEXT,
     email TEXT,
     phone TEXT,
     notes TEXT,
     token TEXT NOT NULL UNIQUE,
     created_at TEXT NOT NULL
   );
   ALTER TABLE contacts ADD COLUMN company_id INTEGER REFERENCES companies(id);
   CREATE INDEX contacts_company ON contacts(company_id);`,
  // Apelido (ex.: "SS" = Super Speed) e regras da empresa: exige VIN para fechar; sempre faz invoice.
  `ALTER TABLE companies ADD COLUMN nickname TEXT;
   ALTER TABLE companies ADD COLUMN requires_vin INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE companies ADD COLUMN always_invoice INTEGER NOT NULL DEFAULT 0;`,
];

const getCompany = (ctx, id) => ctx.db.prepare('SELECT * FROM companies WHERE id = ?').get(Number(id));

function requesters(ctx, companyId) {
  return ctx.db.prepare('SELECT id, name, phone, email FROM contacts WHERE company_id = ? ORDER BY name COLLATE NOCASE').all(companyId);
}

// Dia no fuso da empresa: "2026-10-06".
const localDay = (ctx, iso) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ctx.config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

// Serviços da empresa com quanto falta pagar.
// periodo: 'abertos' (tudo que ainda deve, de qualquer data) ou 'AAAA-MM' (todos do mês).
export function statementData(ctx, company, periodo = 'abertos') {
  const month = /^\d{4}-\d{2}$/.test(periodo) ? monthRange(periodo, ctx.config.timeZone) : null;
  const params = [company.id];
  let where = "c.company_id = ? AND s.status <> 'cancelado' AND s.price_cents > 0";
  if (month) {
    where += ' AND COALESCE(s.completed_at, s.created_at) >= ? AND COALESCE(s.completed_at, s.created_at) < ?';
    params.push(month.from, month.to);
  }
  const rows = ctx.db
    .prepare(
      `SELECT s.*, c.name AS requester, c.id AS requester_id FROM services s JOIN contacts c ON c.id = s.contact_id
       WHERE ${where} ORDER BY c.name COLLATE NOCASE, COALESCE(s.completed_at, s.created_at)`
    )
    .all(...params);
  const services = rows
    .map((s) => {
      const paid = ctx.api.pagamentos ? ctx.api.pagamentos.balance(s).received_cents : 0;
      return {
        id: s.id,
        day: localDay(ctx, s.completed_at || s.created_at),
        requester: s.requester,
        requester_id: s.requester_id,
        vehicle: s.vehicle || '',
        vin: s.vin || '',
        plate: s.plate || '',
        invoices: ctx.api.invoice ? ctx.api.invoice.numbersFor(s.id) : [],
        amount_cents: s.price_cents,
        paid_cents: Math.min(paid, s.price_cents),
        due_cents: Math.max(0, s.price_cents - paid),
      };
    })
    .filter((s) => month || s.due_cents > 0);
  // Agrupado por solicitante.
  const groups = [];
  for (const s of services) {
    let g = groups[groups.length - 1];
    if (!g || g.requester_id !== s.requester_id) groups.push((g = { requester: s.requester, requester_id: s.requester_id, services: [] }));
    g.services.push(s);
  }
  for (const g of groups) {
    g.amount_cents = g.services.reduce((t, s) => t + s.amount_cents, 0);
    g.paid_cents = g.services.reduce((t, s) => t + s.paid_cents, 0);
    g.due_cents = g.services.reduce((t, s) => t + s.due_cents, 0);
  }
  return {
    periodo: month ? month.label : 'abertos',
    groups,
    count: services.length,
    amount_cents: groups.reduce((t, g) => t + g.amount_cents, 0),
    paid_cents: groups.reduce((t, g) => t + g.paid_cents, 0),
    due_cents: groups.reduce((t, g) => t + g.due_cents, 0),
  };
}

function statementPdf(ctx, company, periodo) {
  const data = statementData(ctx, company, periodo);
  const letterhead = ctx.api.invoice?.getCompany() || { name: ctx.config.companyName };
  return renderStatement({
    company: letterhead,
    logo: ctx.api.invoice ? ctx.api.invoice.logo() : null,
    account: company,
    data,
    today: localDay(ctx, nowIso()),
  });
}

const fileName = (company, periodo) => `Statement ${company.name} ${periodo === 'abertos' ? 'open' : periodo}.pdf`.replace(/[^\w &.-]/g, '');

function publicLink(ctx, company, periodo) {
  const base = ctx.api.invoice?.publicBase();
  if (!base) return null;
  return `${base}/extrato/${company.token}.pdf${periodo && periodo !== 'abertos' ? `?mes=${periodo}` : ''}`;
}

function sendPdf(res, buf, name, download) {
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${name}"`);
  res.set('Cache-Control', 'no-store');
  res.send(buf);
}

function listCompanies(ctx) {
  return ctx.db
    .prepare('SELECT c.*, (SELECT COUNT(*) FROM contacts p WHERE p.company_id = c.id) AS requesters_count FROM companies c ORDER BY c.name COLLATE NOCASE')
    .all()
    .map((c) => ({ ...c, due_cents: statementData(ctx, c).due_cents }));
}

// "usave" acha "USAVE Motors".
function findCompanies(ctx, text) {
  const q = simplify(text);
  if (!q) return [];
  const all = ctx.db.prepare('SELECT * FROM companies ORDER BY name COLLATE NOCASE').all();
  const exact = all.filter((c) => simplify(c.name) === q || (c.nickname && simplify(c.nickname) === q));
  if (exact.length) return exact;
  return all.filter((c) => simplify(c.name).includes(q));
}

const flag = (v) => v === true || v === 1 || v === '1' || v === 'on' || v === 'true';

function cleanText(v, max = 300) {
  const s = String(v ?? '').trim().slice(0, max);
  return s || null;
}

function saveCompany(ctx, body, existing = null) {
  const name = cleanText(body.name ?? existing?.name, 120);
  if (!name) throw new HttpError(400, 'Coloque o nome da empresa.');
  const other = ctx.db.prepare('SELECT id FROM companies WHERE name = ? COLLATE NOCASE').get(name);
  if (other && other.id !== existing?.id) throw new HttpError(409, `Já existe a empresa ${name}.`);
  const f = {
    name,
    bill_to: body.bill_to !== undefined ? cleanText(body.bill_to, 400) : existing?.bill_to ?? null,
    email: body.email !== undefined ? cleanText(body.email, 120) : existing?.email ?? null,
    phone: body.phone !== undefined ? cleanText(body.phone, 40) : existing?.phone ?? null,
    notes: body.notes !== undefined ? cleanText(body.notes, 1000) : existing?.notes ?? null,
    nickname: body.nickname !== undefined ? cleanText(body.nickname, 30) : existing?.nickname ?? null,
    requires_vin: body.requires_vin !== undefined ? (flag(body.requires_vin) ? 1 : 0) : existing?.requires_vin ?? 0,
    always_invoice: body.always_invoice !== undefined ? (flag(body.always_invoice) ? 1 : 0) : existing?.always_invoice ?? 0,
  };
  if (f.nickname) {
    const same = ctx.db.prepare('SELECT id, name, nickname FROM companies').all().find((c) => c.id !== existing?.id && c.nickname && simplify(c.nickname) === simplify(f.nickname));
    if (same) throw new HttpError(409, `O apelido "${f.nickname}" já é da ${same.name}.`);
  }
  if (existing) {
    ctx.db
      .prepare('UPDATE companies SET name = ?, bill_to = ?, email = ?, phone = ?, notes = ?, nickname = ?, requires_vin = ?, always_invoice = ? WHERE id = ?')
      .run(f.name, f.bill_to, f.email, f.phone, f.notes, f.nickname, f.requires_vin, f.always_invoice, existing.id);
    return getCompany(ctx, existing.id);
  }
  const info = ctx.db
    .prepare('INSERT INTO companies (name, bill_to, email, phone, notes, nickname, requires_vin, always_invoice, token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(f.name, f.bill_to, f.email, f.phone, f.notes, f.nickname, f.requires_vin, f.always_invoice, crypto.randomBytes(16).toString('base64url'), nowIso());
  return getCompany(ctx, Number(info.lastInsertRowid));
}

const money = (c) => '$' + ((c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const commands = [
  {
    names: ['extrato', 'statement'],
    help: '*extrato usave* – (dono) quanto a empresa deve, separado por solicitante, com o PDF para mandar',
    run({ ctx, user, rawArgs }) {
      if (user.role !== 'dono') return 'Só o dono vê o extrato das empresas.';
      const found = findCompanies(ctx, rawArgs);
      if (found.length !== 1) {
        const names = ctx.db.prepare('SELECT name FROM companies ORDER BY name COLLATE NOCASE').all().map((c) => c.name);
        if (!names.length) return 'Nenhuma empresa cadastrada. Cadastre em *Contatos › 🏢 Empresas* no painel.';
        return `${found.length ? 'Mais de uma empresa com esse nome.' : 'De qual empresa?'} Ex: *extrato ${simplify(names[0]).split(' ')[0]}*\nEmpresas: ${names.join(', ')}`;
      }
      const company = found[0];
      const data = statementData(ctx, company);
      if (!data.count) return `${company.name} não deve nada. 👍`;
      const lines = [`*${company.name}* – deve ${money(data.due_cents)} (${data.count} serviço(s))`];
      for (const g of data.groups) lines.push(`• ${g.requester}: ${money(g.due_cents)} (${g.services.map((s) => `#${s.id}`).join(', ')})`);
      const link = publicLink(ctx, company);
      if (link) lines.push('', 'Encaminhe para a empresa:', `Hi! Here is your statement from ${ctx.api.invoice.getCompany().name}: ${link}`);
      else lines.push('', 'O PDF está no painel: Contatos › 🏢 Empresas.');
      return lines.join('\n');
    },
  },
  {
    names: ['empresa'],
    help: '*empresa usave* – liga quem pediu o serviço atual à empresa',
    run({ ctx, user, rawArgs }) {
      const service = ctx.data.services.active(user);
      if (!service?.contact_id) return 'Abra o serviço primeiro (*abrir 12*). O serviço precisa ter cliente.';
      const found = findCompanies(ctx, rawArgs);
      if (found.length !== 1) {
        const names = ctx.db.prepare('SELECT name FROM companies ORDER BY name COLLATE NOCASE').all().map((c) => c.name);
        return names.length ? `Qual empresa? Empresas: ${names.join(', ')}` : 'Nenhuma empresa cadastrada. Cadastre em *Contatos › 🏢 Empresas* no painel.';
      }
      ctx.db.prepare('UPDATE contacts SET company_id = ? WHERE id = ?').run(found[0].id, service.contact_id);
      const contact = ctx.data.contacts.get(service.contact_id);
      return `🏢 ${contact.name} agora é solicitante da ${found[0].name}. Os serviços dele entram no extrato da empresa.`;
    },
  },
];

function routes(api, ctx) {
  const owner = (req) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o dono mexe nas empresas.');
  };
  const company = (req) => {
    const c = getCompany(ctx, req.params.id);
    if (!c) throw new HttpError(404, 'Empresa não encontrada.');
    return c;
  };

  // Lista simples (para escolher a empresa de um contato).
  api.get('/companies', (req, res) => {
    if (req.user.role !== 'dono') return res.json(ctx.db.prepare('SELECT id, name FROM companies ORDER BY name COLLATE NOCASE').all());
    res.json(listCompanies(ctx));
  });

  api.post('/companies', (req, res) => {
    owner(req);
    res.status(201).json(saveCompany(ctx, req.body || {}));
  });

  api.get('/companies/:id', (req, res) => {
    owner(req);
    const c = company(req);
    const periodo = String(req.query.periodo || 'abertos');
    res.json({ ...c, requesters: requesters(ctx, c.id), statement: statementData(ctx, c, periodo), link: publicLink(ctx, c, periodo) });
  });

  api.patch('/companies/:id', (req, res) => {
    owner(req);
    res.json(saveCompany(ctx, req.body || {}, company(req)));
  });

  api.delete('/companies/:id', (req, res) => {
    owner(req);
    const c = company(req);
    ctx.db.prepare('UPDATE contacts SET company_id = NULL WHERE company_id = ?').run(c.id);
    ctx.db.prepare('DELETE FROM companies WHERE id = ?').run(c.id);
    res.json({ ok: true });
  });

  // Ligar/desligar um contato (solicitante) a uma empresa.
  api.put('/contacts/:id/company', (req, res) => {
    const contact = ctx.data.contacts.get(Number(req.params.id));
    if (!contact) throw new HttpError(404, 'Contato não encontrado.');
    const id = req.body?.company_id ? Number(req.body.company_id) : null;
    if (id && !getCompany(ctx, id)) throw new HttpError(404, 'Empresa não encontrada.');
    ctx.db.prepare('UPDATE contacts SET company_id = ? WHERE id = ?').run(id, contact.id);
    res.json(ctx.data.contacts.get(contact.id));
  });

  api.get('/companies/:id/statement.pdf', async (req, res) => {
    owner(req);
    const c = company(req);
    const periodo = String(req.query.periodo || 'abertos');
    sendPdf(res, await statementPdf(ctx, c, periodo), fileName(c, periodo), req.query.download === '1');
  });
}

// Link para a empresa (sem login): só quem tem o código do link abre.
function publicRoutes(app, ctx) {
  app.get('/extrato/:token.pdf', async (req, res, next) => {
    try {
      const c = ctx.db.prepare('SELECT * FROM companies WHERE token = ?').get(String(req.params.token));
      if (!c) return res.status(404).send('Statement not found.');
      const periodo = /^\d{4}-\d{2}$/.test(String(req.query.mes)) ? String(req.query.mes) : 'abertos';
      sendPdf(res, await statementPdf(ctx, c, periodo), fileName(c, periodo), false);
    } catch (err) {
      next(err);
    }
  });
}

function setup(ctx) {
  ctx.api.empresas = {
    // Empresa do contato (ou null).
    forContact(contactId) {
      return ctx.db.prepare('SELECT co.* FROM contacts c JOIN companies co ON co.id = c.company_id WHERE c.id = ?').get(contactId) || null;
    },
  };
}

function serviceDetail({ ctx, service }) {
  const c = service.contact_id ? ctx.api.empresas.forContact(service.contact_id) : null;
  return { company_id: c?.id ?? null, company_name: c?.name ?? null, company_requires_vin: Boolean(c?.requires_vin) };
}

// Empresa que exige o VIN: não deixa fechar o serviço sem ele.
function blockDone({ ctx, service }) {
  const c = service.contact_id ? ctx.api.empresas.forContact(service.contact_id) : null;
  if (c?.requires_vin && !service.vin) return `🚫 A *${c.name}* exige o VIN. Coloque o VIN antes de fechar o serviço #${service.id}.`;
  return null;
}

// Empresa que sempre pede invoice: cria o invoice ao fechar o serviço.
function afterDone({ ctx, service, user }) {
  const c = service.contact_id ? ctx.api.empresas.forContact(service.contact_id) : null;
  if (!c?.always_invoice || !ctx.api.invoice?.create || ctx.api.invoice.numbersFor(service.id).length) return [];
  try {
    const inv = ctx.api.invoice.create(service, user.id);
    return [`🧾 Invoice nº ${inv.number} criado para a ${c.name}.`];
  } catch (err) {
    ctx.log(`Não consegui criar o invoice do serviço #${service.id}`, err);
    return [`⚠️ Não consegui criar o invoice da ${c.name}: ${err.message}`];
  }
}

// Planilha: coluna Empresa na aba Serviços.
function exportColumns(ctx) {
  return [{ header: 'Empresa', width: 18, value: (s) => (s.contact_id ? ctx.api.empresas.forContact(s.contact_id)?.name || '' : '') }];
}

export default {
  name: 'empresas',
  label: 'Empresas e extrato',
  migrations,
  setup,
  commands,
  routes,
  publicRoutes,
  serviceDetail,
  blockDone,
  afterDone,
  exportColumns,
};
