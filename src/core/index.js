// Núcleo: equipe, contatos (agenda) e serviços. Todos os outros módulos se apoiam nele.
import express from 'express';
import { FlowError } from './bot.js';
import { hashPin, verifyPin, signToken } from '../lib/auth.js';
import { normalizePhone, parseMoney, formatMoney, simplify, HttpError, startOfDayIso, startOfMonthIso, formatPhone } from '../lib/util.js';

const migrations = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     phone TEXT NOT NULL UNIQUE,
     role TEXT NOT NULL CHECK (role IN ('dono', 'motorista')),
     pin_hash TEXT,
     active INTEGER NOT NULL DEFAULT 1,
     active_service_id INTEGER,
     created_at TEXT NOT NULL
   );
   CREATE TABLE contacts (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     phone TEXT UNIQUE,
     email TEXT,
     notes TEXT,
     source TEXT,
     created_at TEXT NOT NULL
   );
   CREATE TABLE services (
     id INTEGER PRIMARY KEY,
     driver_id INTEGER REFERENCES users(id),
     contact_id INTEGER REFERENCES contacts(id),
     pickup TEXT,
     dropoff TEXT,
     vehicle TEXT,
     plate TEXT,
     vin TEXT,
     vin_info TEXT,
     miles REAL,
     price_cents INTEGER,
     notes TEXT,
     status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'concluido', 'cancelado')),
     created_at TEXT NOT NULL,
     completed_at TEXT
   );
   CREATE INDEX services_driver ON services(driver_id, created_at);
   CREATE INDEX services_contact ON services(contact_id);
   CREATE TABLE conversations (
     user_id INTEGER PRIMARY KEY REFERENCES users(id),
     flow TEXT NOT NULL,
     step INTEGER NOT NULL,
     data TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
];

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, phone: u.phone, role: u.role, active: !!u.active };
}

function requireOwner(req) {
  if (req.user.role !== 'dono') throw new HttpError(403, 'Só o dono pode fazer isso.');
}

// O motorista só vê os próprios serviços; o dono vê todos.
function canSee(user, service) {
  return service && (user.role === 'dono' || service.driver_id === user.id);
}

function periodStart(ctx, period) {
  return period === 'mes' ? startOfMonthIso(ctx.config.timeZone) : startOfDayIso(ctx.config.timeZone);
}

// Junta o resumo do núcleo com o que cada módulo acrescenta (pagamentos, despesas...).
function buildSummary(ctx, { since, userId }) {
  const list = ctx.data.services.list({ since, driverId: userId, limit: 10000 }).filter((s) => s.status !== 'cancelado');
  const summary = {
    services: list.length,
    delivered: list.filter((s) => s.status === 'concluido').length,
    billed_cents: list.reduce((sum, s) => sum + (s.price_cents || 0), 0),
    miles: list.reduce((sum, s) => sum + (s.miles || 0), 0),
  };
  for (const mod of ctx.loaded) {
    if (mod.summary) Object.assign(summary, mod.summary({ ctx, since, userId }));
  }
  return summary;
}

function summaryText(ctx, summary, title) {
  const lines = [
    `*${title}*`,
    `Serviços: ${summary.services} (${summary.delivered} entregues)`,
    `Faturado: ${formatMoney(summary.billed_cents)}`,
  ];
  if (summary.miles) lines.push(`Milhas: ${Math.round(summary.miles * 10) / 10}`);
  for (const mod of ctx.loaded) {
    if (mod.summaryLines) lines.push(...mod.summaryLines(summary));
  }
  return lines.join('\n');
}

const flows = {
  novo: {
    steps: [
      {
        key: 'contact_id',
        ask: () => 'Novo serviço 🚛\nQual o *telefone* ou *nome* do cliente?\n(mande *cancelar* a qualquer momento)',
        parse(text, { ctx }) {
          const { contacts } = ctx.data;
          const phone = normalizePhone(text);
          if (phone.length >= 10) {
            return contacts.findOrCreate({ phone, name: text.replace(/[\d\s()+\-.]/g, '').trim() || null, source: 'whatsapp' }).id;
          }
          if (!text) throw new FlowError('Preciso do telefone ou do nome.');
          const found = contacts.search(text, 6);
          if (found.length === 1) return found[0].id;
          const exact = found.find((c) => simplify(c.name) === simplify(text));
          if (exact) return exact.id;
          if (found.length > 1) {
            const names = found.slice(0, 5).map((c) => `• ${c.name} ${formatPhone(c.phone)}`).join('\n');
            throw new FlowError(`Achei mais de um contato:\n${names}\nMande o telefone para eu saber qual é.`);
          }
          return contacts.create({ name: text, source: 'whatsapp' }).id;
        },
      },
      {
        key: 'pickup',
        ask: () => 'Onde vai *pegar* o veículo? (endereço ou referência)',
        parse(text) {
          if (!text) throw new FlowError('Preciso do local de retirada.');
          return text;
        },
      },
      {
        key: 'dropoff',
        optional: true,
        ask: () => 'Para onde vai *levar*? (ou *pular*)',
        parse: (text) => text,
      },
      {
        key: 'vehicle',
        optional: true,
        ask: () => 'Qual o *veículo e a placa*? Ex: Honda Civic ABC1234 (ou *pular*)',
        parse: (text) => text,
      },
      {
        key: 'miles',
        optional: true,
        ask: () => 'Quantas *milhas*? (ou *pular*)',
        parse(text) {
          const miles = Number(String(text).replace(',', '.').replace(/[^\d.]/g, ''));
          if (!Number.isFinite(miles) || miles <= 0) throw new FlowError('Mande só o número de milhas, ex: 12.5');
          return miles;
        },
      },
      {
        key: 'price_cents',
        optional: true,
        ask(data, ctx) {
          const suggestion = suggestPrice(ctx, data.miles);
          return suggestion != null
            ? `Qual o *valor* do serviço? Pela tabela dá ${formatMoney(suggestion)}. Mande *ok* para aceitar, outro valor, ou *pular*.`
            : 'Qual o *valor* do serviço em dólar? (ou *pular*)';
        },
        parse(text, { ctx, data }) {
          const suggestion = suggestPrice(ctx, data.miles);
          if (simplify(text) === 'ok' && suggestion != null) return suggestion;
          const cents = parseMoney(text);
          if (cents == null) throw new FlowError('Não entendi o valor. Ex: 150 ou 150.50');
          return cents;
        },
      },
    ],
    async finish({ ctx, user, data }) {
      const { vehicle, plate } = splitVehicle(data.vehicle);
      const service = ctx.data.services.create({ ...data, vehicle, plate, driver_id: user.id });
      ctx.data.services.setActive(user.id, service.id);
      const hints = ctx.serviceHints.length ? '\n\n' + ctx.serviceHints.join('\n') : '';
      return `✅ Serviço #${service.id} criado.\n\n${ctx.data.services.describe(service)}${hints}\nQuando entregar, mande *entregue*.`;
    },
  },
};

export function suggestPrice(ctx, miles) {
  const { baseCents, perMileCents } = ctx.config.pricing;
  if (!baseCents && !perMileCents) return null;
  if (miles == null && !baseCents) return null;
  return baseCents + Math.round((miles || 0) * perMileCents);
}

// "Honda Civic ABC1234" -> veículo "Honda Civic", placa "ABC1234".
export function splitVehicle(text) {
  if (!text) return { vehicle: null, plate: null };
  const parts = text.trim().split(/\s+/);
  const last = parts[parts.length - 1];
  if (parts.length > 1 && /^[A-Z0-9-]{4,8}$/i.test(last) && /\d/.test(last) && /[A-Z]/i.test(last)) {
    return { vehicle: parts.slice(0, -1).join(' '), plate: last.toUpperCase() };
  }
  return { vehicle: text.trim(), plate: null };
}

const commands = [
  {
    names: ['ajuda', 'menu', 'oi', 'ola', 'help'],
    help: '*ajuda* – mostra esta lista',
    run: ({ ctx }) => ['*Comandos*', ...ctx.commands.map((c) => c.help).filter(Boolean)].join('\n'),
  },
  {
    names: ['novo', 'nova', 'chamado'],
    help: '*novo* – registrar um serviço',
    run: ({ ctx, user }) => ctx.bot.startFlow(user, 'novo'),
  },
  {
    names: ['atual', 'servico', 'serviço'],
    help: '*atual* – ver o serviço em andamento',
    run({ ctx, user }) {
      const service = ctx.data.services.active(user);
      return service ? ctx.data.services.describe(service) : 'Nenhum serviço em andamento. Mande *novo* para começar.';
    },
  },
  {
    names: ['entregue', 'fim', 'concluido', 'finalizar'],
    help: '*entregue* – finalizar o serviço em andamento',
    run({ ctx, user }) {
      const service = ctx.data.services.active(user);
      if (!service) return 'Nenhum serviço em andamento.';
      ctx.data.services.update(service.id, { status: 'concluido' });
      ctx.data.services.setActive(user.id, null);
      const pending = ctx.loaded.flatMap((m) => m.onServiceDone?.({ ctx, service }) || []);
      return [`🏁 Serviço #${service.id} entregue.`, ...pending].join('\n');
    },
  },
  {
    names: ['abrir', 'voltar'],
    help: '*abrir 12* – voltar a mexer no serviço #12',
    run({ ctx, user, args }) {
      const id = Number(String(args[0] || '').replace('#', ''));
      const service = id && ctx.data.services.get(id);
      if (!canSee(user, service)) return 'Não achei esse serviço.';
      if (service.status !== 'aberto') ctx.data.services.update(service.id, { status: 'aberto' });
      ctx.data.services.setActive(user.id, service.id);
      return `Ok, agora estou no serviço #${service.id}.`;
    },
  },
  {
    names: ['resumo'],
    help: '*resumo* ou *resumo mes* – números do dia ou do mês',
    run({ ctx, user, args }) {
      const period = simplify(args[0]) === 'mes' ? 'mes' : 'dia';
      const userId = user.role === 'dono' ? null : user.id;
      const summary = buildSummary(ctx, { since: periodStart(ctx, period), userId });
      const who = user.role === 'dono' ? 'empresa' : user.name;
      return summaryText(ctx, summary, `Resumo ${period === 'mes' ? 'do mês' : 'de hoje'} (${who})`);
    },
  },
];

function routes(api, ctx) {
  const { data, db } = ctx;

  api.get('/me', (req, res) => {
    res.json({
      user: publicUser(req.user),
      company: ctx.config.companyName,
      modules: ctx.loaded.map((m) => ({ name: m.name, label: m.label })),
      pricing: ctx.config.pricing,
    });
  });

  // Equipe
  api.get('/users', (req, res) => {
    requireOwner(req);
    res.json(data.users.list().map(publicUser));
  });
  api.post('/users', (req, res) => {
    requireOwner(req);
    const { name, phone, pin, role = 'motorista' } = req.body || {};
    const p = normalizePhone(phone);
    if (!name || p.length < 10) throw new HttpError(400, 'Informe nome e telefone com DDD.');
    if (pin && String(pin).length < 4) throw new HttpError(400, 'O PIN precisa ter pelo menos 4 números.');
    if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(p)) throw new HttpError(409, 'Esse telefone já está na equipe.');
    const info = db
      .prepare('INSERT INTO users (name, phone, role, pin_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, p, role === 'dono' ? 'dono' : 'motorista', pin ? hashPin(pin) : null, new Date().toISOString());
    res.status(201).json(publicUser(data.users.get(Number(info.lastInsertRowid))));
  });
  api.patch('/users/:id', (req, res) => {
    requireOwner(req);
    const user = data.users.get(Number(req.params.id));
    if (!user) throw new HttpError(404, 'Pessoa não encontrada.');
    const { name, phone, pin, active } = req.body || {};
    if (user.id === req.user.id && active === false) throw new HttpError(400, 'Você não pode desativar a si mesmo.');
    db.prepare('UPDATE users SET name = ?, phone = ?, active = ? WHERE id = ?').run(
      name ?? user.name,
      phone ? normalizePhone(phone) : user.phone,
      active === undefined ? user.active : active ? 1 : 0,
      user.id
    );
    if (pin) db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hashPin(pin), user.id);
    res.json(publicUser(data.users.get(user.id)));
  });

  // Contatos
  api.get('/contacts', (req, res) => res.json(data.contacts.search(req.query.q || '', 500)));
  api.post('/contacts', (req, res) => {
    const { name, phone, email, notes } = req.body || {};
    if (!name && !phone) throw new HttpError(400, 'Informe nome ou telefone.');
    if (phone && data.contacts.byPhone(phone)) throw new HttpError(409, 'Já existe um contato com esse telefone.');
    res.status(201).json(data.contacts.create({ name, phone, email, notes }));
  });
  api.get('/contacts/:id', (req, res) => {
    const contact = data.contacts.get(Number(req.params.id));
    if (!contact) throw new HttpError(404, 'Contato não encontrado.');
    const services = data.services.list({ contactId: contact.id }).filter((s) => canSee(req.user, s));
    res.json({ ...contact, services });
  });
  api.patch('/contacts/:id', (req, res) => {
    const contact = data.contacts.update(Number(req.params.id), req.body || {});
    if (!contact) throw new HttpError(404, 'Contato não encontrado.');
    res.json(contact);
  });
  api.post('/contacts/import', express.text({ type: '*/*', limit: '20mb' }), (req, res) => {
    requireOwner(req);
    if (!req.body || !String(req.body).includes('BEGIN:VCARD')) throw new HttpError(400, 'Mande um arquivo de contatos .vcf.');
    res.json(data.contacts.importVcf(req.body));
  });

  // Serviços
  api.get('/services', (req, res) => {
    const driverId = req.user.role === 'dono' ? Number(req.query.driver) || null : req.user.id;
    res.json(data.services.list({ status: req.query.status || null, driverId, limit: Number(req.query.limit) || 100 }));
  });
  api.post('/services', (req, res) => {
    const body = req.body || {};
    let contactId = body.contact_id || null;
    if (!contactId && (body.contact_phone || body.contact_name)) {
      contactId = (body.contact_phone
        ? data.contacts.findOrCreate({ phone: body.contact_phone, name: body.contact_name })
        : data.contacts.create({ name: body.contact_name })
      ).id;
    }
    const driverId = req.user.role === 'dono' ? body.driver_id || req.user.id : req.user.id;
    const service = data.services.create({
      ...body,
      contact_id: contactId,
      driver_id: driverId,
      price_cents: body.price != null && body.price !== '' ? parseMoney(body.price) : null,
      miles: body.miles ? Number(body.miles) : null,
    });
    data.services.setActive(driverId, service.id);
    res.status(201).json(service);
  });
  api.get('/services/:id', (req, res) => {
    const service = data.services.get(Number(req.params.id));
    if (!canSee(req.user, service)) throw new HttpError(404, 'Serviço não encontrado.');
    const extras = {};
    for (const mod of ctx.loaded) {
      if (mod.serviceDetail) Object.assign(extras, mod.serviceDetail({ ctx, service }));
    }
    res.json({ ...service, vin_info: service.vin_info ? JSON.parse(service.vin_info) : null, ...extras });
  });
  api.patch('/services/:id', (req, res) => {
    const service = data.services.get(Number(req.params.id));
    if (!canSee(req.user, service)) throw new HttpError(404, 'Serviço não encontrado.');
    const body = { ...(req.body || {}) };
    if (body.price !== undefined) body.price_cents = body.price === '' || body.price == null ? null : parseMoney(body.price);
    if (req.user.role !== 'dono') delete body.driver_id;
    const updated = data.services.update(service.id, body);
    if (body.status && body.status !== 'aberto') {
      db.prepare('UPDATE users SET active_service_id = NULL WHERE active_service_id = ?').run(service.id);
    }
    res.json(updated);
  });

  api.get('/summary', (req, res) => {
    const period = req.query.period === 'mes' ? 'mes' : 'dia';
    const userId = req.user.role === 'dono' ? Number(req.query.driver) || null : req.user.id;
    res.json({ period, ...buildSummary(ctx, { since: periodStart(ctx, period), userId }) });
  });

  // Simulador: conversa com o robô pelo painel, sem precisar do WhatsApp.
  api.post('/bot/simulate', async (req, res) => {
    const replies = await ctx.bot.handle({ phone: req.user.phone, text: String(req.body?.text || '') });
    res.json({ replies });
  });
}

// Rotas sem login: primeiro acesso e login.
function publicRoutes(app, ctx) {
  const { db, data, config } = ctx;
  const cookie = (token) =>
    `sess=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${config.secureCookies ? '; Secure' : ''}`;

  app.get('/api/setup', (req, res) => res.json({ needsSetup: data.users.count() === 0, company: config.companyName }));

  app.post('/api/setup', (req, res) => {
    if (data.users.count() > 0) throw new HttpError(409, 'O sistema já foi configurado.');
    const { name, phone, pin } = req.body || {};
    const p = normalizePhone(phone);
    if (!name || p.length < 10 || !pin || String(pin).length < 4) {
      throw new HttpError(400, 'Informe nome, telefone com DDD e um PIN de pelo menos 4 números.');
    }
    const info = db
      .prepare("INSERT INTO users (name, phone, role, pin_hash, created_at) VALUES (?, ?, 'dono', ?, ?)")
      .run(name, p, hashPin(pin), new Date().toISOString());
    res.setHeader('Set-Cookie', cookie(signToken(Number(info.lastInsertRowid), config.secret)));
    res.status(201).json({ ok: true });
  });

  app.post('/api/login', (req, res) => {
    const { phone, pin } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE phone = ? AND active = 1').get(normalizePhone(phone));
    if (!user || !verifyPin(pin, user.pin_hash)) throw new HttpError(401, 'Telefone ou PIN errado.');
    res.setHeader('Set-Cookie', cookie(signToken(user.id, config.secret)));
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'sess=; Path=/; Max-Age=0');
    res.json({ ok: true });
  });
}

export default {
  name: 'core',
  label: 'Serviços',
  migrations,
  commands,
  flows,
  routes,
  publicRoutes,
};
