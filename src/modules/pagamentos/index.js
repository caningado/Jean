// Módulo de pagamentos: Zelle, dinheiro, cartão, cheque e seguradora/motor club.
// Guarda quem recebeu (para saber quanto dinheiro está com cada motorista) e o que falta receber.
import { parseMoney, formatMoney, simplify, nowIso, HttpError } from '../../lib/util.js';

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
];

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
  const now = nowIso();
  const info = ctx.db
    .prepare('INSERT INTO payments (service_id, amount_cents, method, status, payer, received_by, created_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(serviceId, amountCents, method, status, payer, status === 'recebido' ? userId : null, now, status === 'recebido' ? now : null);
  return ctx.db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(info.lastInsertRowid));
}

// Mensagem pronta para o motorista encaminhar ao cliente (em inglês, pois o cliente está nos EUA).
export function chargeMessage(ctx, service, amountCents) {
  const { name, contact } = ctx.config.zelle;
  const greeting = service.contact_name ? `Hi ${service.contact_name.split(' ')[0]}!` : 'Hi!';
  const zelle = contact ? `\nYou can pay with Zelle to ${name || ctx.config.companyName} (${contact}).` : '';
  return `${greeting} The total for your tow service #${service.id} is ${formatMoney(amountCents)}.${zelle}\nThank you! – ${ctx.config.companyName}`;
}

function pendingList(ctx, userId) {
  const services = ctx.data.services
    .list({ driverId: userId, limit: 1000 })
    .filter((s) => s.status !== 'cancelado' && s.price_cents);
  return services
    .map((s) => ({ ...s, ...balance(ctx, s) }))
    .filter((s) => s.open_cents > 0 || s.to_receive_cents > 0);
}

const commands = [
  {
    names: ['pago', 'recebi', 'pagou'],
    help: '*pago 250 zelle* – registrar pagamento (zelle, dinheiro, cartão, cheque, seguradora, aaa...)',
    run({ ctx, user, args }) {
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
      const payer = method.payer || (method.method === 'seguradora' && rest.length ? rest.join(' ') : null);
      const payment = addPayment(ctx, { serviceId: service.id, amountCents, method: method.method, payer, userId: user.id });
      const b = balance(ctx, service);
      const what =
        payment.status === 'a_receber'
          ? `🧾 ${formatMoney(amountCents)} a receber de ${payer || 'seguradora'} no serviço #${service.id}.`
          : `💵 ${formatMoney(amountCents)} recebido por ${METHODS[payment.method]} no serviço #${service.id}.`;
      const left = b.open_cents > 0 ? `\nAinda falta ${formatMoney(b.open_cents)}.` : service.price_cents ? '\nServiço quitado ✅' : '';
      return what + left;
    },
  },
  {
    names: ['cobrar', 'cobranca'],
    help: '*cobrar* – mensagem pronta com o Zelle para mandar ao cliente',
    run({ ctx, user }) {
      const service = ctx.data.services.active(user);
      if (!service) return 'Nenhum serviço em andamento. Mande *abrir 12* para escolher o serviço.';
      const amount = balance(ctx, service).open_cents;
      if (!amount) return service.price_cents ? 'Esse serviço já está pago.' : 'Esse serviço ainda não tem valor.';
      return ['Encaminhe esta mensagem para o cliente:', chargeMessage(ctx, service, amount)];
    },
  },
  {
    names: ['pendentes', 'receber'],
    help: '*pendentes* – serviços com dinheiro para receber',
    run({ ctx, user }) {
      const list = pendingList(ctx, user.role === 'dono' ? null : user.id);
      if (!list.length) return 'Nada pendente. 👍';
      const lines = list.slice(0, 20).map((s) => {
        const parts = [];
        if (s.open_cents) parts.push(`falta ${formatMoney(s.open_cents)}`);
        if (s.to_receive_cents) parts.push(`seguradora ${formatMoney(s.to_receive_cents)}`);
        return `#${s.id} ${s.contact_name || ''} – ${parts.join(', ')}`;
      });
      return ['*Pendentes*', ...lines].join('\n');
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

function routes(api, ctx) {
  api.post('/services/:id/payments', (req, res) => {
    const service = ctx.data.services.get(Number(req.params.id));
    if (!canSee(req.user, service)) throw new HttpError(404, 'Serviço não encontrado.');
    const { amount, method, payer } = req.body || {};
    const amountCents = parseMoney(amount);
    if (!amountCents) throw new HttpError(400, 'Informe o valor.');
    if (!METHODS[method]) throw new HttpError(400, 'Forma de pagamento inválida.');
    res.status(201).json(addPayment(ctx, { serviceId: service.id, amountCents, method, payer, userId: req.user.id }));
  });

  // Seguradora pagou: marca como recebido.
  api.patch('/payments/:id', (req, res) => {
    const payment = ctx.db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(req.params.id));
    if (!payment || !canSee(req.user, ctx.data.services.get(payment.service_id))) throw new HttpError(404, 'Pagamento não encontrado.');
    if (req.body?.status === 'recebido' && payment.status !== 'recebido') {
      ctx.db.prepare("UPDATE payments SET status = 'recebido', received_at = ?, received_by = ? WHERE id = ?").run(nowIso(), req.user.id, payment.id);
    }
    res.json(ctx.db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id));
  });

  api.delete('/payments/:id', (req, res) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o dono pode apagar pagamentos.');
    ctx.db.prepare('DELETE FROM payments WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  api.get('/payments/pending', (req, res) => {
    res.json(pendingList(ctx, req.user.role === 'dono' ? null : req.user.id));
  });

  api.get('/services/:id/charge', (req, res) => {
    const service = ctx.data.services.get(Number(req.params.id));
    if (!canSee(req.user, service)) throw new HttpError(404, 'Serviço não encontrado.');
    const amount = balance(ctx, service).open_cents;
    res.json({ amount_cents: amount, message: amount ? chargeMessage(ctx, service, amount) : null });
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
  for (const [name, total] of Object.entries(s.cash_by_driver || {})) lines.push(`💵 Dinheiro com ${name}: ${formatMoney(total)}`);
  if (s.open_cents) lines.push(`Falta receber de clientes: ${formatMoney(s.open_cents)}`);
  if (s.to_receive_cents) lines.push(`A receber de seguradoras: ${formatMoney(s.to_receive_cents)}`);
  return lines;
}

export default {
  name: 'pagamentos',
  label: 'Pagamentos',
  migrations,
  commands,
  routes,
  summary,
  summaryLines,
  serviceHint: '💵 Pagamento: *pago 250 zelle* (ou dinheiro, cartão, cheque, aaa...). Para cobrar o cliente: *cobrar*.',
  serviceDetail: ({ ctx, service }) => ({ payments: listPayments(ctx, service.id), balance: balance(ctx, service) }),
  onServiceDone({ ctx, service }) {
    const open = balance(ctx, service).open_cents;
    return open ? [`⚠️ Falta receber ${formatMoney(open)}. Mande *pago ${open / 100} zelle* quando receber, ou *cobrar*.`] : [];
  },
  setup(ctx) {
    ctx.api.pagamentos = { balance: (service) => balance(ctx, service), methods: METHODS };
  },
};
