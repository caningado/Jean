// Módulo de pagamentos: Zelle, dinheiro, cartão, cheque e seguradora/motor club.
// Guarda quem recebeu (para saber quanto dinheiro está com cada motorista) e o que falta receber.
import { parseMoney, formatMoney, simplify, nowIso, HttpError, startOfDayIso, dayFormatter } from '../../lib/util.js';
import { renderPendingList } from './lista-pdf.js';
import { checkMoney, ValidationError } from '../../lib/validate.js';
import express from 'express';
import { createSquare, validSquareSignature } from '../../lib/square.js';
import { qrSvg } from '../../lib/qrcode.js';

export const METHODS = {
  zelle: 'Zelle',
  dinheiro: 'Dinheiro',
  cartao: 'Cartão',
  cheque: 'Cheque',
  seguradora: 'Seguradora / motor club',
};

const migrations = [
  `CREATE TABLE payments (
     id INTEGER PRIMARY KEY,
     service_id INTEGER NOT NULL REFERENCES services(id),
     amount_cents INTEGER NOT NULL,
     method TEXT NOT NULL CHECK (method IN ('zelle', 'dinheiro', 'cartao', 'cheque', 'seguradora')),
     status TEXT NOT NULL DEFAULT 'recebido' CHECK (status IN ('recebido', 'a_receber')),
     payer TEXT,
     received_by INTEGER REFERENCES users(id),
     created_at TEXT NOT NULL,
     received_at TEXT
   );
   CREATE INDEX payments_service ON payments(service_id);`,
  // Dinheiro que o dono recolheu de cada motorista (zera o que estava em mãos).
  `CREATE TABLE cash_collections (
     id INTEGER PRIMARY KEY,
     driver_id INTEGER NOT NULL REFERENCES users(id),
     amount_cents INTEGER NOT NULL,
     collected_by INTEGER REFERENCES users(id),
     created_at TEXT NOT NULL
   );
   CREATE INDEX cash_collections_driver ON cash_collections(driver_id, created_at);`,
  // Links de pagamento do Square: reaproveita o mesmo link e marca pago quando o cliente paga.
  `CREATE TABLE square_links (
     id INTEGER PRIMARY KEY,
     service_id INTEGER NOT NULL REFERENCES services(id),
     amount_cents INTEGER NOT NULL,
     fee_cents INTEGER NOT NULL DEFAULT 0,
     link_id TEXT,
     url TEXT NOT NULL,
     order_id TEXT,
     payment_id INTEGER REFERENCES payments(id),
     created_at TEXT NOT NULL
   );
   CREATE INDEX square_links_order ON square_links(order_id);`,
  // Conferência dos pagamentos pelo ADM (pedido do Caningado 28/10). Os que já existiam entram como conferidos.
  `ALTER TABLE payments ADD COLUMN checked_at TEXT;
   ALTER TABLE payments ADD COLUMN checked_by INTEGER REFERENCES users(id);
   UPDATE payments SET checked_at = COALESCE(received_at, created_at) WHERE status = 'recebido';`,
];

// Formas de pagamento que ficam na mão do motorista até ele entregar ao dono.
const IN_HAND = ['dinheiro', 'cheque'];

const MOTOR_CLUBS = { aaa: 'AAA', agero: 'Agero', honk: 'Honk', urgently: 'Urgently', allstate: 'Allstate', geico: 'GEICO', progressive: 'Progressive' };

// "zelle", "cash", "aaa" -> { method, payer }
export function parseMethod(word) {
  const s = simplify(word);
  if (!s) return null;
  if (s.startsWith('zelle')) return { method: 'zelle' };
  if (['dinheiro', 'cash', 'especie', 'dim'].includes(s)) return { method: 'dinheiro' };
  if (['cartao', 'card', 'credito', 'debito', 'credit', 'debit'].includes(s)) return { method: 'cartao' };
  if (['cheque', 'check'].includes(s)) return { method: 'cheque' };
  if (['seguradora', 'seguro', 'insurance', 'motorclub', 'clube'].includes(s)) return { method: 'seguradora' };
  if (MOTOR_CLUBS[s]) return { method: 'seguradora', payer: MOTOR_CLUBS[s] };
  return null;
}

export function balance(ctx, service) {
  const row = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN status = 'recebido' THEN amount_cents END), 0) AS received,
              COALESCE(SUM(CASE WHEN status = 'a_receber' THEN amount_cents END), 0) AS billed
       FROM payments WHERE service_id = ?`
    )
    .get(service.id);
  const price = service.price_cents || 0;
  return {
    received_cents: row.received,
    to_receive_cents: row.billed,
    // Quanto ainda não foi nem recebido nem cobrado de seguradora.
    open_cents: Math.max(0, price - row.received - row.billed),
  };
}

function addPayment(ctx, { serviceId, amountCents, method, payer = null, userId }) {
  const status = method === 'seguradora' ? 'a_receber' : 'recebido';
  // Quem recebe é o motorista do serviço: se o dono anota pelo painel o dinheiro que o
  // motorista pegou, o dinheiro conta como estando com o motorista.
  const service = ctx.db.prepare('SELECT driver_id FROM services WHERE id = ?').get(serviceId);
  if (service?.driver_id) userId = service.driver_id;
  const now = nowIso();
  const info = ctx.db
    .prepare('INSERT INTO payments (service_id, amount_cents, method, status, payer, received_by, created_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(serviceId, amountCents, method, status, payer, status === 'recebido' ? userId : null, now, status === 'recebido' ? now : null);
  return ctx.db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(info.lastInsertRowid));
}

// Avisa os ADM pelo WhatsApp quando entra pagamento (pedido do Caningado 28/10), marcando
// os que estavam atrasados e os de cartão. Quem registrou não recebe o aviso.
// items: [{ service, payment }] (uma baixa em lote vira uma mensagem só).
export async function notifyPayments(ctx, items, byUserId = null) {
  items = items.filter((i) => i.payment?.status === 'recebido');
  if (!items.length || !ctx.send) return 0;
  const admins = ctx.db.prepare("SELECT * FROM users WHERE active = 1 AND role = 'dono' AND id <> ?").all(byUserId || 0);
  if (!admins.length) return 0;
  const by = byUserId ? ctx.data.users.get(byUserId)?.name : null;
  const rows = items.map(({ service, payment }) => {
    const days = daysSince(service.completed_at || service.created_at);
    return { service, payment, late: days >= ctx.config.overdueDays ? days : 0, left: balance(ctx, service).open_cents };
  });
  const total = rows.reduce((sum, r) => sum + r.payment.amount_cents, 0);
  const card = rows.some((r) => r.payment.method === 'cartao');
  const late = rows.filter((r) => r.late).length;
  const title = `${late ? '⏰' : card ? '💳' : '💵'} *${rows.length > 1 ? `${rows.length} pagamentos recebidos` : 'Pagamento recebido'}${late ? (rows.length > 1 ? ` (${late} atrasado${late > 1 ? 's' : ''})` : ' de serviço atrasado') : ''}${card && !late ? ' no cartão' : ''}*`;
  let sent = 0;
  for (const admin of admins) {
    const lines = rows.map((r) => {
      const who = r.service.contact_name || r.service.vehicle || 'Cliente';
      const how = METHODS[r.payment.method] + (r.payment.payer && r.payment.method !== 'cartao' ? ` (${r.payment.payer})` : '');
      return `• #${ctx.data.services.ref(r.service, admin)} ${who}: ${formatMoney(r.payment.amount_cents)} – ${how}${r.payment.method === 'cartao' ? ' 💳' : ''}${r.late ? ` · ⏰ estava atrasado ${r.late} dias` : ''}${r.left > 0 ? ` · falta ${formatMoney(r.left)}` : ' · quitado ✅'}`;
    });
    const text = [title, ...lines, rows.length > 1 ? `Total: ${formatMoney(total)}` : '', by ? `Registrado por ${by}.` : ''].filter(Boolean).join('\n');
    try {
      if (await ctx.send(admin.phone, text)) sent++;
    } catch (err) {
      ctx.log?.(`Não consegui avisar ${admin.name} do pagamento`, err);
    }
  }
  return sent;
}

// Quanto cada motorista tem em mãos: dinheiro e cheques recebidos menos o que o dono já recolheu.
export function cashInHand(ctx, userId = null) {
  const marks = IN_HAND.map(() => '?').join(', ');
  const drivers = ctx.db
    .prepare(`SELECT id, name FROM users WHERE role = 'motorista' AND (active = 1 OR id IN (SELECT received_by FROM payments)) ${userId ? 'AND id = ?' : ''} ORDER BY name`)
    .all(...(userId ? [userId] : []));
  return drivers
    .map((d) => {
      const received = ctx.db
        .prepare(`SELECT method, COALESCE(SUM(amount_cents), 0) AS total FROM payments WHERE status = 'recebido' AND received_by = ? AND method IN (${marks}) GROUP BY method`)
        .all(d.id, ...IN_HAND);
      const last = ctx.db.prepare('SELECT * FROM cash_collections WHERE driver_id = ? ORDER BY id DESC LIMIT 1').get(d.id);
      const collected = ctx.db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM cash_collections WHERE driver_id = ?').get(d.id).total;
      const total = received.reduce((sum, r) => sum + r.total, 0) - collected;
      // Pagamentos em mãos desde o último recolhimento (para conferir quais serviços).
      const since = ctx.db
        .prepare(
          `SELECT p.id, p.service_id, p.amount_cents, p.method, p.received_at, c.name AS contact_name
           FROM payments p JOIN services s ON s.id = p.service_id LEFT JOIN contacts c ON c.id = s.contact_id
           WHERE p.status = 'recebido' AND p.received_by = ? AND p.method IN (${marks}) AND p.received_at > ?
           ORDER BY p.received_at`
        )
        .all(d.id, ...IN_HAND, last?.created_at || '');
      return {
        driver_id: d.id,
        name: d.name,
        in_hand_cents: total,
        last_collection: last ? { amount_cents: last.amount_cents, created_at: last.created_at } : null,
        payments: since,
      };
    })
    .filter((d) => userId || d.in_hand_cents !== 0 || d.last_collection);
}

function collectCash(ctx, { driverId, amountCents, ownerId }) {
  ctx.db
    .prepare('INSERT INTO cash_collections (driver_id, amount_cents, collected_by, created_at) VALUES (?, ?, ?, ?)')
    .run(driverId, amountCents, ownerId, nowIso());
  return cashInHand(ctx, driverId)[0];
}

const daysAgo = (iso) => {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return days <= 0 ? 'hoje' : days === 1 ? 'ontem' : `há ${days} dias`;
};

// Mensagem pronta para o motorista encaminhar ao cliente (em inglês, pois o cliente está nos EUA).
// Número da invoice do serviço (se o módulo de invoice estiver ligado e já tiver uma).
function invoiceNumber(ctx, service) {
  try {
    return ctx.db.prepare('SELECT number FROM invoices WHERE service_id = ? ORDER BY id DESC LIMIT 1').get(service.id)?.number ?? null;
  } catch {
    return null;
  }
}

// O que está sendo cobrado, do jeito que o cliente entende: invoice, ou o carro.
// O número do serviço é interno e não vai para o cliente.
function chargeWhat(ctx, service) {
  const inv = invoiceNumber(ctx, service);
  if (inv) return `Invoice #${inv}`;
  return service.vehicle ? `Towing service – ${service.vehicle}` : 'Towing service';
}

const hello = (ctx, service) => `Hi${service.contact_name ? ' ' + service.contact_name.split(' ')[0] : ''}! Thank you for choosing ${ctx.config.companyName}.`;

export function chargeMessage(ctx, service, amountCents, card = null) {
  const { name, contact } = ctx.config.zelle;
  const lines = [hello(ctx, service), '', chargeWhat(ctx, service), `Amount due: ${formatMoney(amountCents)}`];
  if (contact || card) lines.push('');
  if (contact) lines.push(`Pay with Zelle to ${name || ctx.config.companyName}: ${contact}`);
  if (card) lines.push(`${contact ? 'Or pay' : 'Pay'} by card (${formatMoney(card.total_cents)}, includes ${formatMoney(card.fee_cents)} card fee): ${card.url}`);
  return lines.join('\n');
}

// Mensagem só com o link do cartão (botão "Link do cartão").
export function cardMessage(ctx, service, card) {
  return [
    hello(ctx, service),
    '',
    chargeWhat(ctx, service),
    `Amount: ${formatMoney(card.base_cents)}`,
    `Card fee: ${formatMoney(card.fee_cents)}`,
    `Total: ${formatMoney(card.total_cents)}`,
    '',
    `Pay securely by card: ${card.url}`,
  ].join('\n');
}

// Taxa do cartão do Square: começa com SQUARE_TAXA / SQUARE_TAXA_FIXA e é atualizada todo dia
// com a taxa que o Square cobrou de verdade nos pagamentos pelos links.
const FEE_KEY = 'square_taxa';
export function cardFee(ctx) {
  const saved = ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get(FEE_KEY);
  if (saved) return JSON.parse(saved.value);
  return { pct: ctx.config.square.feePct, fixed_cents: ctx.config.square.feeFixedCents, updated_at: null };
}

// Valor do link para a empresa receber o valor cheio depois que o Square tira a taxa.
export function withCardFee(ctx, baseCents) {
  const { pct, fixed_cents } = cardFee(ctx);
  const total = Math.ceil((baseCents + fixed_cents) / (1 - pct / 100));
  return { base_cents: baseCents, fee_cents: total - baseCents, total_cents: total };
}

// Link do Square para pagar com cartão (valor + taxa). Reaproveita o link já feito para o mesmo valor.
// Se o Square falhar, devolve null e a cobrança sai só com o Zelle.
export async function cardLink(ctx, service, baseCents) {
  if (!ctx.square?.configured || !baseCents) return null;
  const price = withCardFee(ctx, baseCents);
  const old = ctx.db
    .prepare('SELECT url FROM square_links WHERE service_id = ? AND amount_cents = ? AND fee_cents = ? AND payment_id IS NULL ORDER BY id DESC')
    .get(service.id, baseCents, price.fee_cents);
  if (old) return { ...price, url: old.url };
  try {
    const link = await ctx.square.createLink({
      amountCents: price.total_cents,
      name: `${ctx.config.companyName} – ${chargeWhat(ctx, service)}`,
      note: [service.contact_name, service.vehicle].filter(Boolean).join(' · '),
    });
    ctx.db
      .prepare('INSERT INTO square_links (service_id, amount_cents, fee_cents, link_id, url, order_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(service.id, baseCents, price.fee_cents, link.id, link.url, link.orderId, nowIso());
    return { ...price, url: link.url };
  } catch (err) {
    ctx.log('Square: não consegui criar o link de pagamento', err.message);
    return null;
  }
}

// Todo dia: confere quanto o Square cobrou nos pagamentos dos nossos links (últimos 30 dias)
// e guarda a taxa nova. A parte fixa fica a configurada; a porcentagem vem da média real.
export async function updateCardFee(ctx, now = new Date()) {
  if (!ctx.square?.configured) return null;
  const since = new Date(now.getTime() - 30 * 86400000).toISOString();
  const payments = await ctx.square.listPayments(since);
  const ours = new Set(ctx.db.prepare('SELECT order_id FROM square_links WHERE order_id IS NOT NULL').all().map((r) => r.order_id));
  const fixed = ctx.config.square.feeFixedCents;
  const rates = payments
    .filter((p) => p.status === 'COMPLETED' && ours.has(p.order_id) && p.processing_fee?.length && p.total_money?.amount > 0)
    .map((p) => (p.processing_fee.reduce((sum, f) => sum + (f.amount_money?.amount || 0), 0) - fixed) / p.total_money.amount);
  if (!rates.length) return null;
  const pct = Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 10000) / 100;
  if (!(pct > 0 && pct < 10)) return null;
  const fee = { pct, fixed_cents: fixed, updated_at: now.toISOString(), payments: rates.length };
  ctx.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(FEE_KEY, JSON.stringify(fee));
  return fee;
}

// Square avisou que o cliente pagou: registra o pagamento em cartão e avisa o dono e o motorista.
export async function squarePaid(ctx, payment) {
  if (payment?.status !== 'COMPLETED' || !payment.order_id) return null;
  const link = ctx.db.prepare('SELECT * FROM square_links WHERE order_id = ?').get(payment.order_id);
  if (!link || link.payment_id) return null;
  const service = ctx.data.services.get(link.service_id);
  if (!service) return null;
  // Entra o valor do serviço; a taxa do cartão fica com o Square.
  const amountCents = link.amount_cents;
  const row = addPayment(ctx, { serviceId: service.id, amountCents, method: 'cartao', payer: 'Square' });
  ctx.db.prepare('UPDATE square_links SET payment_id = ? WHERE order_id = ?').run(row.id, payment.order_id);
  const left = balance(ctx, service).open_cents;
  const late = daysSince(service.completed_at || service.created_at);
  // O motorista vê o número do dia dele, nunca o número geral do serviço.
  const text = (person) =>
    `💳 ${service.contact_name || 'Cliente'} pagou ${formatMoney(amountCents)} com cartão (Square) no serviço #${ctx.data.services.ref(service, person)}.${late >= ctx.config.overdueDays ? `\n⏰ Estava atrasado ${late} dias.` : ''}${left ? `\nAinda falta ${formatMoney(left)}.` : '\nServiço quitado ✅'}`;
  const people = ctx.db.prepare("SELECT * FROM users WHERE active = 1 AND (role = 'dono' OR id = ?)").all(service.driver_id || 0);
  for (const person of people) {
    try {
      await ctx.send?.(person.phone, text(person));
    } catch (err) {
      ctx.log(`Não consegui avisar ${person.name} do pagamento no Square`, err);
    }
  }
  return row;
}

// Dias desde o serviço (conta da entrega, ou da criação se ainda não entregou).
const daysSince = (iso, now = Date.now()) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / 86400000));

// Serviços com dinheiro para receber, do mais antigo para o mais novo.
// overdue = passou de COBRANCA_DIAS sem receber.
function pendingList(ctx, userId) {
  const services = ctx.data.services
    .list({ driverId: userId, limit: 1000 })
    .filter((s) => s.status !== 'cancelado' && s.price_cents);
  // Serviço de oficina/dealer: junta o nome da empresa do solicitante.
  const companies = new Map();
  const companyOf = (contactId) => {
    if (!contactId || !ctx.api.empresas) return null;
    if (!companies.has(contactId)) companies.set(contactId, ctx.api.empresas.forContact(contactId));
    return companies.get(contactId);
  };
  return services
    .map((s) => {
      const days = daysSince(s.completed_at || s.created_at);
      const company = companyOf(s.contact_id);
      return { ...s, ...balance(ctx, s), days, overdue: days >= ctx.config.overdueDays, company_id: company?.id || null, company_name: company?.name || null };
    })
    .filter((s) => s.open_cents > 0 || s.to_receive_cents > 0)
    .sort((a, b) => b.days - a.days || a.id - b.id);
}

// Busca nas pendências: nome, carro, placa, seguradora ou final do celular (ex.: "2697").
function searchPending(list, text) {
  const words = simplify(text || '').split(' ').filter(Boolean);
  if (!words.length) return list;
  const found = list.filter((s) =>
    words.every((w) => simplify([s.company_name, s.contact_name, s.vehicle, s.plate, s.vin, s.payer].filter(Boolean).join(' ')).includes(w) || (/^\d{3,}$/.test(w) && String(s.contact_phone || '').includes(w)))
  );
  // Cliente de empresa: a conta é da empresa, então vem tudo o que a empresa deve (pedido do Caningado 22/10).
  const firms = new Set(found.map((s) => s.company_id).filter(Boolean));
  return firms.size ? list.filter((s) => found.includes(s) || firms.has(s.company_id)) : found;
}

// Alerta de cobrança atrasada (aviso da manhã e topo do painel).
function alerts({ ctx, user }) {
  const late = pendingList(ctx, user.role === 'dono' ? null : user.id).filter((s) => s.overdue);
  if (!late.length) return [];
  const clients = late.filter((s) => s.open_cents > 0);
  const insurers = late.filter((s) => s.to_receive_cents > 0);
  const out = [];
  // Os 5 mais atrasados pelo nome, para o ADM saber quem cobrar.
  const names = (list, cents, who) => {
    const shown = list.slice(0, 5).map((s) => `${who(s)} ${formatMoney(cents(s))} (${s.days}d)`);
    return ` – ${shown.join('; ')}${list.length > 5 ? `; e mais ${list.length - 5}` : ''}`;
  };
  if (clients.length) {
    const total = clients.reduce((sum, s) => sum + s.open_cents, 0);
    out.push({ text: `💰 ${clients.length} cliente(s) devendo há mais de ${ctx.config.overdueDays} dias: ${formatMoney(total)}${names(clients, (s) => s.open_cents, (s) => s.company_name || s.contact_name || s.vehicle || `#${s.id}`)}`, href: '#/pendentes' });
  }
  if (insurers.length) {
    const total = insurers.reduce((sum, s) => sum + s.to_receive_cents, 0);
    out.push({ text: `🧾 ${insurers.length} serviço(s) de seguradora sem pagar há mais de ${ctx.config.overdueDays} dias: ${formatMoney(total)}${names(insurers, (s) => s.to_receive_cents, (s) => s.payer || 'seguradora')}`, href: '#/pendentes' });
  }
  return out;
}

const commands = [
  {
    names: ['pago', 'recebi', 'pagou'],
    help: '*pago 250 zelle* – registrar pagamento (zelle, dinheiro, cartão, cheque, seguradora, aaa...)',
    async run({ ctx, user, args }) {
      const service = ctx.data.services.active(user);
      if (!service) return 'Nenhum serviço em andamento. Mande *abrir 12* para escolher o serviço.';
      let amountCents = null;
      let method = null;
      const rest = [];
      for (const arg of args) {
        const m = !method && parseMethod(arg);
        if (m) method = m;
        else if (amountCents == null && /\d/.test(arg)) amountCents = parseMoney(arg);
        else rest.push(arg);
      }
      if (!method) return 'Faltou a forma de pagamento. Ex: *pago 250 zelle*, *pago 100 dinheiro*, *pago 300 aaa*';
      if (amountCents == null) amountCents = balance(ctx, service).open_cents;
      if (!amountCents) return 'Faltou o valor. Ex: *pago 250 zelle*';
      try {
        checkMoney(amountCents, { max: 20000, what: 'O valor do pagamento' });
      } catch (err) {
        if (err instanceof ValidationError) return `⚠️ ${err.message}`;
        throw err;
      }
      const payer = method.payer || (method.method === 'seguradora' && rest.length ? rest.join(' ') : null);
      const payment = addPayment(ctx, { serviceId: service.id, amountCents, method: method.method, payer, userId: user.id });
      await notifyPayments(ctx, [{ service, payment }], user.id);
      const b = balance(ctx, service);
      const what =
        payment.status === 'a_receber'
          ? `🧾 ${formatMoney(amountCents)} a receber de ${payer || 'seguradora'} no serviço #${ctx.data.services.ref(service, user)}.`
          : `💵 ${formatMoney(amountCents)} recebido por ${METHODS[payment.method]} no serviço #${ctx.data.services.ref(service, user)}.`;
      const left = b.open_cents > 0 ? `\nAinda falta ${formatMoney(b.open_cents)}.` : service.price_cents ? '\nServiço quitado ✅' : '';
      return what + left;
    },
  },
  {
    names: ['cobrar', 'cobranca'],
    help: '*cobrar* – mensagem pronta com o Zelle (e link do cartão) para mandar ao cliente',
    async run({ ctx, user }) {
      const service = ctx.data.services.active(user);
      if (!service) return 'Nenhum serviço em andamento. Mande *abrir 12* para escolher o serviço.';
      const amount = balance(ctx, service).open_cents;
      if (!amount) return service.price_cents ? 'Esse serviço já está pago.' : 'Esse serviço ainda não tem valor.';
      return ['Encaminhe esta mensagem para o cliente:', chargeMessage(ctx, service, amount, await cardLink(ctx, service, amount))];
    },
  },
  {
    names: ['link', 'cartao'],
    help: '*link* – link do Square para o cliente pagar com cartão (valor + taxa)',
    async run({ ctx, user }) {
      if (!ctx.square?.configured) return 'O Square ainda não está ligado (SQUARE_ACCESS_TOKEN no Render).';
      const service = ctx.data.services.active(user);
      if (!service) return 'Nenhum serviço em andamento. Mande *abrir 12* para escolher o serviço.';
      const amount = balance(ctx, service).open_cents;
      if (!amount) return service.price_cents ? 'Esse serviço já está pago.' : 'Esse serviço ainda não tem valor.';
      const card = await cardLink(ctx, service, amount);
      if (!card) return 'O Square não criou o link agora. Tente de novo daqui a pouco.';
      return ['Encaminhe esta mensagem para o cliente:', cardMessage(ctx, service, card)];
    },
  },
  {
    names: ['pendentes', 'receber'],
    help: '*pendentes* – serviços com dinheiro para receber (*pendentes Ana* procura pelo nome, carro ou placa)',
    run({ ctx, user, args }) {
      const all = pendingList(ctx, user.role === 'dono' ? null : user.id);
      if (!all.length) return 'Nada pendente. 👍';
      const words = simplify(args.join(' ')).split(' ').filter(Boolean);
      const list = searchPending(all, args.join(' '));
      if (!list.length) return `Ninguém com "${args.join(' ')}" devendo. 👍`;
      const lines = list.slice(0, 20).map((s) => {
        const parts = [];
        if (s.open_cents) parts.push(`falta ${formatMoney(s.open_cents)}`);
        if (s.to_receive_cents) parts.push(`${s.payer || 'seguradora'} ${formatMoney(s.to_receive_cents)}`);
        const age = s.days === 0 ? 'hoje' : s.days === 1 ? 'há 1 dia' : `há ${s.days} dias`;
        return `${s.overdue ? '⚠️ ' : ''}${user.role === 'dono' ? `#${s.id} ` : ''}${s.company_name ? `🏢 ${s.company_name}${s.contact_name && s.contact_name !== s.company_name ? ` (${s.contact_name})` : ''}` : s.contact_name || ''} – ${parts.join(', ')} (${age})`;
      });
      const late = list.filter((s) => s.overdue).length;
      const head = late ? `*Pendentes* (⚠️ ${late} atrasado(s), mais de ${ctx.config.overdueDays} dias)` : '*Pendentes*';
      const owed = list.reduce((sum, s) => sum + s.open_cents, 0);
      const total = words.length && owed ? [`*Total que deve: ${formatMoney(owed)}*`] : [];
      return [head, ...lines, ...total, '', `Para cobrar: *abrir ${list[0].id}* e depois *cobrar*.`].join('\n');
    },
  },
  {
    names: ['caixa', 'maos', 'dinheiro'],
    help: '*caixa* – quanto dinheiro/cheque está em mãos com cada motorista',
    run({ ctx, user }) {
      const list = cashInHand(ctx, user.role === 'dono' ? null : user.id);
      if (!list.length) return 'Nenhum motorista com dinheiro em mãos. 👍';
      const lines = list.map((d) => {
        const last = d.last_collection ? ` (último recolhimento ${daysAgo(d.last_collection.created_at)})` : '';
        return `💵 ${d.name}: ${formatMoney(d.in_hand_cents)}${last}`;
      });
      if (user.role === 'dono') lines.push('', 'Quando pegar o dinheiro, mande *recolhi Nome* (ou *recolhi 200 Nome* se pegou só uma parte).');
      return ['*Dinheiro em mãos*', ...lines].join('\n');
    },
  },
  {
    names: ['recolhi', 'recolher'],
    help: '*recolhi Jorge* – (ADM) pegou o dinheiro do motorista: zera o que ele tem em mãos',
    run({ ctx, user, args }) {
      if (user.role !== 'dono') return 'Só o ADM registra o recolhimento. Mande *caixa* para ver quanto está com você.';
      let amountCents = null;
      const words = [];
      for (const arg of args) {
        if (amountCents == null && /\d/.test(arg)) amountCents = parseMoney(arg);
        else words.push(arg);
      }
      const name = simplify(words.join(' '));
      const all = cashInHand(ctx);
      const matches = name ? all.filter((d) => simplify(d.name).split(' ').some((w) => w.startsWith(name)) || simplify(d.name).startsWith(name)) : [];
      if (matches.length !== 1) {
        const options = all.filter((d) => d.in_hand_cents > 0).map((d) => `${d.name.split(' ')[0]} (${formatMoney(d.in_hand_cents)})`);
        const hint = options.length ? `\nCom dinheiro em mãos: ${options.join(', ')}` : '';
        return `${matches.length ? 'Mais de um motorista com esse nome.' : 'De qual motorista?'} Ex: *recolhi Jorge*${hint}`;
      }
      const driver = matches[0];
      if (amountCents == null) amountCents = driver.in_hand_cents;
      if (amountCents <= 0) return `${driver.name} não tem dinheiro em mãos. 👍`;
      try {
        checkMoney(amountCents, { max: 100000, what: 'O valor recolhido' });
      } catch (err) {
        if (err instanceof ValidationError) return `⚠️ ${err.message}`;
        throw err;
      }
      const after = collectCash(ctx, { driverId: driver.driver_id, amountCents, ownerId: user.id });
      const left = after.in_hand_cents ? `Ainda fica com ${driver.name}: ${formatMoney(after.in_hand_cents)}.` : `${driver.name} agora está zerado. ✅`;
      return `💵 Recolhido ${formatMoney(amountCents)} de ${driver.name}.\n${left}`;
    },
  },
  {
    names: ['recebidos', 'conferir'],
    help: '*recebidos* – (ADM) pagamentos de hoje de serviços de dias anteriores, para conferir com o caixa e o banco',
    run({ ctx, user, args }) {
      if (user.role !== 'dono') return 'Só o ADM vê essa lista.';
      let dia;
      if (simplify(args.join(' ')) === 'ontem') dia = new Intl.DateTimeFormat('en-CA', { timeZone: ctx.config.timeZone }).format(new Date(Date.now() - 86400000));
      const r = receivedEarlier(ctx, dia);
      const when = dia ? 'ontem' : 'hoje';
      if (!r.list.length) return `Nenhum pagamento recebido ${when} de serviços de dias anteriores. 👍`;
      const date = (iso) => new Intl.DateTimeFormat('pt-BR', { timeZone: ctx.config.timeZone, day: '2-digit', month: '2-digit' }).format(new Date(iso));
      const lines = r.list.map(
        (p) => `• #${p.service_id} ${p.contact_name || p.vehicle || ''} (serviço de ${date(p.service_created_at)}) – ${formatMoney(p.amount_cents)} ${METHODS[p.method]}${p.payer ? ` (${p.payer})` : ''}${p.received_by_name ? ` – ${p.received_by_name}` : ''}`
      );
      const totals = Object.entries(r.by_method).map(([m, v]) => `  ${METHODS[m]}: ${formatMoney(v)}`);
      return [`*Recebidos ${when} de serviços anteriores*`, ...lines, '', '*Total por forma*', ...totals, `*Total: ${formatMoney(r.total_cents)}*`].join('\n');
    },
  },
];

function canSee(user, service) {
  return service && (user.role === 'dono' || service.driver_id === user.id);
}

function listPayments(ctx, serviceId) {
  return ctx.db
    .prepare('SELECT p.*, u.name AS received_by_name FROM payments p LEFT JOIN users u ON u.id = p.received_by WHERE service_id = ? ORDER BY p.id')
    .all(serviceId);
}

// Dia no fuso da empresa (AAAA-MM-DD) -> início e fim em ISO. Sem dia válido, usa hoje.
function dayRange(ctx, dia) {
  const tz = ctx.config.timeZone;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(dia || '')) ? String(dia) : today;
  const [y, m, d] = day.split('-').map(Number);
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) throw new HttpError(400, 'Data inválida.');
  // Meio-dia UTC ainda é o mesmo dia no fuso dos EUA.
  return { day, today, start: startOfDayIso(tz, new Date(Date.UTC(y, m - 1, d, 12))), end: startOfDayIso(tz, new Date(Date.UTC(y, m - 1, d + 1, 12))) };
}

// Pagamentos recebidos no dia de serviços abertos antes desse dia: para o ADM conferir com o caixa e o banco.
function receivedEarlier(ctx, dia) {
  const { day, today, start, end } = dayRange(ctx, dia);
  const list = ctx.db
    .prepare(
      `SELECT p.id, p.service_id, p.amount_cents, p.method, p.payer, p.received_at, s.created_at AS service_created_at,
              c.name AS contact_name, s.vehicle, u.name AS received_by_name
       FROM payments p JOIN services s ON s.id = p.service_id
       LEFT JOIN contacts c ON c.id = s.contact_id LEFT JOIN users u ON u.id = p.received_by
       WHERE p.status = 'recebido' AND p.received_at >= ? AND p.received_at < ? AND s.created_at < ?
       ORDER BY p.received_at, p.id`
    )
    .all(start, end, start);
  const byMethod = {};
  for (const p of list) byMethod[p.method] = (byMethod[p.method] || 0) + p.amount_cents;
  return { day, today, list, by_method: byMethod, total_cents: list.reduce((sum, p) => sum + p.amount_cents, 0) };
}

// Pagamentos para o ADM conferir: recebidos e ainda sem OK, menos os de serviço feito no mesmo dia do pagamento.
function toCheck(ctx) {
  const day = dayFormatter(ctx.config.timeZone);
  return ctx.db
    .prepare(
      `SELECT p.id, p.service_id, p.amount_cents, p.method, p.payer, p.received_at, s.created_at AS service_created_at, s.completed_at AS service_completed_at,
              c.name AS contact_name, s.vehicle, u.name AS received_by_name
       FROM payments p JOIN services s ON s.id = p.service_id
       LEFT JOIN contacts c ON c.id = s.contact_id LEFT JOIN users u ON u.id = p.received_by
       WHERE p.status = 'recebido' AND p.checked_at IS NULL
       ORDER BY p.received_at, p.id`
    )
    .all()
    .filter((p) => {
      const paid = day(p.received_at);
      return paid !== day(p.service_created_at) && (!p.service_completed_at || paid !== day(p.service_completed_at));
    });
}

function routes(api, ctx) {
  api.post('/services/:id/payments', async (req, res) => {
    const service = ctx.data.services.get(Number(req.params.id));
    if (!canSee(req.user, service)) throw new HttpError(404, 'Serviço não encontrado.');
    const { amount, method, payer } = req.body || {};
    const amountCents = checkMoney(parseMoney(amount), { max: 20000, what: 'O valor do pagamento' });
    if (!METHODS[method]) throw new HttpError(400, 'Forma de pagamento inválida.');
    const payment = addPayment(ctx, { serviceId: service.id, amountCents, method, payer, userId: req.user.id });
    await notifyPayments(ctx, [{ service, payment }], req.user.id);
    res.status(201).json(payment);
  });

  // Seguradora pagou: marca como recebido.
  api.patch('/payments/:id', async (req, res) => {
    const payment = ctx.db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(req.params.id));
    const service = payment && ctx.data.services.get(payment.service_id);
    if (!payment || !canSee(req.user, service)) throw new HttpError(404, 'Pagamento não encontrado.');
    if (req.body?.status === 'recebido' && payment.status !== 'recebido') {
      ctx.db.prepare("UPDATE payments SET status = 'recebido', received_at = ?, received_by = ? WHERE id = ?").run(nowIso(), req.user.id, payment.id);
      await notifyPayments(ctx, [{ service, payment: ctx.db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id) }], req.user.id);
    }
    res.json(ctx.db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id));
  });

  api.delete('/payments/:id', (req, res) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o ADM pode apagar pagamentos.');
    ctx.db.prepare('DELETE FROM payments WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // Baixa em vários serviços de uma vez, com a mesma forma. Sem valor, paga o que falta em cada um.
  // Com valor (ex.: cliente pagou $200 para 3 serviços), quita os mais antigos primeiro e o resto fica parcial.
  api.post('/payments/lote', async (req, res) => {
    const { service_ids: ids, method, amount } = req.body || {};
    if (!METHODS[method] || method === 'seguradora') throw new HttpError(400, 'Forma de pagamento inválida.');
    if (!Array.isArray(ids) || !ids.length || ids.length > 200) throw new HttpError(400, 'Escolha os serviços.');
    const services = [...new Set(ids.map(Number))]
      .map((id) => ctx.data.services.get(id))
      .filter((s) => canSee(req.user, s) && s.status !== 'cancelado')
      .sort((a, b) => a.id - b.id)
      .map((s) => ({ service: s, open: balance(ctx, s).open_cents }))
      .filter((x) => x.open > 0);
    const owed = services.reduce((sum, x) => sum + x.open, 0);
    let left = owed;
    if (amount != null && amount !== '') {
      left = checkMoney(parseMoney(amount), { max: 100000, what: 'O valor pago' });
      if (left > owed) throw new HttpError(400, `O valor é maior do que falta nesses serviços (${formatMoney(owed)}).`);
    }
    const done = [];
    for (const { service, open } of services) {
      if (left <= 0) break;
      const pay = Math.min(open, left);
      left -= pay;
      done.push({ ...addPayment(ctx, { serviceId: service.id, amountCents: pay, method, userId: req.user.id }), quitado: pay === open, service });
    }
    await notifyPayments(ctx, done.map(({ service, ...payment }) => ({ service, payment })), req.user.id);
    res.status(201).json({
      count: done.length,
      total_cents: done.reduce((sum, p) => sum + p.amount_cents, 0),
      partial: done.filter((p) => !p.quitado).map((p) => p.service_id),
      still_open_cents: owed - done.reduce((sum, p) => sum + p.amount_cents, 0),
    });
  });

  api.get('/payments/conferir', (req, res) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o ADM confere os pagamentos.');
    res.json(toCheck(ctx));
  });
  api.post('/payments/:id/ok', (req, res) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o ADM confere os pagamentos.');
    const info = ctx.db.prepare("UPDATE payments SET checked_at = ?, checked_by = ? WHERE id = ? AND status = 'recebido' AND checked_at IS NULL").run(nowIso(), req.user.id, Number(req.params.id));
    if (!info.changes) throw new HttpError(404, 'Pagamento não encontrado ou já conferido.');
    res.json({ ok: true });
  });

  api.get('/payments/recebidos', (req, res) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o ADM vê essa lista.');
    res.json(receivedEarlier(ctx, req.query.dia));
  });

  // Lista de pendências em PDF (com a mesma busca da tela).
  api.get('/payments/pending.pdf', async (req, res) => {
    const owner = req.user.role === 'dono';
    const search = String(req.query.q || '').trim();
    const day = dayFormatter(ctx.config.timeZone);
    const list = searchPending(pendingList(ctx, owner ? null : req.user.id), search)
      .sort((a, b) => b.days - a.days || a.id - b.id)
      .map((s) => ({
        ...s,
        day: day(s.completed_at || s.created_at),
        paid_list: listPayments(ctx, s.id)
          .filter((p) => p.status === 'recebido')
          .map((p) => ({ day: day(p.received_at), method: METHODS[p.method] || p.method, payer: p.payer, amount_cents: p.amount_cents })),
      }));
    const pdf = await renderPendingList({
      // Sem o nome do contato no cabeçalho (pedido do Caningado 21/10): só empresa, telefone e e-mail.
      company: { ...(ctx.api.invoice?.getCompany() || { name: ctx.config.companyName }), contact: null },
      logo: ctx.api.invoice ? ctx.api.invoice.logo() : null,
      list,
      today: day(),
      search,
      // Sem o nº do serviço no PDF (pedido do Caningado 22/10): ele vai para fora.
      showIds: false,
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="Pendencias${search ? ' ' + search.replace(/[^\w -]/g, '') : ''}.pdf"`);
    res.set('Cache-Control', 'no-store');
    res.send(pdf);
  });

  api.get('/payments/pending', (req, res) => {
    res.json(pendingList(ctx, req.user.role === 'dono' ? null : req.user.id));
  });

  // Dinheiro em mãos: o dono vê todos os motoristas, o motorista só o dele.
  api.get('/caixa', (req, res) => {
    res.json(cashInHand(ctx, req.user.role === 'dono' ? null : req.user.id));
  });

  // Dono pegou o dinheiro: sem valor, recolhe tudo (zera).
  api.post('/caixa/:driverId/recolher', (req, res) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o ADM pode fazer isso.');
    const [driver] = cashInHand(ctx, Number(req.params.driverId));
    if (!driver) throw new HttpError(404, 'Motorista não encontrado.');
    const raw = req.body?.amount;
    const amountCents = raw == null || raw === '' ? driver.in_hand_cents : checkMoney(parseMoney(raw), { max: 100000, what: 'O valor recolhido' });
    if (amountCents <= 0) throw new HttpError(400, 'Esse motorista não tem dinheiro em mãos.');
    res.status(201).json(collectCash(ctx, { driverId: driver.driver_id, amountCents, ownerId: req.user.id }));
  });

  api.get('/services/:id/charge', async (req, res) => {
    const service = ctx.data.services.get(Number(req.params.id));
    if (!canSee(req.user, service)) throw new HttpError(404, 'Serviço não encontrado.');
    const amount = balance(ctx, service).open_cents;
    const card = amount ? await cardLink(ctx, service, amount) : null;
    res.json({ amount_cents: amount, message: amount ? chargeMessage(ctx, service, amount, card) : null });
  });

  // Botão "Link do cartão": valor que falta + taxa do cartão.
  api.post('/services/:id/square-link', async (req, res) => {
    const service = ctx.data.services.get(Number(req.params.id));
    if (!canSee(req.user, service)) throw new HttpError(404, 'Serviço não encontrado.');
    if (!ctx.square?.configured) throw new HttpError(400, 'O Square ainda não está ligado (SQUARE_ACCESS_TOKEN no Render).');
    const amount = balance(ctx, service).open_cents;
    if (!amount) throw new HttpError(400, 'Esse serviço não tem valor para receber.');
    const card = await cardLink(ctx, service, amount);
    if (!card) throw new HttpError(502, 'O Square não criou o link agora. Tente de novo daqui a pouco.');
    // QR code para o cliente pagar na hora, com a câmera do celular dele.
    let qr = null;
    try {
      qr = await qrSvg(card.url);
    } catch (err) {
      ctx.log('Não consegui gerar o QR code do link', err.message);
    }
    res.json({ ...card, qr_svg: qr, message: cardMessage(ctx, service, card), fee: cardFee(ctx) });
  });
}

function publicRoutes(app, ctx) {
  // Aviso do Square quando o cliente paga pelo link. Só vale com a chave de assinatura.
  app.post('/webhook/square', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const key = ctx.config.square.webhookKey;
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const url = `https://${req.get('host')}${req.originalUrl}`;
    if (!key || !validSquareSignature({ key, url, rawBody: raw, header: req.get('x-square-hmacsha256-signature') })) {
      ctx.log('Square: aviso de pagamento com assinatura errada. Confira o SQUARE_WEBHOOK_KEY no Render.');
      return res.sendStatus(401);
    }
    res.sendStatus(200);
    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    squarePaid(ctx, event?.data?.object?.payment).catch((err) => ctx.log('Square: erro ao registrar pagamento', err));
  });
}

function summary({ ctx, since, userId }) {
  const params = [since];
  let filter = '';
  if (userId) {
    filter = 'AND p.received_by = ?';
    params.push(userId);
  }
  const rows = ctx.db
    .prepare(
      `SELECT p.method, p.received_by, u.name, SUM(p.amount_cents) AS total
       FROM payments p LEFT JOIN users u ON u.id = p.received_by
       WHERE p.status = 'recebido' AND p.received_at >= ? ${filter}
       GROUP BY p.method, p.received_by`
    )
    .all(...params);
  const byMethod = {};
  const cashByDriver = {};
  let received = 0;
  for (const r of rows) {
    received += r.total;
    byMethod[r.method] = (byMethod[r.method] || 0) + r.total;
    if (r.method === 'dinheiro') cashByDriver[r.name || '?'] = (cashByDriver[r.name || '?'] || 0) + r.total;
  }
  const pending = pendingList(ctx, userId);
  return {
    received_cents: received,
    received_by_method: byMethod,
    cash_by_driver: cashByDriver,
    open_cents: pending.reduce((s, p) => s + p.open_cents, 0),
    to_receive_cents: pending.reduce((s, p) => s + p.to_receive_cents, 0),
  };
}

function summaryLines(s) {
  const lines = [`Recebido: ${formatMoney(s.received_cents)}`];
  for (const [method, total] of Object.entries(s.received_by_method || {})) lines.push(`  • ${METHODS[method]}: ${formatMoney(total)}`);
  for (const [name, total] of Object.entries(s.cash_by_driver || {})) lines.push(`💵 Recebido em dinheiro por ${name}: ${formatMoney(total)}`);
  if (s.open_cents) lines.push(`Falta receber de clientes: ${formatMoney(s.open_cents)}`);
  if (s.to_receive_cents) lines.push(`A receber de seguradoras: ${formatMoney(s.to_receive_cents)}`);
  return lines;
}

// Planilha: colunas de pagamento na aba Serviços e a aba Pagamentos.
function exportColumns(ctx) {
  const cache = new Map();
  const of = (s) => (cache.has(s.id) ? cache.get(s.id) : cache.set(s.id, balance(ctx, s)).get(s.id));
  return [
    { header: 'Recebido', width: 11, type: 'money', value: (s) => of(s).received_cents / 100 },
    { header: 'A receber (seguradora)', width: 14, type: 'money', value: (s) => of(s).to_receive_cents / 100 },
    { header: 'Falta receber', width: 11, type: 'money', value: (s) => (s.status === 'cancelado' ? 0 : of(s).open_cents / 100) },
  ];
}

function exportSheets({ ctx, from, to, userId }) {
  const where = ['p.created_at >= ?', 'p.created_at < ?'];
  const params = [from, to];
  if (userId) {
    where.push('s.driver_id = ?');
    params.push(userId);
  }
  const rows = ctx.db
    .prepare(
      `SELECT p.*, c.name AS contact_name, u.name AS received_by_name
       FROM payments p JOIN services s ON s.id = p.service_id
       LEFT JOIN contacts c ON c.id = s.contact_id LEFT JOIN users u ON u.id = p.received_by
       WHERE ${where.join(' AND ')} ORDER BY p.id`
    )
    .all(...params);
  return [
    {
      name: 'Pagamentos',
      columns: [
        { header: 'Data', width: 17, type: 'date' },
        { header: 'Serviço nº', width: 10, type: 'number' },
        { header: 'Cliente', width: 22 },
        { header: 'Valor', width: 11, type: 'money' },
        { header: 'Forma', width: 22 },
        { header: 'Situação', width: 12 },
        { header: 'Quem pagou', width: 16 },
        { header: 'Recebido por', width: 14 },
        { header: 'Recebido em', width: 17, type: 'date' },
      ],
      rows: rows.map((p) => [
        p.created_at,
        p.service_id,
        p.contact_name,
        p.amount_cents / 100,
        METHODS[p.method] || p.method,
        p.status === 'recebido' ? 'Recebido' : 'A receber',
        p.payer,
        p.received_by_name,
        p.received_at,
      ]),
    },
  ];
}

export default {
  name: 'pagamentos',
  alerts,
  exportColumns,
  exportSheets,
  label: 'Pagamentos',
  migrations,
  commands,
  routes,
  publicRoutes,
  summary,
  summaryLines,
  serviceHint: '💵 Pagamento: *pago 250 zelle* (ou dinheiro, cartão, cheque, aaa...). Para cobrar o cliente: *cobrar*.',
  serviceDetail: ({ ctx, service }) => ({ payments: listPayments(ctx, service.id), balance: balance(ctx, service), square: Boolean(ctx.square?.configured) }),
  async daily({ ctx }) {
    try {
      await updateCardFee(ctx);
    } catch (err) {
      ctx.log('Square: não consegui atualizar a taxa do cartão', err.message);
    }
  },
  onServiceDone({ ctx, service }) {
    const open = balance(ctx, service).open_cents;
    return open ? [`⚠️ Falta receber ${formatMoney(open)}. Mande *pago ${open / 100} zelle* quando receber, ou *cobrar*.`] : [];
  },
  setup(ctx) {
    ctx.square = createSquare(ctx.config.square);
    ctx.api.pagamentos = { balance: (service) => balance(ctx, service), methods: METHODS };
  },
};
