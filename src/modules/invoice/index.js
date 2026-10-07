// Módulo invoice: fatura/recibo em PDF para o cliente (em inglês), com numeração própria,
// logo e dados da empresa. Se o serviço já foi pago, sai com "PAID".
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { parseMoney, nowIso, HttpError } from '../../lib/util.js';
import { renderInvoice } from './pdf.js';

const BUNDLED_LOGO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'logo.jpg');

// Dados do modelo que o Caningado mandou (invoice 4098). O dono muda no painel.
export const DEFAULT_COMPANY = {
  name: 'Towing J&J LLC',
  address: '429 Terrace Dr\nOviedo, FL 32765\nUnited States',
  contact: 'Jean',
  phone: '(321) 295-6778',
  email: 'towing.jj.llc@gmail.com',
  zelle: '(321) 295-6778',
  zelleName: 'Towing J&J LLC',
  itemName: 'Towing Services',
  dueDays: 0,
  nextNumber: 4099,
};

const migrations = [
  `CREATE TABLE invoices (
     id INTEGER PRIMARY KEY,
     number INTEGER NOT NULL UNIQUE,
     service_id INTEGER REFERENCES services(id),
     bill_to TEXT,
     items TEXT NOT NULL,
     total_cents INTEGER NOT NULL,
     issue_date TEXT NOT NULL,
     due_date TEXT NOT NULL,
     notes TEXT,
     token TEXT NOT NULL UNIQUE,
     created_by INTEGER REFERENCES users(id),
     created_at TEXT NOT NULL,
     updated_at TEXT
   );
   CREATE INDEX invoices_service ON invoices(service_id);`,
];

function getSetting(ctx, key) {
  const row = ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(ctx, key, value) {
  ctx.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function getCompany(ctx) {
  let saved = {};
  try {
    saved = JSON.parse(getSetting(ctx, 'company') || '{}');
  } catch {}
  return { ...DEFAULT_COMPANY, ...saved };
}

function logoFile(ctx) {
  for (const ext of ['png', 'jpg']) {
    const file = path.join(ctx.config.dataDir, `logo-empresa.${ext}`);
    if (fs.existsSync(file)) return file;
  }
  return BUNDLED_LOGO;
}

// Dia de hoje no fuso da empresa: "2026-10-06".
function today(ctx, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ctx.config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
}
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// "1996 Ford F350": usa o que o VIN descobriu; senão o que foi digitado.
function vehicleName(service) {
  let info = service.vin_info;
  if (typeof info === 'string') {
    try {
      info = JSON.parse(info);
    } catch {
      info = null;
    }
  }
  const fromVin = info ? [info.year, info.make, info.model].filter(Boolean).join(' ') : '';
  return fromVin || service.vehicle || '';
}

function serviceDetails(ctx, service) {
  const day = today(ctx, new Date(service.completed_at || service.created_at));
  const [y, m, d] = day.split('-');
  const parts = [`${m}/${d}/${y.slice(2)}`, vehicleName(service), service.vin ? `VIN: ${service.vin}` : '', service.plate ? `Plate: ${service.plate}` : ''];
  return parts.filter(Boolean).join(' - ');
}

// Rascunho do invoice de um serviço (o que o formulário mostra preenchido).
export function draftFor(ctx, service) {
  const company = getCompany(ctx);
  const contact = service.contact_id ? ctx.data.contacts.get(service.contact_id) : null;
  const previous = contact
    ? ctx.db
        .prepare('SELECT i.bill_to FROM invoices i JOIN services s ON s.id = i.service_id WHERE s.contact_id = ? ORDER BY i.id DESC LIMIT 1')
        .get(contact.id)
    : null;
  const issue = today(ctx);
  return {
    number: nextNumber(ctx),
    bill_to: previous?.bill_to || contact?.name || '',
    issue_date: issue,
    due_date: addDays(issue, company.dueDays),
    items: [{ description: company.itemName, details: serviceDetails(ctx, service), qty: 1, unit_cents: service.price_cents || 0 }],
    notes: '',
  };
}

function nextNumber(ctx) {
  const max = ctx.db.prepare('SELECT MAX(number) AS n FROM invoices').get().n || 0;
  return Math.max(Number(getCompany(ctx).nextNumber) || 1, max + 1);
}

function cleanItems(items) {
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'Coloque pelo menos um item.');
  if (items.length > 30) throw new HttpError(400, 'Itens demais.');
  return items.map((it) => {
    const description = String(it.description || '').trim().slice(0, 120);
    if (!description) throw new HttpError(400, 'Todo item precisa de descrição.');
    const qty = Number(String(it.qty ?? 1).replace(',', '.'));
    if (!(qty > 0 && qty <= 10000)) throw new HttpError(400, `Quantidade inválida em "${description}".`);
    const unit = it.unit_cents != null ? Number(it.unit_cents) : parseMoney(String(it.unit ?? ''));
    if (!Number.isInteger(unit) || unit < 0 || unit > 10_000_000) throw new HttpError(400, `Preço inválido em "${description}".`);
    return { description, details: String(it.details || '').trim().slice(0, 300), qty, unit_cents: unit };
  });
}

function saveInvoice(ctx, { service, body, userId, existing = null }) {
  const draft = draftFor(ctx, service);
  const items = body.items ? cleanItems(body.items) : draft.items;
  const total = items.reduce((s, it) => s + Math.round(it.qty * it.unit_cents), 0);
  const issue = isDay(body.issue_date) ? body.issue_date : existing?.issue_date || draft.issue_date;
  const due = isDay(body.due_date) ? body.due_date : existing?.due_date || draft.due_date;
  if (due < issue) throw new HttpError(400, 'O vencimento não pode ser antes da data do invoice.');
  const billTo = String(body.bill_to ?? existing?.bill_to ?? draft.bill_to).trim().slice(0, 400);
  const notes = String(body.notes ?? existing?.notes ?? '').trim().slice(0, 1000);
  if (existing) {
    ctx.db
      .prepare('UPDATE invoices SET bill_to = ?, items = ?, total_cents = ?, issue_date = ?, due_date = ?, notes = ?, updated_at = ? WHERE id = ?')
      .run(billTo, JSON.stringify(items), total, issue, due, notes, nowIso(), existing.id);
    return getInvoice(ctx, existing.id);
  }
  let number = body.number != null && body.number !== '' ? Number(body.number) : draft.number;
  if (!Number.isInteger(number) || number < 1) throw new HttpError(400, 'Número do invoice inválido.');
  if (ctx.db.prepare('SELECT 1 FROM invoices WHERE number = ?').get(number)) throw new HttpError(400, `O invoice ${number} já existe.`);
  const info = ctx.db
    .prepare(
      `INSERT INTO invoices (number, service_id, bill_to, items, total_cents, issue_date, due_date, notes, token, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(number, service.id, billTo, JSON.stringify(items), total, issue, due, notes, crypto.randomBytes(16).toString('base64url'), userId, nowIso());
  // Próximo número continua depois deste.
  const company = getCompany(ctx);
  if (number >= company.nextNumber) setSetting(ctx, 'company', JSON.stringify({ ...company, nextNumber: number + 1 }));
  return getInvoice(ctx, Number(info.lastInsertRowid));
}

function getInvoice(ctx, id) {
  const row = ctx.db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  return row && { ...row, items: JSON.parse(row.items) };
}

function paidFor(ctx, invoice) {
  const service = invoice.service_id && ctx.data.services.get(invoice.service_id);
  if (!service || !ctx.api.pagamentos) return 0;
  return ctx.api.pagamentos.balance(service).received_cents;
}

export async function invoicePdf(ctx, invoice) {
  const service = invoice.service_id ? ctx.data.services.get(invoice.service_id) : null;
  return renderInvoice({
    company: getCompany(ctx),
    logo: fs.readFileSync(logoFile(ctx)),
    invoice,
    service: service && { ...service, vehicle: vehicleName(service) },
    paid_cents: paidFor(ctx, invoice),
  });
}

const fileName = (ctx, invoice) => `Invoice ${invoice.number} - ${getCompany(ctx).name}.pdf`.replace(/[^\w &.-]/g, '');

function sendPdf(res, buf, name, download) {
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${name}"`);
  res.set('Cache-Control', 'no-store');
  res.send(buf);
}

// Endereço do sistema na internet, para mandar o link pelo WhatsApp.
function publicBase(ctx) {
  const env = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  return (env || getSetting(ctx, 'public_url') || '').replace(/\/$/, '');
}
const publicLink = (ctx, invoice) => {
  const base = publicBase(ctx);
  return base ? `${base}/invoice/${invoice.token}.pdf` : null;
};

function canSee(user, service) {
  return service && (user.role === 'dono' || service.driver_id === user.id);
}

const commands = [
  {
    names: ['invoice', 'recibo', 'fatura', 'nota'],
    help: '*invoice* – invoice/recibo em PDF do serviço para mandar ao cliente',
    run({ ctx, user }) {
      const service = ctx.data.services.active(user);
      if (!service) return 'Nenhum serviço em andamento. Mande *abrir 12* para escolher o serviço.';
      if (!service.price_cents) return 'Esse serviço ainda não tem valor. Coloque o valor no painel antes do invoice.';
      const existing = ctx.db.prepare('SELECT id FROM invoices WHERE service_id = ? ORDER BY id DESC LIMIT 1').get(service.id);
      const invoice = existing ? getInvoice(ctx, existing.id) : saveInvoice(ctx, { service, body: {}, userId: user.id });
      const link = publicLink(ctx, invoice);
      const head = `🧾 Invoice ${invoice.number} do serviço #${service.id}${existing ? ' (já existia)' : ''}.`;
      if (!link) return `${head}\nAbra o serviço no painel e toque em *Invoice* para baixar ou mandar o PDF.`;
      return [head + '\nEncaminhe a mensagem abaixo para o cliente:', `Hi! Here is your invoice #${invoice.number} from ${getCompany(ctx).name}: ${link}\nThank you!`];
    },
  },
];

function routes(api, ctx) {
  // Guarda o endereço do painel para o robô montar o link do PDF.
  api.use((req, res, next) => {
    const proto = req.get('x-forwarded-proto')?.split(',')[0].trim() || req.protocol;
    const host = req.get('host');
    if (host && !/^(localhost|127\.|\[::1\])/.test(host)) {
      const url = `${proto}://${host}`;
      if (getSetting(ctx, 'public_url') !== url) setSetting(ctx, 'public_url', url);
    }
    next();
  });

  api.get('/company', (req, res) => {
    res.json({ ...getCompany(ctx), next_number: nextNumber(ctx), custom_logo: logoFile(ctx) !== BUNDLED_LOGO });
  });

  api.put('/company', (req, res) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o dono muda os dados da empresa.');
    const body = req.body || {};
    const current = getCompany(ctx);
    const next = { ...current };
    for (const key of ['name', 'address', 'contact', 'phone', 'email', 'zelle', 'zelleName', 'itemName']) {
      if (body[key] !== undefined) next[key] = String(body[key]).trim().slice(0, 300);
    }
    if (!next.name) throw new HttpError(400, 'O nome da empresa não pode ficar vazio.');
    if (body.dueDays !== undefined) {
      const n = Number(body.dueDays);
      if (!Number.isInteger(n) || n < 0 || n > 120) throw new HttpError(400, 'Prazo de pagamento inválido.');
      next.dueDays = n;
    }
    if (body.nextNumber !== undefined && body.nextNumber !== '') {
      const n = Number(body.nextNumber);
      if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Número inválido.');
      const max = ctx.db.prepare('SELECT MAX(number) AS n FROM invoices').get().n || 0;
      if (n <= max) throw new HttpError(400, `Já existe o invoice ${max}. O próximo tem que ser maior.`);
      next.nextNumber = n;
    }
    setSetting(ctx, 'company', JSON.stringify(next));
    res.json({ ...next, next_number: nextNumber(ctx) });
  });

  api.get('/company/logo', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(logoFile(ctx));
  });

  api.post('/company/logo', express.raw({ type: 'image/*', limit: '5mb' }), (req, res) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o dono muda o logo.');
    const buf = req.body;
    const isPng = Buffer.isBuffer(buf) && buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const isJpg = Buffer.isBuffer(buf) && buf[0] === 0xff && buf[1] === 0xd8;
    if (!isPng && !isJpg) throw new HttpError(400, 'Mande o logo em JPG ou PNG.');
    for (const ext of ['png', 'jpg']) fs.rmSync(path.join(ctx.config.dataDir, `logo-empresa.${ext}`), { force: true });
    fs.writeFileSync(path.join(ctx.config.dataDir, `logo-empresa.${isPng ? 'png' : 'jpg'}`), buf);
    res.status(201).json({ ok: true });
  });

  api.get('/services/:id/invoices', (req, res) => {
    const service = ctx.data.services.get(Number(req.params.id));
    if (!canSee(req.user, service)) throw new HttpError(404, 'Serviço não encontrado.');
    const list = ctx.db.prepare('SELECT id FROM invoices WHERE service_id = ? ORDER BY id DESC').all(service.id).map((r) => getInvoice(ctx, r.id));
    res.json({ draft: draftFor(ctx, service), invoices: list.map((i) => ({ ...i, link: publicLink(ctx, i) })) });
  });

  api.post('/services/:id/invoices', (req, res) => {
    const service = ctx.data.services.get(Number(req.params.id));
    if (!canSee(req.user, service)) throw new HttpError(404, 'Serviço não encontrado.');
    const invoice = saveInvoice(ctx, { service, body: req.body || {}, userId: req.user.id });
    res.status(201).json({ ...invoice, link: publicLink(ctx, invoice) });
  });

  const owned = (req) => {
    const invoice = getInvoice(ctx, Number(req.params.id));
    const service = invoice?.service_id ? ctx.data.services.get(invoice.service_id) : null;
    if (!invoice || !(req.user.role === 'dono' || canSee(req.user, service))) throw new HttpError(404, 'Invoice não encontrado.');
    return { invoice, service };
  };

  api.put('/invoices/:id', (req, res) => {
    const { invoice, service } = owned(req);
    const saved = saveInvoice(ctx, { service, body: req.body || {}, userId: req.user.id, existing: invoice });
    res.json({ ...saved, link: publicLink(ctx, saved) });
  });

  api.delete('/invoices/:id', (req, res) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o dono pode apagar invoices.');
    ctx.db.prepare('DELETE FROM invoices WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  api.get('/invoices/:id/pdf', async (req, res) => {
    const { invoice } = owned(req);
    sendPdf(res, await invoicePdf(ctx, invoice), fileName(ctx, invoice), req.query.download === '1');
  });
}

// Link para o cliente (sem login): só quem tem o código do link abre.
function publicRoutes(app, ctx) {
  app.get('/invoice/:token.pdf', async (req, res, next) => {
    try {
      const row = ctx.db.prepare('SELECT id FROM invoices WHERE token = ?').get(String(req.params.token));
      if (!row) return res.status(404).send('Invoice not found.');
      const invoice = getInvoice(ctx, row.id);
      sendPdf(res, await invoicePdf(ctx, invoice), fileName(ctx, invoice), false);
    } catch (err) {
      next(err);
    }
  });
}

function serviceDetail({ ctx, service }) {
  const row = ctx.db.prepare('SELECT number FROM invoices WHERE service_id = ? ORDER BY id DESC LIMIT 1').get(service.id);
  return { invoice_number: row?.number ?? null };
}

// Planilha: coluna com o número do invoice na aba Serviços.
function exportColumns(ctx) {
  const q = ctx.db.prepare('SELECT GROUP_CONCAT(number, \', \') AS n FROM invoices WHERE service_id = ?');
  return [{ header: 'Invoice nº', width: 11, value: (service) => q.get(service.id).n || '' }];
}

export default {
  name: 'invoice',
  label: 'Invoice / recibo',
  migrations,
  commands,
  routes,
  publicRoutes,
  serviceDetail,
  exportColumns,
};
