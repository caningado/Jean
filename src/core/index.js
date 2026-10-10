// Núcleo: equipe, contatos (agenda) e serviços. Todos os outros módulos se apoiam nele.
import express from 'express';
import { FlowError } from './bot.js';
import { hashPin, verifyPin, signToken } from '../lib/auth.js';
import { collectAlerts, servicesBlocked } from '../lib/daily.js';
import { checkName, checkPhone, checkLocation, checkVehicle, checkPlate, checkMiles, checkMoney, isMapReference } from '../lib/validate.js';
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
  // Valores soltos do sistema (ex.: dia do último aviso da manhã).
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`,
  // Status "pendente": serviço na fila, sem motorista trabalhando nele ainda.
  // O SQLite não muda um CHECK com ALTER TABLE; só acrescentar um valor permitido
  // não mexe nos dados gravados, então dá para trocar o texto da tabela direto.
  (db) => {
    const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'services'").get();
    if (row.sql.includes("'pendente'")) return;
    const OLD = "CHECK (status IN ('aberto', 'concluido', 'cancelado'))";
    if (!row.sql.includes(OLD)) throw new Error('Tabela de serviços diferente do esperado.');
    const version = db.prepare('PRAGMA schema_version').get().schema_version;
    db.exec('PRAGMA writable_schema = ON');
    try {
      db.prepare("UPDATE sqlite_schema SET sql = ? WHERE type = 'table' AND name = 'services'").run(
        row.sql.replace(OLD, "CHECK (status IN ('pendente', 'aberto', 'concluido', 'cancelado'))")
      );
      db.exec(`PRAGMA schema_version = ${version + 1}`);
    } finally {
      db.exec('PRAGMA writable_schema = OFF');
    }
  },
];

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, phone: u.phone, role: u.role, active: !!u.active };
}

function requireOwner(req) {
  if (req.user.role !== 'dono') throw new HttpError(403, 'Só o dono pode fazer isso.');
}

// O motorista só vê os próprios serviços; o dono vê todos (inclusive a fila).
function canSee(user, service) {
  return service && (user.role === 'dono' || service.driver_id === user.id);
}

// Algum módulo impede fechar o serviço? (ex.: empresa que exige o VIN)
function blockDone(ctx, service) {
  for (const mod of ctx.loaded) {
    const msg = mod.blockDone?.({ ctx, service });
    if (msg) return msg;
  }
  return null;
}

// Tira um serviço da fila: o dono passa para um motorista e fica "em andamento".
function takeService(ctx, service, driverId) {
  const updated = ctx.data.services.update(service.id, { status: 'aberto', driver_id: driverId });
  // Vira o serviço "em mãos" do motorista, se ele não está com outro.
  const current = ctx.data.services.active({ id: driverId });
  if (!current) ctx.data.services.setActive(driverId, service.id);
  return updated;
}

// Avisa o motorista que o dono passou um serviço da fila para ele (se o WhatsApp estiver ligado).
async function notifyAssigned(ctx, service, byUser) {
  if (!ctx.send || service.driver_id === byUser.id) return;
  const driver = ctx.data.users.get(service.driver_id);
  if (!driver) return;
  try {
    await ctx.send(driver.phone, [`🚚 ${byUser.name} passou um serviço para você.`, ctx.data.services.describe(service)].join('\n\n'));
  } catch (err) {
    ctx.log(`Não consegui avisar ${driver.name} do serviço #${service.id}`, err);
  }
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

// Palavras que são comandos: se o motorista mandar uma delas no meio do cadastro,
// o robô avisa em vez de salvar "ajuda" como endereço, por exemplo.
function rejectCommand(ctx, text) {
  const word = simplify(text).split(/\s+/)[0];
  if (word && ctx.commands.some((c) => c.names.includes(word))) {
    throw new FlowError('Você está no meio do cadastro de um serviço. Responda a pergunta, ou mande *cancelar*.');
  }
}

// Procura o endereço digitado no mapa. Link de mapa e localização 📍 já são exatos.
// Se o serviço de mapa estiver fora do ar, aceita como foi digitado.
async function resolvePlace(ctx, location) {
  if (!ctx.geo || isMapReference(location)) return { value: location };
  const found = await ctx.geo.lookup(location);
  if (found.status === 'erro') return { value: location };
  if (found.matches.length === 1) return { value: found.matches[0].label, notice: `📍 Achei no mapa: *${found.matches[0].label}*` };
  return { check: { query: location, options: found.matches.map((m) => m.label) } };
}

// Dois passos para um local (retirada ou destino): o local e, se precisar, a escolha
// entre os endereços achados no mapa (ou o aviso de que não achou).
function placeSteps(key, what, askText, { optional = false } = {}) {
  const checkKey = `${key}_check`;
  const resolve = async (ctx, data, text) => {
    rejectCommand(ctx, text);
    const place = await resolvePlace(ctx, checkLocation(text, what));
    if (place.check) return place.check;
    data[key] = place.value;
    if (place.notice) data._notice = place.notice;
    return null;
  };
  return [
    {
      key,
      optional,
      ask: () => askText,
      async parse(text, { ctx, data }) {
        data[checkKey] = await resolve(ctx, data, text);
        return data[key] ?? null;
      },
    },
    {
      key: checkKey,
      skip: (data) => !data[checkKey],
      again: (data) => Boolean(data[checkKey]),
      ask(data) {
        const { query, options } = data[checkKey];
        if (!options.length) {
          return (
            `⚠️ Não achei "${query}" no mapa.\n` +
            'Confira o número, a rua e a cidade e mande de novo, cole o link do mapa ou envie a localização 📍.\n' +
            'Se estiver certo assim, mande *0* para usar como digitei.'
          );
        }
        const lines = options.map((label, i) => `*${i + 1}* ${label}`);
        return `Achei mais de um endereço para "${query}". Qual é?\n${lines.join('\n')}\n*0* usar como digitei\nOu digite o endereço de novo.`;
      },
      async parse(text, { ctx, data }) {
        const { query, options } = data[checkKey];
        const answer = text.trim();
        if (/^\d{1,2}$/.test(answer) && Number(answer) <= options.length) {
          const n = Number(answer);
          data[key] = n === 0 ? query : options[n - 1];
          return null;
        }
        return resolve(ctx, data, text);
      },
    },
  ];
}

// Mostra o cliente escolhido (já existente ou novo) enquanto o serviço não foi salvo.
function draftClient(ctx, data) {
  const c = data.client || {};
  if (c.id) {
    const contact = ctx.data.contacts.get(c.id);
    return `${contact.name}${contact.phone ? ' ' + formatPhone(contact.phone) : ''}`;
  }
  return [c.name, c.phone ? formatPhone(c.phone) : null].filter(Boolean).join(' ') + ' (novo)';
}

function draftSummary(ctx, data) {
  const { vehicle, plate } = splitVehicle(data.vehicle);
  const lines = [`Cliente: ${draftClient(ctx, data)}`, `Retirada: ${data.pickup}`];
  if (data.dropoff) lines.push(`Destino: ${data.dropoff}`);
  if (vehicle) lines.push(`Veículo: ${[vehicle, plate].filter(Boolean).join(' · ')}`);
  if (data.miles != null) lines.push(`Milhas: ${data.miles}`);
  if (data.price_cents != null) lines.push(`Valor: ${formatMoney(data.price_cents)}`);
  return lines.join('\n');
}

const flows = {
  novo: {
    steps: [
      {
        key: 'client',
        ask: () => 'Novo serviço 🚛\nQual o *telefone* ou o *nome* do cliente?\n(mande *cancelar* a qualquer momento)',
        parse(text, { ctx }) {
          rejectCommand(ctx, text);
          const { contacts } = ctx.data;
          const digits = text.replace(/\D/g, '');
          // Tem número: precisa ser um telefone completo.
          if (digits.length >= 3) {
            const phone = checkPhone(text);
            const existing = contacts.byPhone(phone);
            if (existing) return { id: existing.id };
            const rest = text.replace(/[\d()+\-.]/g, ' ').trim();
            return { phone, name: rest ? checkName(rest, 'O nome do cliente') : null };
          }
          const name = checkName(text, 'O nome do cliente');
          // Apelido de empresa (ex.: "ss" = Super Speed): quem pede por ela.
          const co = ctx.has('empresas') && ctx.db.prepare('SELECT * FROM companies').all().find((c) => c.nickname && simplify(c.nickname) === simplify(name));
          if (co) {
            const people = ctx.db.prepare('SELECT id FROM contacts WHERE company_id = ? ORDER BY name COLLATE NOCASE').all(co.id);
            if (people.length === 1) return { id: people[0].id };
            if (people.length > 1) return { name: co.name, candidates: people.map((c) => c.id).slice(0, 9) };
            const contact = contacts.create({ name: co.name });
            ctx.db.prepare('UPDATE contacts SET company_id = ? WHERE id = ?').run(co.id, contact.id);
            return { id: contact.id };
          }
          const found = contacts.search(name, 9);
          const exact = found.filter((c) => simplify(c.name) === simplify(name));
          if (exact.length === 1) return { id: exact[0].id };
          if (found.length === 1) return { id: found[0].id };
          // Mais de um cliente com esse nome (ex.: duas Marias): pergunta qual.
          if (found.length > 1) return { name, candidates: found.map((c) => c.id) };
          return { name };
        },
      },
      {
        key: 'client_pick',
        skip: (data) => !data.client.candidates,
        ask(data, ctx) {
          const lines = data.client.candidates.map((id, i) => {
            const c = ctx.data.contacts.get(id);
            return `*${i + 1}* ${c.name}${c.phone ? ' ' + formatPhone(c.phone) : ''}`;
          });
          return `Achei mais de um cliente com esse nome. Qual é?\n${lines.join('\n')}\n*0* outro cliente (novo)`;
        },
        parse(text, { data }) {
          const n = Number(text.trim());
          const list = data.client.candidates;
          if (!Number.isInteger(n) || n < 0 || n > list.length) throw new FlowError(`Responda com um número de 0 a ${list.length}.`);
          data.client = n === 0 ? { name: data.client.name } : { id: list[n - 1] };
          return n;
        },
      },
      {
        key: 'client_name',
        // Cliente novo que veio só com telefone: pergunta o nome.
        skip: (data) => Boolean(data.client.id || data.client.name),
        ask: (data) => `Cliente novo (${formatPhone(data.client.phone)}). Qual o *nome* dele?`,
        parse(text, { ctx, data }) {
          rejectCommand(ctx, text);
          data.client.name = checkName(text, 'O nome do cliente');
          return data.client.name;
        },
      },
      {
        key: 'client_phone',
        optional: true,
        // Cliente novo que veio só com nome: pergunta o telefone.
        skip: (data) => Boolean(data.client.id || data.client.phone),
        ask: (data) => `Cliente novo: *${data.client.name}*. Qual o *telefone* dele? (ou *pular*)`,
        parse(text, { ctx, data }) {
          const phone = checkPhone(text);
          const other = ctx.data.contacts.byPhone(phone);
          if (other) throw new FlowError(`Esse telefone já é do cliente ${other.name}. Mande outro, ou *pular*.`);
          data.client.phone = phone;
          return phone;
        },
      },
      ...placeSteps('pickup', 'O local de retirada', 'Onde vai *pegar* o veículo? Mande o endereço, cole o link do mapa ou envie a localização 📍'),
      ...placeSteps('dropoff', 'O destino', 'Para onde vai *levar*? Mande o endereço, cole o link do mapa ou envie a localização 📍 (ou *pular*)', {
        optional: true,
      }),
      {
        key: 'vehicle',
        optional: true,
        ask: () => 'Qual o *veículo e a placa*? Ex: Honda Civic ABC1234 (ou *pular*)',
        parse(text, { ctx }) {
          rejectCommand(ctx, text);
          return checkVehicle(text);
        },
      },
      {
        key: 'miles',
        optional: true,
        ask: () => 'Quantas *milhas*? (ou *pular*)',
        parse: (text) => checkMiles(text.replace(/mi(les|lhas)?/i, '')),
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
          if (!/^\$?\s*[\d.,]+\s*$/.test(text.trim())) throw new FlowError('Mande só o valor em dólar. Ex: 150 ou 150.50');
          return checkMoney(parseMoney(text), { what: 'O valor do serviço' });
        },
      },
      {
        key: 'confirmed',
        ask: (data, ctx) => `Confere?\n\n${draftSummary(ctx, data)}\n\nMande *sim* para salvar ou *cancelar* para descartar.`,
        parse(text) {
          if (['sim', 's', 'ok', 'confirmar', 'salvar', 'isso'].includes(simplify(text))) return true;
          throw new FlowError('Mande *sim* para salvar, ou *cancelar* e depois *novo* para começar de novo.');
        },
      },
    ],
    async finish({ ctx, user, data }) {
      // O contato novo só é criado aqui, depois da confirmação.
      const client = data.client;
      const contactId = client.id
        ? client.id
        : ctx.data.contacts.findOrCreate({ phone: client.phone || null, name: client.name, source: 'whatsapp' }).id;
      const { vehicle, plate } = splitVehicle(data.vehicle);
      const service = ctx.data.services.create({
        contact_id: contactId,
        pickup: data.pickup,
        dropoff: data.dropoff,
        vehicle,
        plate,
        miles: data.miles,
        price_cents: data.price_cents,
        driver_id: user.id,
      });
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
  // Placa: 5 a 8 letras/números misturados ("F150" e "F-150" são modelos, não placas).
  if (parts.length > 1 && /^[A-Z0-9]{5,8}$/i.test(last) && /\d/.test(last) && /[A-Z]/i.test(last)) {
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
    blockable: true, // fica suspenso se o motorista está devendo a milhagem
    help: '*novo* – registrar um serviço',
    run: ({ ctx, user }) => ctx.bot.startFlow(user, 'novo'),
  },
  {
    names: ['atual', 'servico', 'serviço'],
    blockable: true, // fica suspenso se o motorista está devendo a milhagem
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
      const blocked = blockDone(ctx, service);
      if (blocked) return blocked;
      ctx.data.services.update(service.id, { status: 'concluido' });
      ctx.data.services.setActive(user.id, null);
      const done = ctx.data.services.get(service.id);
      const pending = ctx.loaded.flatMap((m) => [...(m.afterDone?.({ ctx, service: done, user }) || []), ...(m.onServiceDone?.({ ctx, service }) || [])]);
      return [`🏁 Serviço #${service.id} entregue.`, ...pending].join('\n');
    },
  },
  {
    names: ['fila'],
    help: '*fila* – serviços pendentes, sem motorista (só o dono)',
    run({ ctx, user }) {
      if (user.role !== 'dono') return 'Só o dono vê a fila e escolhe o motorista de cada serviço.';
      const list = ctx.data.services.list({ status: 'pendente', limit: 20 });
      if (!list.length) return 'Nenhum serviço na fila. 👍';
      const lines = list.map((s) => `• *#${s.id}* ${s.contact_name || 'Sem cliente'} – ${String(s.pickup || '').replace(/https?:\/\/\S+/g, 'local no mapa')}${s.vehicle ? ` (${s.vehicle})` : ''}`);
      return [`⏳ *Fila* (${list.length})`, ...lines, '', 'Para escolher o motorista, abra o serviço no painel.'].join('\n');
    },
  },
  {
    names: ['abrir', 'voltar'],
    blockable: true, // fica suspenso se o motorista está devendo a milhagem
    help: '*abrir 12* – voltar a mexer no serviço #12',
    run({ ctx, user, args }) {
      const id = Number(String(args[0] || '').replace('#', ''));
      const service = id && ctx.data.services.get(id);
      if (!canSee(user, service)) return 'Não achei esse serviço.';
      if (service.status === 'pendente') takeService(ctx, service, user.id);
      else if (service.status !== 'aberto') ctx.data.services.update(service.id, { status: 'aberto' });
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

const blank = (v) => v == null || String(v).trim() === '';
const optional = (v, check) => (blank(v) ? null : check(v));
const checkPin = (pin) => {
  if (!/^\d{4,8}$/.test(String(pin ?? ''))) throw new HttpError(400, 'O PIN precisa ter de 4 a 8 números.');
  return String(pin);
};

// Confere os campos de um serviço vindos do painel. Em edição (partial), só os que vieram.
// Painel: confere no mapa a retirada e o destino que mudaram. Troca pelo endereço
// completo quando acha um só; recusa quando não acha (a não ser com address_ok).
async function checkPlaces(ctx, fields, body, current = {}) {
  for (const [key, what] of [['pickup', 'a retirada'], ['dropoff', 'o destino']]) {
    const value = fields[key];
    if (!value || value === current[key] || body.address_ok || ctx.suggestedPlaces?.has(value)) continue;
    const place = await resolvePlace(ctx, value);
    if (place.value) {
      fields[key] = place.value;
      continue;
    }
    const { options } = place.check;
    if (options.some((o) => o.toLowerCase() === value.toLowerCase())) continue;
    const err = new HttpError(
      400,
      options.length
        ? `Achei mais de um endereço para ${what} "${value}". Escolha um da lista que aparece ao digitar.`
        : `Não achei ${what} "${value}" no mapa. Confira o número, a rua e a cidade.`
    );
    err.code = options.length ? 'endereco_varios' : 'endereco';
    err.options = options;
    throw err;
  }
}

function serviceFields(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => !partial || body[k] !== undefined;
  if (has('pickup')) out.pickup = partial ? optional(body.pickup, (v) => checkLocation(v, 'O local de retirada')) : checkLocation(body.pickup, 'O local de retirada');
  if (has('dropoff')) out.dropoff = optional(body.dropoff, (v) => checkLocation(v, 'O destino'));
  if (has('vehicle')) out.vehicle = optional(body.vehicle, checkVehicle);
  if (has('plate')) out.plate = optional(body.plate, checkPlate);
  if (has('miles')) out.miles = optional(body.miles, checkMiles);
  if (has('price')) out.price_cents = optional(body.price, (v) => checkMoney(parseMoney(v), { what: 'O valor do serviço' }));
  if (has('notes')) out.notes = blank(body.notes) ? null : String(body.notes).trim().slice(0, 1000);
  if (partial && body.status !== undefined) {
    if (!['pendente', 'aberto', 'concluido', 'cancelado'].includes(body.status)) throw new HttpError(400, 'Situação inválida.');
    out.status = body.status;
  }
  if (body.driver_id !== undefined) out.driver_id = Number(body.driver_id) || null;
  return out;
}

function routes(api, ctx) {
  const { data, db } = ctx;

  // Alertas para o topo do painel (cobrança atrasada, manutenção...).
  api.get('/alerts', (req, res) => {
    res.json(collectAlerts(ctx, req.user));
  });

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
    const { role = 'motorista' } = req.body || {};
    const name = checkName(req.body?.name);
    const p = checkPhone(req.body?.phone);
    const pin = blank(req.body?.pin) ? null : checkPin(req.body.pin);
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
      blank(name) ? user.name : checkName(name),
      blank(phone) ? user.phone : checkPhone(phone),
      active === undefined ? user.active : active ? 1 : 0,
      user.id
    );
    if (!blank(pin)) db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hashPin(checkPin(pin)), user.id);
    res.json(publicUser(data.users.get(user.id)));
  });

  // Contatos
  api.get('/contacts', (req, res) => res.json(data.contacts.search(req.query.q || '', 500)));
  api.post('/contacts', (req, res) => {
    const { email, notes } = req.body || {};
    const name = checkName(req.body?.name);
    const phone = optional(req.body?.phone, checkPhone);
    if (phone && data.contacts.byPhone(phone)) throw new HttpError(409, 'Já existe um contato com esse telefone.');
    res.status(201).json(data.contacts.create({ name, phone, email: blank(email) ? null : email, notes: blank(notes) ? null : notes }));
  });
  // Sugestões enquanto digita o nome (ou telefone) do cliente no Novo serviço:
  // ignora acentos e maiúsculas, e já traz o veículo do último serviço.
  api.get('/contacts/suggest', (req, res) => {
    const q = simplify(req.query.q || '');
    const digits = String(req.query.q || '').replace(/\D/g, '');
    if (q.length < 2 && digits.length < 3) return res.json([]);
    const words = q.split(/\s+/).filter((w) => !/^\d+$/.test(w));
    const all = ctx.db.prepare('SELECT * FROM contacts ORDER BY name COLLATE NOCASE').all();
    const found = all
      .filter((c) => {
        if (digits.length >= 3 && !words.length) return (c.phone || '').includes(digits);
        const name = simplify(c.name);
        return words.length > 0 && words.every((w) => name.includes(w));
      })
      // Quem começa com o que foi digitado vem primeiro; depois em ordem alfabética.
      .sort((a, b) => Number(!simplify(a.name).startsWith(q)) - Number(!simplify(b.name).startsWith(q)) || a.name.localeCompare(b.name, 'pt-BR'))
      .slice(0, 8);
    // Apelido ou nome da empresa (ex.: "ss" = Super Speed): as pessoas que pedem por ela vêm primeiro.
    const companies = ctx.has('empresas')
      ? ctx.db.prepare('SELECT id, name, nickname FROM companies').all().filter((co) => (co.nickname && simplify(co.nickname) === q) || (q.length >= 3 && simplify(co.name).includes(q)))
      : [];
    const extra = [];
    for (const co of companies) {
      const people = all.filter((c) => c.company_id === co.id);
      // Empresa sem ninguém cadastrado: oferece a própria empresa como cliente.
      if (!people.length) extra.push({ id: null, name: co.name, phone: null, company_id: co.id, company_name: co.name, last: null });
      for (const c of people) if (!extra.some((e) => e.id === c.id)) extra.push(c);
    }
    const merged = [...extra, ...found.filter((c) => !extra.some((e) => e.id === c.id))].slice(0, 10);
    const company = ctx.has('empresas') ? ctx.db.prepare('SELECT name FROM companies WHERE id = ?') : null;
    res.json(
      merged.map((c) => {
        if (!c.id) return c;
        const last = data.services.list({ contactId: c.id, limit: 20 }).find((s) => canSee(req.user, s)) || null;
        return {
          id: c.id,
          name: c.name,
          phone: c.phone,
          company_name: company && c.company_id ? company.get(c.company_id)?.name || null : null,
          last: last && { id: last.id, vehicle: last.vehicle, plate: last.plate, pickup: last.pickup, dropoff: last.dropoff, created_at: last.created_at },
        };
      })
    );
  });
  api.get('/contacts/:id', (req, res) => {
    const contact = data.contacts.get(Number(req.params.id));
    if (!contact) throw new HttpError(404, 'Contato não encontrado.');
    const services = data.services.list({ contactId: contact.id }).filter((s) => canSee(req.user, s));
    res.json({ ...contact, services });
  });
  api.patch('/contacts/:id', (req, res) => {
    const body = req.body || {};
    const fields = {};
    if (body.name !== undefined) fields.name = checkName(body.name);
    if (body.phone !== undefined) {
      fields.phone = optional(body.phone, checkPhone);
      const other = fields.phone && data.contacts.byPhone(fields.phone);
      if (other && other.id !== Number(req.params.id)) throw new HttpError(409, `Esse telefone já é do contato ${other.name}.`);
    }
    if (body.email !== undefined) fields.email = blank(body.email) ? null : body.email;
    if (body.notes !== undefined) fields.notes = blank(body.notes) ? null : body.notes;
    const contact = data.contacts.update(Number(req.params.id), fields);
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
    const blocked = servicesBlocked(ctx, req.user);
    if (blocked) throw new HttpError(423, blocked.replace(/\*/g, ''));
    const status = req.query.status || null;
    const driverId = req.user.role === 'dono' ? Number(req.query.driver) || null : req.user.id;
    res.json(data.services.list({ status, driverId, limit: Number(req.query.limit) || 100 }));
  });
  // Sugestões de endereço enquanto digita no painel.
  api.get('/places', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!ctx.geo || q.length < 4 || q.length > 200 || isMapReference(q)) return res.json({ matches: [] });
    const found = await ctx.geo.lookup(q);
    const labels = found.matches.map((m) => m.label);
    // Endereço escolhido da lista já veio do mapa: não precisa conferir de novo ao salvar.
    ctx.suggestedPlaces ??= new Set();
    for (const label of labels) ctx.suggestedPlaces.add(label);
    if (ctx.suggestedPlaces.size > 1000) ctx.suggestedPlaces.clear();
    res.json({ matches: labels });
  });

  api.post('/services', async (req, res) => {
    const blocked = servicesBlocked(ctx, req.user);
    if (blocked) throw new HttpError(423, blocked.replace(/\*/g, ''));
    const body = req.body || {};
    // Confere tudo antes de criar qualquer coisa.
    const fields = serviceFields(body);
    await checkPlaces(ctx, fields, body);
    let contactName = optional(body.contact_name, (v) => checkName(v, 'O nome do cliente'));
    const contactPhone = optional(body.contact_phone, checkPhone);
    let contactId = Number(body.contact_id) || null;
    // Apelido de empresa no nome do cliente (ex.: "SS"): vira a empresa.
    let companyId = Number(body.company_id) || null;
    if (!contactId && contactName && ctx.has('empresas')) {
      const co = ctx.db.prepare('SELECT * FROM companies').all().find((c) => c.nickname && simplify(c.nickname) === simplify(contactName));
      if (co) {
        contactName = co.name;
        companyId = co.id;
      }
    }
    const chosen = contactId && data.contacts.get(contactId);
    if (contactId && !chosen) throw new HttpError(400, 'Cliente não encontrado.');
    // Cliente escolhido da agenda sem telefone: guarda o telefone digitado.
    if (chosen && !chosen.phone && contactPhone && !data.contacts.byPhone(contactPhone)) data.contacts.update(chosen.id, { phone: contactPhone });
    // Mesmo nome de um contato que já existe: usa ele em vez de duplicar.
    const sameName = () => {
      if (!contactName) return null;
      const same = ctx.db.prepare('SELECT * FROM contacts').all().filter((c) => simplify(c.name) === simplify(contactName));
      return same.length === 1 ? same[0] : null;
    };
    if (!contactId && contactPhone) {
      const twin = !data.contacts.byPhone(contactPhone) && sameName();
      if (twin && !twin.phone) {
        data.contacts.update(twin.id, { phone: contactPhone });
        contactId = twin.id;
      } else contactId = data.contacts.findOrCreate({ phone: contactPhone, name: contactName }).id;
    } else if (!contactId && contactName) contactId = (sameName() || data.contacts.create({ name: contactName })).id;
    // Cliente novo de uma empresa: já fica ligado a ela.
    if (companyId && contactId && ctx.has('empresas') && ctx.db.prepare('SELECT 1 FROM companies WHERE id = ?').get(companyId)) {
      ctx.db.prepare('UPDATE contacts SET company_id = ? WHERE id = ? AND company_id IS NULL').run(companyId, contactId);
    }
    // "fila": entra como pendente, sem motorista, até o dono escolher quem vai. Só o dono.
    if (req.user.role === 'dono' && (body.fila === true || body.fila === '1' || body.driver_id === 'fila' || body.status === 'pendente')) {
      const service = data.services.create({ ...fields, driver_id: null, contact_id: contactId, status: 'pendente' });
      return res.status(201).json(service);
    }
    const driverId = req.user.role === 'dono' ? fields.driver_id || req.user.id : req.user.id;
    const service = data.services.create({ ...fields, status: 'aberto', contact_id: contactId, driver_id: driverId });
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
  api.patch('/services/:id', async (req, res) => {
    const service = data.services.get(Number(req.params.id));
    if (!canSee(req.user, service)) throw new HttpError(404, 'Serviço não encontrado.');
    const body = serviceFields(req.body || {}, { partial: true });
    await checkPlaces(ctx, body, req.body || {}, service);
    if (body.pickup === null) delete body.pickup; // retirada não pode ficar vazia
    if (req.user.role !== 'dono') delete body.driver_id;
    // Fila: só o dono põe e tira serviço dela (é ele quem escolhe o motorista).
    if (req.user.role !== 'dono' && (body.status === 'pendente' || service.status === 'pendente')) throw new HttpError(403, 'Só o dono escolhe o motorista do serviço.');
    if (service.status === 'pendente' && body.status === 'aberto' && !body.driver_id) body.driver_id = req.user.id;
    // Volta para a fila: sem motorista. Só o dono ou o motorista do serviço.
    if (body.status === 'pendente') body.driver_id = null;
    // Pendente com motorista escolhido pelo dono: passa a estar em andamento.
    else if (service.status === 'pendente' && body.driver_id && !body.status) body.status = 'aberto';
    // Fechar: confere as regras da empresa (ex.: VIN obrigatório).
    const finishing = body.status === 'concluido' && service.status !== 'concluido';
    if (finishing) {
      const blocked = blockDone(ctx, { ...service, ...body });
      if (blocked) throw new HttpError(400, blocked.replace(/\*/g, ''));
    }
    // Cancelar: guarda o motivo nas observações e, se foi o motorista, avisa o dono.
    const cancelling = body.status === 'cancelado' && service.status !== 'cancelado';
    const motivo = cancelling ? String(req.body?.motivo || '').trim().slice(0, 300) : '';
    if (motivo) body.notes = [body.notes ?? service.notes, `Cancelado: ${motivo}`].filter(Boolean).join('\n');
    let updated = data.services.update(service.id, body);
    let notices = [];
    if (finishing) {
      notices = ctx.loaded.flatMap((mod) => mod.afterDone?.({ ctx, service: updated, user: req.user }) || []);
      updated = data.services.get(service.id);
    }
    if (cancelling && req.user.role !== 'dono' && ctx.send) {
      const text = `❌ ${req.user.name} cancelou o serviço #${service.id}${service.contact_name ? ` (${service.contact_name})` : ''}.${motivo ? `\nMotivo: ${motivo}` : ''}`;
      for (const o of db.prepare("SELECT phone FROM users WHERE active = 1 AND role = 'dono'").all()) ctx.send(o.phone, text).catch(() => {});
    }
    if (service.status === 'pendente' && updated.status === 'aberto' && updated.driver_id) {
      if (!data.services.active({ id: updated.driver_id })) data.services.setActive(updated.driver_id, service.id);
      notifyAssigned(ctx, updated, req.user);
    }
    if (body.status && body.status !== 'aberto') {
      db.prepare('UPDATE users SET active_service_id = NULL WHERE active_service_id = ?').run(service.id);
    }
    res.json(notices.length ? { ...updated, notices } : updated);
  });

  // Passar um serviço da fila para um motorista. Só o dono escolhe.
  api.post('/services/:id/passar', (req, res) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o dono escolhe o motorista do serviço.');
    const service = data.services.get(Number(req.params.id));
    if (!service) throw new HttpError(404, 'Serviço não encontrado.');
    if (service.status !== 'pendente') throw new HttpError(409, service.driver_name ? `Esse serviço já está com ${service.driver_name}.` : 'Esse serviço não está mais na fila.');
    const driver = data.users.get(Number(req.body?.driver_id) || req.user.id);
    if (!driver || !driver.active) throw new HttpError(400, 'Motorista não encontrado.');
    const updated = takeService(ctx, service, driver.id);
    notifyAssigned(ctx, updated, req.user);
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
    const name = checkName(req.body?.name, 'Seu nome');
    const p = checkPhone(req.body?.phone);
    const pin = checkPin(req.body?.pin);
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

// Aba "Serviços" da planilha. Os outros módulos acrescentam colunas (exportColumns).
const STATUS_LABEL = { pendente: 'Pendente', aberto: 'Em andamento', concluido: 'Concluído', cancelado: 'Cancelado' };

function exportSheets({ ctx, from, to, userId }) {
  const where = ['s.created_at >= ?', 's.created_at < ?'];
  const params = [from, to];
  if (userId) {
    where.push('s.driver_id = ?');
    params.push(userId);
  }
  const services = ctx.db
    .prepare(
      `SELECT s.*, c.name AS contact_name, c.phone AS contact_phone, u.name AS driver_name
       FROM services s LEFT JOIN contacts c ON c.id = s.contact_id LEFT JOIN users u ON u.id = s.driver_id
       WHERE ${where.join(' AND ')} ORDER BY s.id`
    )
    .all(...params);
  const extra = ctx.loaded.flatMap((m) => m.exportColumns?.(ctx) || []);
  const columns = [
    { header: 'Nº', width: 6, type: 'number', value: (s) => s.id },
    { header: 'Data', width: 17, type: 'date', value: (s) => s.created_at },
    { header: 'Situação', width: 14, value: (s) => STATUS_LABEL[s.status] || s.status },
    { header: 'Motorista', width: 14, value: (s) => s.driver_name },
    { header: 'Cliente', width: 22, value: (s) => s.contact_name },
    { header: 'Telefone', width: 16, value: (s) => (s.contact_phone ? formatPhone(s.contact_phone) : '') },
    { header: 'Retirada', width: 36, value: (s) => s.pickup },
    { header: 'Destino', width: 36, value: (s) => s.dropoff },
    { header: 'Veículo', width: 22, value: (s) => s.vehicle },
    { header: 'Placa', width: 10, value: (s) => s.plate },
    { header: 'VIN', width: 20, value: (s) => s.vin },
    { header: 'Milhas', width: 8, type: 'number', value: (s) => s.miles },
    { header: 'Valor', width: 11, type: 'money', value: (s) => (s.price_cents == null ? null : s.price_cents / 100) },
    ...extra,
    { header: 'Concluído em', width: 17, type: 'date', value: (s) => s.completed_at },
    { header: 'Observações', width: 30, value: (s) => s.notes },
  ];
  return [{ name: 'Serviços', columns, rows: services.map((row) => columns.map((c) => c.value(row))) }];
}

export default {
  name: 'core',
  label: 'Serviços',
  migrations,
  commands,
  flows,
  routes,
  publicRoutes,
  exportSheets,
};
