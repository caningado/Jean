// Módulo de despesas: combustível, pedágio, manutenção etc., por motorista.
import { parseMoney, formatMoney, simplify, nowIso, HttpError } from '../../lib/util.js';
import express from 'express';
import { checkMoney, ValidationError } from '../../lib/validate.js';
import { readPhotoText } from '../../lib/foto-texto.js';

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
  // Galões do abastecimento (diesel), para o relatório mostrar quanto abasteceu e o preço do galão.
  `ALTER TABLE expenses ADD COLUMN gallons REAL;`,
];

// "16.464 gal", "16,4 galões" -> 16.464 (ou null).
const GALLONS = /(\d+(?:[.,]\d+)?)\s*(?:gal|gals|galao|galoes|gallon|gallons)\b/;
export function parseGallons(text) {
  const m = simplify(text).match(GALLONS);
  const n = m ? Number(m[1].replace(',', '.')) : null;
  return n > 0 && n < 1000 ? n : null;
}
const checkGallons = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  if (!(n > 0 && n < 1000)) throw new ValidationError('Galões inválidos.');
  return n;
};
// "16.464 gal · $6.16/gal"
export function gallonsText(e) {
  if (!e.gallons) return '';
  return `${Number(e.gallons).toLocaleString('en-US', { maximumFractionDigits: 3 })} gal · ${formatMoney(Math.round(e.amount_cents / e.gallons))}/gal`;
}

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

function addExpense(ctx, { userId, serviceId = null, amountCents, category, description, truckId, at = null, gallons = null }) {
  // Sem caminhão escolhido: vai para o caminhão do motorista.
  if (truckId === undefined) truckId = ctx.api.manutencao?.truckFor(userId)?.id ?? null;
  const info = ctx.db
    .prepare('INSERT INTO expenses (user_id, service_id, amount_cents, category, description, truck_id, created_at, gallons) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(userId, serviceId, amountCents, category, description || null, truckId || null, at || nowIso(), gallons || null);
  return ctx.db.prepare('SELECT * FROM expenses WHERE id = ?').get(Number(info.lastInsertRowid));
}

const commands = [
  {
    names: ['gasto', 'gastei', 'despesa', 'abasteci'],
    help: '*gasto 80 diesel* – registrar uma despesa (*abasteci 101.40 16.4 gal* guarda os galões; ou mande a foto da bomba)',
    run({ ctx, user, args, text }) {
      // Galões ("16.464 gal") saem antes de procurar o valor.
      const gallons = parseGallons(text);
      const galIdx = gallons ? args.findIndex((a, i) => /^(gal|gals|galao|galoes|galões|galão|gallons?)$/i.test(args[i + 1] || '') || /^\d+(?:[.,]\d+)?gal/i.test(a)) : -1;
      const rest = galIdx >= 0 ? args.filter((_, i) => i !== galIdx && i !== galIdx + 1) : args;
      const amountArg = rest.find((a) => /\d/.test(a));
      const amountCents = parseMoney(amountArg);
      if (!amountCents) return 'Faltou o valor. Ex: *gasto 80 diesel* ou *gasto 12 pedágio*';
      try {
        checkMoney(amountCents, { max: 5000, what: 'O valor da despesa' });
      } catch (err) {
        if (err instanceof ValidationError) return `⚠️ ${err.message}`;
        throw err;
      }
      const words = String(text).trim().split(/\s+/).slice(1);
      const description = words.filter((w) => w !== amountArg && !/^\$?[\d.,]+(gal)?$/i.test(w) && !/^(gal|gals|galao|galoes|galões|galão|gallons?)$/i.test(w)).join(' ');
      const first = simplify(text).split(/\s+/)[0];
      const category = first === 'abasteci' ? 'combustivel' : guessCategory(description);
      // Despesa no meio de um serviço fica ligada a ele.
      const service = ctx.data.services.active(user);
      // "gasto 300 pneu F550": caminhão pelo nome; senão o do motorista.
      const named = ctx.api.manutencao?.findTruck(words);
      const expense = addExpense(ctx, { userId: user.id, serviceId: service?.id ?? null, amountCents, category: gallons ? 'combustivel' : category, description, truckId: named?.id, gallons });
      const truck = expense.truck_id && ctx.api.manutencao?.get(expense.truck_id);
      const done = `🧾 Despesa de ${formatMoney(amountCents)} (${CATEGORIES[expense.category]}${description ? ': ' + description : ''}${gallons ? `, ${gallonsText(expense)}` : ''}) registrada${truck ? ` no ${truck.name}` : ''}.`;
      // Abasteceu: pede a foto do painel para conferir a milhagem (pedido do Caningado 25/10).
      return expense.category === 'combustivel' && truck ? `${done}\n📸 Agora mande a *foto do painel* do caminhão para eu ler a milhagem (ou *odometro 123456*).` : done;
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
    const { amount, category, description, service_id, truck_id, odometer } = req.body || {};
    const amountCents = checkMoney(parseMoney(amount), { max: 5000, what: 'O valor da despesa' });
    let gallons;
    try {
      gallons = checkGallons(req.body?.gallons);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    const cat = CATEGORIES[category] ? category : guessCategory(description);
    // truck_id: "" = sem caminhão; não mandado = caminhão do motorista.
    const truckId = truck_id === undefined ? undefined : Number(truck_id) || null;
    // Milhas do caminhão junto (ex.: depois de abastecer). Confere antes de gravar a despesa.
    const miles = odometer != null && odometer !== '' && ctx.api.manutencao ? odometer : null;
    const truck = miles != null && (truckId === undefined ? ctx.api.manutencao.truckFor(req.user.id) : truckId && ctx.api.manutencao.get(truckId));
    if (miles != null && !(truck && ctx.api.manutencao.canEdit(req.user, truck))) throw new HttpError(400, 'Escolha o caminhão para guardar as milhas.');
    if (truck) ctx.api.manutencao.updateOdometer(req.user, truck, miles);
    res.status(201).json(addExpense(ctx, { userId: req.user.id, serviceId: service_id || null, amountCents, category: cat, description, truckId, gallons }));
  });

  // Foto da bomba (ou recibo do posto) ou do painel: devolve o valor e os galões, ou as milhas, para preencher a despesa.
  api.post('/expenses/ler-foto', express.raw({ type: 'image/*', limit: '15mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Mande uma foto.');
    if (!ctx.config.geminiApiKey) throw new HttpError(422, 'A leitura de foto precisa da chave do Gemini (GEMINI_API_KEY). Digite o valor e os galões.');
    let read;
    try {
      read = await readPhotoText(ctx, req.body, req.headers['content-type']);
    } catch (err) {
      ctx.log('Despesas: não consegui ler a foto da bomba', err.message);
      throw new HttpError(502, 'Não consegui ler a foto agora. Tente de novo ou digite.');
    }
    if (req.query.tipo === 'painel') {
      if (!read.milhas) throw new HttpError(422, 'Não consegui ler a milhagem nessa foto. Tire de frente, com o painel aceso, ou digite.');
      return res.json({ odometer: read.milhas });
    }
    if (!read.valor) throw new HttpError(422, 'Não consegui ler o valor nessa foto. Tire de frente, sem reflexo, ou digite.');
    res.json({ amount: read.valor.toFixed(2), gallons: read.galoes || null });
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
  const gallons = ctx.db.prepare(`SELECT COALESCE(SUM(gallons), 0) AS g FROM expenses WHERE created_at >= ? ${filter}`).get(...params).g;
  return { expenses_cents: rows.reduce((s, r) => s + r.total, 0), expenses_by_category: byCategory, fuel_gallons: Math.round(gallons * 1000) / 1000 };
}

function summaryLines(s) {
  const lines = [`Despesas: ${formatMoney(s.expenses_cents)}`];
  for (const [cat, total] of Object.entries(s.expenses_by_category || {})) lines.push(`  • ${CATEGORIES[cat] || cat}: ${formatMoney(total)}${cat === 'combustivel' && s.fuel_gallons ? ` (${s.fuel_gallons.toLocaleString('en-US')} gal)` : ''}`);
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
        { header: 'Galões', width: 9, type: 'number' },
        { header: 'Preço/galão', width: 11, type: 'money' },
      ],
      rows: rows.map((e) => [e.created_at, e.amount_cents / 100, CATEGORIES[e.category] || e.category, e.description, e.user_name, e.service_id, e.truck_name || '', e.gallons || null, e.gallons ? Math.round(e.amount_cents / e.gallons) / 100 : null]),
    },
  ];
}

function setup(ctx) {
  ctx.api.despesas = {
    add: (fields) => addExpense(ctx, fields),
    remove: (id) => ctx.db.prepare('DELETE FROM expenses WHERE id = ?').run(Number(id)),
  };
}

export default {
  name: 'despesas',
  setup,
  exportSheets,
  label: 'Despesas',
  migrations,
  commands,
  routes,
  summary,
  summaryLines,
};
