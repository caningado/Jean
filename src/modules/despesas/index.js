// Módulo de despesas: combustível, pedágio, manutenção etc., por motorista.
import { parseMoney, formatMoney, simplify, nowIso, HttpError } from '../../lib/util.js';
import { checkMoney, ValidationError } from '../../lib/validate.js';

export const CATEGORIES = {
  combustivel: 'Combustível',
  pedagio: 'Pedágio',
  manutencao: 'Manutenção',
  alimentacao: 'Alimentação',
  outros: 'Outros',
};

const migrations = [
  `CREATE TABLE expenses (
     id INTEGER PRIMARY KEY,
     user_id INTEGER REFERENCES users(id),
     service_id INTEGER REFERENCES services(id),
     amount_cents INTEGER NOT NULL,
     category TEXT NOT NULL,
     description TEXT,
     created_at TEXT NOT NULL
   );
   CREATE INDEX expenses_date ON expenses(created_at);`,
  // Caminhão da despesa (módulo manutencao), para o extrato de cada caminhão.
  `ALTER TABLE expenses ADD COLUMN truck_id INTEGER;`,
];

const KEYWORDS = [
  ['combustivel', /(diesel|gasolina|gas|combustivel|fuel|abasteci|posto)/],
  ['pedagio', /(pedagio|toll|ezpass|e-zpass|sunpass)/],
  ['manutencao', /(oleo|pneu|mecanico|manutencao|oficina|peca|freio|oil|tire|repair)/],
  ['alimentacao', /(almoco|janta|lanche|comida|cafe|food|lunch)/],
];

export function guessCategory(text) {
  const s = simplify(text);
  for (const [category, re] of KEYWORDS) if (re.test(s)) return category;
  return 'outros';
}

function addExpense(ctx, { userId, serviceId = null, amountCents, category, description, truckId }) {
  // Sem caminhão escolhido: vai para o caminhão do motorista.
  if (truckId === undefined) truckId = ctx.api.manutencao?.truckFor(userId)?.id ?? null;
  const info = ctx.db
    .prepare('INSERT INTO expenses (user_id, service_id, amount_cents, category, description, truck_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, serviceId, amountCents, category, description || null, truckId || null, nowIso());
  return ctx.db.prepare('SELECT * FROM expenses WHERE id = ?').get(Number(info.lastInsertRowid));
}

const commands = [
  {
    names: ['gasto', 'gastei', 'despesa', 'abasteci'],
    help: '*gasto 80 diesel* – registrar uma despesa',
    run({ ctx, user, args, text }) {
      const amountArg = args.find((a) => /\d/.test(a));
      const amountCents = parseMoney(amountArg);
      if (!amountCents) return 'Faltou o valor. Ex: *gasto 80 diesel* ou *gasto 12 pedágio*';
      try {
        checkMoney(amountCents, { max: 5000, what: 'O valor da despesa' });
      } catch (err) {
        if (err instanceof ValidationError) return `⚠️ ${err.message}`;
        throw err;
      }
      const words = String(text).trim().split(/\s+/).slice(1);
      const description = words.filter((w) => w !== amountArg && !/^\$?[\d.,]+$/.test(w)).join(' ');
      const first = simplify(text).split(/\s+/)[0];
      const category = first === 'abasteci' ? 'combustivel' : guessCategory(description);
      // Despesa no meio de um serviço fica ligada a ele.
      const service = ctx.data.services.active(user);
      // "gasto 300 pneu F550": caminhão pelo nome; senão o do motorista.
      const named = ctx.api.manutencao?.findTruck(words);
      const expense = addExpense(ctx, { userId: user.id, serviceId: service?.id ?? null, amountCents, category, description, truckId: named?.id });
      const truck = expense.truck_id && ctx.api.manutencao?.get(expense.truck_id);
      return `🧾 Despesa de ${formatMoney(amountCents)} (${CATEGORIES[category]}${description ? ': ' + description : ''}) registrada${truck ? ` no ${truck.name}` : ''}.`;
    },
  },
];

// Nome do caminhão junto da despesa, quando o módulo de manutenção está ligado.
const truckJoin = (ctx) =>
  ctx.has('manutencao') ? { select: ', t.name AS truck_name', join: ' LEFT JOIN trucks t ON t.id = e.truck_id' } : { select: '', join: '' };

function routes(api, ctx) {
  api.get('/expenses', (req, res) => {
    const params = [];
    let where = '1 = 1';
    if (req.user.role !== 'dono') {
      where += ' AND e.user_id = ?';
      params.push(req.user.id);
    }
    if (req.query.since) {
      where += ' AND e.created_at >= ?';
      params.push(String(req.query.since));
    }
    res.json(
      ctx.db
        .prepare(`SELECT e.*, u.name AS user_name${truckJoin(ctx).select} FROM expenses e LEFT JOIN users u ON u.id = e.user_id${truckJoin(ctx).join} WHERE ${where} ORDER BY e.id DESC LIMIT 300`)
        .all(...params)
    );
  });

  api.post('/expenses', (req, res) => {
    const { amount, category, description, service_id, truck_id } = req.body || {};
    const amountCents = checkMoney(parseMoney(amount), { max: 5000, what: 'O valor da despesa' });
    const cat = CATEGORIES[category] ? category : guessCategory(description);
    // truck_id: "" = sem caminhão; não mandado = caminhão do motorista.
    const truckId = truck_id === undefined ? undefined : Number(truck_id) || null;
    res.status(201).json(addExpense(ctx, { userId: req.user.id, serviceId: service_id || null, amountCents, category: cat, description, truckId }));
  });

  api.delete('/expenses/:id', (req, res) => {
    const expense = ctx.db.prepare('SELECT * FROM expenses WHERE id = ?').get(Number(req.params.id));
    if (!expense || (req.user.role !== 'dono' && expense.user_id !== req.user.id)) throw new HttpError(404, 'Despesa não encontrada.');
    ctx.db.prepare('DELETE FROM expenses WHERE id = ?').run(expense.id);
    res.json({ ok: true });
  });
}

function summary({ ctx, since, userId }) {
  const params = [since];
  let filter = '';
  if (userId) {
    filter = 'AND user_id = ?';
    params.push(userId);
  }
  const rows = ctx.db
    .prepare(`SELECT category, SUM(amount_cents) AS total FROM expenses WHERE created_at >= ? ${filter} GROUP BY category`)
    .all(...params);
  const byCategory = Object.fromEntries(rows.map((r) => [r.category, r.total]));
  return { expenses_cents: rows.reduce((s, r) => s + r.total, 0), expenses_by_category: byCategory };
}

function summaryLines(s) {
  const lines = [`Despesas: ${formatMoney(s.expenses_cents)}`];
  for (const [cat, total] of Object.entries(s.expenses_by_category || {})) lines.push(`  • ${CATEGORIES[cat] || cat}: ${formatMoney(total)}`);
  if (s.received_cents != null) lines.push(`*Saldo (recebido − despesas): ${formatMoney(s.received_cents - s.expenses_cents)}*`);
  return lines;
}

// Planilha: aba Despesas.
function exportSheets({ ctx, from, to, userId }) {
  const where = ['e.created_at >= ?', 'e.created_at < ?'];
  const params = [from, to];
  if (userId) {
    where.push('e.user_id = ?');
    params.push(userId);
  }
  const rows = ctx.db
    .prepare(
      `SELECT e.*, u.name AS user_name${truckJoin(ctx).select} FROM expenses e LEFT JOIN users u ON u.id = e.user_id${truckJoin(ctx).join}
       WHERE ${where.join(' AND ')} ORDER BY e.id`
    )
    .all(...params);
  return [
    {
      name: 'Despesas',
      columns: [
        { header: 'Data', width: 17, type: 'date' },
        { header: 'Valor', width: 11, type: 'money' },
        { header: 'Tipo', width: 14 },
        { header: 'Descrição', width: 30 },
        { header: 'Quem gastou', width: 14 },
        { header: 'Serviço nº', width: 10, type: 'number' },
        { header: 'Caminhão', width: 14 },
      ],
      rows: rows.map((e) => [e.created_at, e.amount_cents / 100, CATEGORIES[e.category] || e.category, e.description, e.user_name, e.service_id, e.truck_name || '']),
    },
  ];
}

export default {
  name: 'despesas',
  exportSheets,
  label: 'Despesas',
  migrations,
  commands,
  routes,
  summary,
  summaryLines,
};
