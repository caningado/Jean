// Módulo de manutenção: caminhões, milhagem e o que precisa trocar (óleo, pneus, freios,
// inspeção, registro). Avisa quando está perto ou já passou.
import crypto from 'node:crypto';
import { simplify, nowIso, HttpError, parseMoney } from '../../lib/util.js';
import { monthRange, zonedMidnight } from '../planilha/index.js';
import { renderTruckMonth } from './extrato.js';
import { renderFleetWeek } from './semana.js';

const DAY = 86400000;
// "Perto" = faltam menos que isso.
const NEAR_MILES = 500;
const NEAR_DAYS = 15;
// Pede para atualizar as milhas se ninguém mandou há mais que isso.
const STALE_DAYS = 7;

// Itens que todo caminhão novo já ganha (o dono pode mudar os intervalos no painel).
export const DEFAULT_ITEMS = [
  { name: 'Troca de óleo', every_miles: 5000, every_days: 180 },
  { name: 'Rodízio dos pneus', every_miles: 6000, every_days: null },
  { name: 'Freios', every_miles: 25000, every_days: 365 },
  { name: 'Inspeção anual', every_miles: null, every_days: 365 },
  { name: 'Registro', every_miles: null, every_days: 365 },
];

const migrations = [
  `CREATE TABLE trucks (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     plate TEXT,
     driver_id INTEGER REFERENCES users(id),
     odometer INTEGER NOT NULL DEFAULT 0,
     odometer_at TEXT,
     active INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL
   );
   CREATE TABLE maintenance_items (
     id INTEGER PRIMARY KEY,
     truck_id INTEGER NOT NULL REFERENCES trucks(id),
     name TEXT NOT NULL,
     every_miles INTEGER,
     every_days INTEGER,
     last_miles INTEGER,
     last_date TEXT,
     created_at TEXT NOT NULL
   );
   CREATE TABLE maintenance_log (
     id INTEGER PRIMARY KEY,
     truck_id INTEGER NOT NULL REFERENCES trucks(id),
     item_id INTEGER REFERENCES maintenance_items(id),
     item_name TEXT NOT NULL,
     miles INTEGER,
     user_id INTEGER REFERENCES users(id),
     notes TEXT,
     done_at TEXT NOT NULL
   );`,
  // Histórico das milhas, para saber quanto o caminhão rodou no mês.
  `CREATE TABLE odometer_readings (
     id INTEGER PRIMARY KEY,
     truck_id INTEGER NOT NULL REFERENCES trucks(id),
     miles INTEGER NOT NULL,
     at TEXT NOT NULL
   );
   CREATE INDEX odometer_truck ON odometer_readings(truck_id, at);
   INSERT INTO odometer_readings (truck_id, miles, at) SELECT id, odometer, COALESCE(odometer_at, created_at) FROM trucks;`,
  // Próxima troca marcada à mão (senão conta pelo intervalo), oficina e valor do serviço,
  // e quem mandou cada milhagem (para o relatório da semana).
  `ALTER TABLE maintenance_items ADD COLUMN next_miles INTEGER;
   ALTER TABLE maintenance_items ADD COLUMN next_date TEXT;
   ALTER TABLE maintenance_log ADD COLUMN cost_cents INTEGER;
   ALTER TABLE maintenance_log ADD COLUMN shop TEXT;
   ALTER TABLE maintenance_log ADD COLUMN next_miles INTEGER;
   ALTER TABLE maintenance_log ADD COLUMN next_date TEXT;
   ALTER TABLE maintenance_log ADD COLUMN expense_id INTEGER;
   ALTER TABLE odometer_readings ADD COLUMN user_id INTEGER REFERENCES users(id);`,
  // Cobrança da milhagem da semana: quantos lembretes já foram e quando a lista foi suspensa.
  `CREATE TABLE mileage_chase (
     driver_id INTEGER NOT NULL REFERENCES users(id),
     week TEXT NOT NULL,
     count INTEGER NOT NULL DEFAULT 0,
     last_at TEXT,
     blocked_at TEXT,
     PRIMARY KEY (driver_id, week)
   );`,
];
// Cobrança: começa na sexta na hora do aviso da manhã, repete de hora em hora 3 vezes;
// sem resposta, suspende a lista de serviços do motorista até ele mandar a milhagem.
const CHASE_DAYS = [5, 6, 0];
const CHASE_TIMES = 3;
const HOUR = 3600000;

const fmtMiles = (n) => `${Number(n).toLocaleString('en-US')} mi`;
const fmtDate = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

// Situação de um item: ok, perto ou vencido, e quanto falta.
export function itemStatus(truck, item, now = Date.now()) {
  let state = 'ok';
  const notes = [];
  const worse = (s) => {
    if (s === 'vencido' || (s === 'perto' && state === 'ok')) state = s;
  };
  let miles_left = null;
  let days_left = null;
  const due_miles = item.next_miles ?? (item.every_miles ? (item.last_miles ?? 0) + item.every_miles : null);
  const dueTime = item.next_date
    ? Date.parse(`${item.next_date}T12:00:00Z`)
    : item.every_days
      ? new Date(item.last_date || item.created_at).getTime() + item.every_days * DAY
      : null;
  if (due_miles != null) {
    miles_left = due_miles - truck.odometer;
    if (miles_left <= 0) {
      worse('vencido');
      notes.push(`passou ${fmtMiles(-miles_left)}`);
    } else {
      if (miles_left <= NEAR_MILES) worse('perto');
      notes.push(`faltam ${fmtMiles(miles_left)}`);
    }
  }
  if (dueTime != null) {
    days_left = Math.ceil((dueTime - now) / DAY);
    const date = fmtDate(new Date(dueTime).toISOString());
    if (days_left <= 0) {
      worse('vencido');
      notes.push(`venceu em ${date}`);
    } else {
      if (days_left <= NEAR_DAYS) worse('perto');
      notes.push(`até ${date}`);
    }
  }
  const due_date = dueTime != null ? new Date(dueTime).toISOString().slice(0, 10) : null;
  return { state, miles_left, days_left, due_miles, due_date, note: notes.join(' ou ') };
}

function listTrucks(ctx, user) {
  const own = user && user.role !== 'dono';
  const trucks = ctx.db
    .prepare(
      `SELECT t.*, u.name AS driver_name FROM trucks t LEFT JOIN users u ON u.id = t.driver_id
       WHERE t.active = 1 ${own ? 'AND (t.driver_id = ? OR t.driver_id IS NULL)' : ''} ORDER BY t.id`
    )
    .all(...(own ? [user.id] : []));
  const items = ctx.db.prepare('SELECT * FROM maintenance_items WHERE truck_id = ? ORDER BY id');
  return trucks.map((t) => ({
    ...t,
    items: items.all(t.id).map((i) => ({ ...i, ...itemStatus(t, i) })),
  }));
}

function getTruck(ctx, id) {
  return ctx.db.prepare('SELECT * FROM trucks WHERE id = ? AND active = 1').get(Number(id));
}

function createTruck(ctx, { name, plate = null, odometer = 0, driverId = null, userId = null }) {
  const now = nowIso();
  const info = ctx.db
    .prepare('INSERT INTO trucks (name, plate, driver_id, odometer, odometer_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, plate, driverId, odometer, now, now);
  const id = Number(info.lastInsertRowid);
  ctx.db.prepare('INSERT INTO odometer_readings (truck_id, miles, at, user_id) VALUES (?, ?, ?, ?)').run(id, odometer, now, userId);
  const add = ctx.db.prepare(
    'INSERT INTO maintenance_items (truck_id, name, every_miles, every_days, last_miles, last_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const item of DEFAULT_ITEMS) add.run(id, item.name, item.every_miles, item.every_days, odometer, now, now);
  return getTruck(ctx, id);
}

function setOdometer(ctx, truck, miles, userId = null) {
  const now = nowIso();
  ctx.db.prepare('UPDATE trucks SET odometer = ?, odometer_at = ? WHERE id = ?').run(miles, now, truck.id);
  ctx.db.prepare('INSERT INTO odometer_readings (truck_id, miles, at, user_id) VALUES (?, ?, ?, ?)').run(truck.id, miles, now, userId);
  return getTruck(ctx, truck.id);
}

// Dias no fuso da empresa ("2026-10-07").
const localDay = (ctx, d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: ctx.config.timeZone }).format(d);
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = domingo
const mondayOf = (day) => addDays(day, -((weekday(day) + 6) % 7));
const dayStart = (ctx, day) => {
  const [y, m, d] = day.split('-').map(Number);
  return zonedMidnight(y, m, d, ctx.config.timeZone);
};
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));

// Registra um serviço feito (óleo, freio...). Sem item = serviço avulso ("Outro").
// next_miles/next_date: próxima troca; vazio = conta pelo intervalo do item.
function markDone(ctx, { truck, item = null, name = null, miles = null, userId, notes = null, date = null, costCents = null, shop = null, nextMiles = null, nextDate = null }) {
  const at = miles ?? truck.odometer;
  const doneAt = !date || date >= localDay(ctx) ? nowIso() : new Date(Date.parse(dayStart(ctx, date)) + 12 * 3600000).toISOString();
  if (at > truck.odometer) truck = setOdometer(ctx, truck, at, userId);

  if (!item && (nextMiles != null || nextDate)) {
    // Serviço novo com próxima troca: vira um item para o sistema avisar.
    const info = ctx.db
      .prepare('INSERT INTO maintenance_items (truck_id, name, every_miles, every_days, last_miles, last_date, created_at) VALUES (?, ?, NULL, NULL, ?, ?, ?)')
      .run(truck.id, name, at, doneAt, nowIso());
    item = ctx.db.prepare('SELECT * FROM maintenance_items WHERE id = ?').get(Number(info.lastInsertRowid));
  }
  // Só guarda a próxima à mão se for diferente do intervalo normal (assim mudar o intervalo depois vale).
  const autoMiles = item?.every_miles ? at + item.every_miles : null;
  const autoDate = item?.every_days ? localDay(ctx, new Date(Date.parse(doneAt) + item.every_days * DAY)) : null;
  const keepMiles = nextMiles != null && nextMiles !== autoMiles ? nextMiles : null;
  const keepDate = nextDate && nextDate !== autoDate ? nextDate : null;

  let expenseId = null;
  if (costCents && ctx.api.despesas) {
    const label = item?.name || name;
    expenseId = ctx.api.despesas.add({ userId, amountCents: costCents, category: 'manutencao', description: shop ? `${label} (${shop})` : label, truckId: truck.id, at: doneAt }).id;
  }
  if (item) {
    // Serviço antigo lançado depois de um mais novo não mexe na próxima troca.
    const newer = ctx.db.prepare('SELECT 1 FROM maintenance_log WHERE item_id = ? AND done_at > ?').get(item.id, doneAt);
    if (!newer) {
      ctx.db.prepare('UPDATE maintenance_items SET last_miles = ?, last_date = ?, next_miles = ?, next_date = ? WHERE id = ?').run(at, doneAt, keepMiles, keepDate, item.id);
    }
  }
  const info = ctx.db
    .prepare(
      `INSERT INTO maintenance_log (truck_id, item_id, item_name, miles, user_id, notes, done_at, cost_cents, shop, next_miles, next_date, expense_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(truck.id, item?.id ?? null, item?.name || name, at, userId, notes, doneAt, costCents || null, shop, keepMiles, keepDate, expenseId);
  const log = ctx.db.prepare('SELECT * FROM maintenance_log WHERE id = ?').get(Number(info.lastInsertRowid));
  return { log, item: item && ctx.db.prepare('SELECT * FROM maintenance_items WHERE id = ?').get(item.id) };
}

// Apaga um serviço lançado errado. Se era o último daquele item, volta a próxima troca para o anterior.
function removeLog(ctx, log) {
  ctx.db.prepare('DELETE FROM maintenance_log WHERE id = ?').run(log.id);
  if (log.expense_id && ctx.api.despesas) ctx.api.despesas.remove(log.expense_id);
  if (!log.item_id) return;
  const latest = ctx.db.prepare('SELECT * FROM maintenance_log WHERE item_id = ? ORDER BY done_at DESC, id DESC LIMIT 1').get(log.item_id);
  if (latest && latest.done_at >= log.done_at) return;
  if (latest) {
    ctx.db.prepare('UPDATE maintenance_items SET last_miles = ?, last_date = ?, next_miles = ?, next_date = ? WHERE id = ?').run(latest.miles, latest.done_at, latest.next_miles, latest.next_date, log.item_id);
  }
}

// Milhas: "123456", "123,456", "123.456" ou "123k".
function parseMiles(word) {
  const s = String(word || '').toLowerCase().replace(/[,.]/g, '');
  const m = s.match(/^(\d+)(k?)$/);
  if (!m) return null;
  return Number(m[1]) * (m[2] ? 1000 : 1);
}

// Qual caminhão o usuário quer: pelo nome/placa nas palavras, o dele, ou o único que existe.
function pickTruck(ctx, user, words) {
  const trucks = listTrucks(ctx, user.role === 'dono' ? null : user);
  const named = trucks.filter((t) =>
    words.some((w) => w.length > 1 && (simplify(t.name).split(/\s+/).includes(w) || simplify(t.plate) === w))
  );
  if (named.length === 1) return { truck: named[0], trucks };
  const mine = trucks.filter((t) => t.driver_id === user.id);
  if (mine.length === 1) return { truck: mine[0], trucks };
  if (trucks.length === 1) return { truck: trucks[0], trucks };
  return { truck: null, trucks };
}

const truckNames = (trucks) => trucks.map((t) => t.name).join(', ');
const ICON = { ok: '✅', perto: '🟡', vencido: '🔴' };

function statusText(trucks) {
  return trucks
    .map((t) => {
      const head = `🚛 *${t.name}*${t.plate ? ` (${t.plate})` : ''} – ${fmtMiles(t.odometer)}`;
      const lines = t.items.map((i) => `${ICON[i.state]} ${i.name}: ${i.note || 'sem intervalo'}`);
      return [head, ...lines].join('\n');
    })
    .join('\n\n');
}

const NO_TRUCK = 'Nenhum caminhão cadastrado. O dono cadastra no painel, em *Mais → 🔧 Caminhões*.';

const commands = [
  {
    names: ['caminhao', 'caminhoes', 'manutencao', 'truck'],
    help: '*caminhao* – milhas e manutenção do caminhão (óleo, pneus...)',
    run({ ctx, user }) {
      const trucks = listTrucks(ctx, user.role === 'dono' ? null : user);
      if (!trucks.length) return NO_TRUCK;
      return [statusText(trucks), '', 'Atualize as milhas com *odometro 123456*. Fez um serviço? *fiz oleo* (ou pneus, freios...).'].join('\n');
    },
  },
  {
    names: ['odometro', 'odometer', 'milhas', 'km'],
    help: '*odometro 123456* – atualizar as milhas do caminhão',
    run({ ctx, user, args }) {
      const words = args.map(simplify);
      const miles = words.map(parseMiles).find((n) => n != null);
      if (miles == null) return 'Mande as milhas que aparecem no painel do caminhão. Ex: *odometro 123456*';
      const { truck, trucks } = pickTruck(ctx, user, words.filter((w) => parseMiles(w) == null));
      if (!trucks.length) return NO_TRUCK;
      if (!truck) return `De qual caminhão? Ex: *odometro ${simplify(trucks[0].name).split(' ')[0]} ${miles}*\nCaminhões: ${truckNames(trucks)}`;
      if (miles < truck.odometer) return `⚠️ ${fmtMiles(miles)} é menos do que o último registrado (${fmtMiles(truck.odometer)}). Confira o número.`;
      if (miles - truck.odometer > 20000) return `⚠️ ${fmtMiles(miles - truck.odometer)} a mais desde a última vez? Confira o número.`;
      const wasBlocked = blockServices({ ctx, user });
      const updated = setOdometer(ctx, truck, miles, user.id);
      const freed = wasBlocked && !blockServices({ ctx, user });
      const [t] = listTrucks(ctx).filter((x) => x.id === updated.id);
      const attention = t.items.filter((i) => i.state !== 'ok').map((i) => `${ICON[i.state]} ${i.name}: ${i.note}`);
      return [`📏 ${t.name}: ${fmtMiles(miles)} registrado.`, ...attention, ...(freed ? ['✅ Obrigado! Sua lista de serviços foi liberada.'] : [])].join('\n');
    },
  },
  {
    names: ['fiz', 'troquei', 'trocou', 'feito'],
    help: '*fiz oleo* – registrar manutenção feita (óleo, pneus, freios, inspeção...)',
    run({ ctx, user, args }) {
      const words = args.map(simplify);
      const miles = words.map(parseMiles).find((n) => n != null) ?? null;
      const rest = words.filter((w) => parseMiles(w) == null);
      const { truck, trucks } = pickTruck(ctx, user, rest);
      if (!trucks.length) return NO_TRUCK;
      if (!truck) return `De qual caminhão? Ex: *fiz oleo ${simplify(trucks[0].name).split(' ')[0]}*\nCaminhões: ${truckNames(trucks)}`;
      const items = ctx.db.prepare('SELECT * FROM maintenance_items WHERE truck_id = ?').all(truck.id);
      // "oleo" acha "Troca de óleo", "pneu" acha "Rodízio dos pneus".
      const found = items.filter((i) => {
        const name = simplify(i.name).split(/\s+/);
        return rest.some((w) => w.length > 2 && name.some((n) => n.startsWith(w) || w.startsWith(n.replace(/s$/, ''))));
      });
      if (found.length !== 1) {
        return `O que foi feito no ${truck.name}? Ex: *fiz oleo*\nItens: ${items.map((i) => i.name).join(', ')}`;
      }
      if (miles != null && miles < (found[0].last_miles ?? 0)) return `⚠️ ${fmtMiles(miles)} é menos que a última vez (${fmtMiles(found[0].last_miles)}). Confira o número.`;
      const { item } = markDone(ctx, { truck, item: found[0], miles, userId: user.id });
      const fresh = getTruck(ctx, truck.id);
      return `🔧 ${item.name} do ${truck.name} registrado em ${fmtMiles(item.last_miles)}.\nPróximo: ${itemStatus(fresh, item).note || 'sem intervalo'}.`;
    },
  },
];

function canEdit(user, truck) {
  return truck && (user.role === 'dono' || truck.driver_id === user.id || truck.driver_id == null);
}

function int(v, what, { allowNull = false } = {}) {
  if ((v == null || v === '') && allowNull) return null;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  if (!Number.isInteger(n) || n < 0 || n > 2_000_000) throw new HttpError(400, `${what} inválido.`);
  return n;
}

// Despesas, milhas e manutenção do caminhão num mês ("2026-10").
export function truckMonth(ctx, truck, mes) {
  const range = monthRange(mes, ctx.config.timeZone);
  if (range.label === 'tudo') throw new HttpError(400, 'Escolha o mês.');
  const expenses = ctx.has('despesas')
    ? ctx.db
        .prepare(
          `SELECT e.*, u.name AS user_name FROM expenses e LEFT JOIN users u ON u.id = e.user_id
           WHERE e.truck_id = ? AND e.created_at >= ? AND e.created_at < ? ORDER BY e.created_at`
        )
        .all(truck.id, range.from, range.to)
    : [];
  const byCategory = {};
  for (const e of expenses) byCategory[e.category] = (byCategory[e.category] || 0) + e.amount_cents;
  const total = expenses.reduce((t, e) => t + e.amount_cents, 0);
  // Milhas: última leitura do mês menos a última antes do mês (ou a primeira do mês).
  const before = ctx.db.prepare('SELECT miles FROM odometer_readings WHERE truck_id = ? AND at < ? ORDER BY at DESC, id DESC LIMIT 1').get(truck.id, range.from);
  const inMonth = ctx.db.prepare('SELECT miles FROM odometer_readings WHERE truck_id = ? AND at >= ? AND at < ? ORDER BY at, id').all(truck.id, range.from, range.to);
  const start = before?.miles ?? inMonth[0]?.miles ?? null;
  const end = inMonth.length ? inMonth[inMonth.length - 1].miles : null;
  const miles = start != null && end != null ? Math.max(0, end - start) : 0;
  const maintenance = ctx.db
    .prepare('SELECT l.*, u.name AS user_name FROM maintenance_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.truck_id = ? AND l.done_at >= ? AND l.done_at < ? ORDER BY l.done_at')
    .all(truck.id, range.from, range.to);
  const driver = truck.driver_id ? ctx.db.prepare('SELECT name FROM users WHERE id = ?').get(truck.driver_id)?.name : null;
  return {
    mes: range.label,
    timeZone: ctx.config.timeZone,
    truck: { id: truck.id, name: truck.name, plate: truck.plate, driver_name: driver || null, odometer: truck.odometer },
    expenses,
    by_category: byCategory,
    total_cents: total,
    miles,
    cost_per_mile_cents: miles ? Math.round(total / miles) : null,
    maintenance,
  };
}

function routes(api, ctx) {
  api.get('/trucks', (req, res) => {
    res.json(listTrucks(ctx, req.user.role === 'dono' ? null : req.user));
  });

  api.post('/trucks', (req, res) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o dono cadastra caminhões.');
    const { name, plate, odometer, driver_id } = req.body || {};
    if (!String(name || '').trim()) throw new HttpError(400, 'Dê um nome ao caminhão (ex.: F-550).');
    res.status(201).json(
      createTruck(ctx, {
        name: String(name).trim(),
        plate: String(plate || '').trim() || null,
        odometer: int(odometer || 0, 'Milhas'),
        driverId: driver_id ? Number(driver_id) : null,
        userId: req.user.id,
      })
    );
  });

  api.patch('/trucks/:id', (req, res) => {
    const truck = getTruck(ctx, req.params.id);
    if (!canEdit(req.user, truck)) throw new HttpError(404, 'Caminhão não encontrado.');
    const body = req.body || {};
    if (body.odometer != null && body.odometer !== '') {
      const miles = int(body.odometer, 'Milhas');
      if (miles < truck.odometer && req.user.role !== 'dono') throw new HttpError(400, `As milhas não podem ser menores que ${fmtMiles(truck.odometer)}.`);
      setOdometer(ctx, truck, miles, req.user.id);
    }
    if (req.user.role === 'dono') {
      if (body.name != null && String(body.name).trim()) ctx.db.prepare('UPDATE trucks SET name = ? WHERE id = ?').run(String(body.name).trim(), truck.id);
      if (body.plate !== undefined) ctx.db.prepare('UPDATE trucks SET plate = ? WHERE id = ?').run(String(body.plate || '').trim() || null, truck.id);
      if (body.driver_id !== undefined) ctx.db.prepare('UPDATE trucks SET driver_id = ? WHERE id = ?').run(body.driver_id ? Number(body.driver_id) : null, truck.id);
    }
    res.json(listTrucks(ctx).find((t) => t.id === truck.id));
  });

  api.delete('/trucks/:id', (req, res) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o dono pode apagar caminhões.');
    ctx.db.prepare('UPDATE trucks SET active = 0 WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  api.post('/trucks/:id/items', (req, res) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o dono pode mudar os itens.');
    const truck = getTruck(ctx, req.params.id);
    if (!truck) throw new HttpError(404, 'Caminhão não encontrado.');
    const { name, every_miles, every_days } = req.body || {};
    if (!String(name || '').trim()) throw new HttpError(400, 'Dê um nome ao item (ex.: Filtro de ar).');
    const miles = int(every_miles, 'Intervalo em milhas', { allowNull: true }) || null;
    const days = int(every_days, 'Intervalo em dias', { allowNull: true }) || null;
    if (!miles && !days) throw new HttpError(400, 'Coloque de quantas em quantas milhas ou dias.');
    const now = nowIso();
    const info = ctx.db
      .prepare('INSERT INTO maintenance_items (truck_id, name, every_miles, every_days, last_miles, last_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(truck.id, String(name).trim(), miles, days, truck.odometer, now, now);
    res.status(201).json(ctx.db.prepare('SELECT * FROM maintenance_items WHERE id = ?').get(Number(info.lastInsertRowid)));
  });

  api.patch('/maintenance/:id', (req, res) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o dono pode mudar os intervalos.');
    const item = ctx.db.prepare('SELECT * FROM maintenance_items WHERE id = ?').get(Number(req.params.id));
    if (!item) throw new HttpError(404, 'Item não encontrado.');
    const body = req.body || {};
    const next = {
      name: String(body.name ?? item.name).trim() || item.name,
      every_miles: body.every_miles !== undefined ? int(body.every_miles, 'Intervalo em milhas', { allowNull: true }) || null : item.every_miles,
      every_days: body.every_days !== undefined ? int(body.every_days, 'Intervalo em dias', { allowNull: true }) || null : item.every_days,
    };
    if (!next.every_miles && !next.every_days) throw new HttpError(400, 'Coloque de quantas em quantas milhas ou dias.');
    ctx.db.prepare('UPDATE maintenance_items SET name = ?, every_miles = ?, every_days = ? WHERE id = ?').run(next.name, next.every_miles, next.every_days, item.id);
    res.json(ctx.db.prepare('SELECT * FROM maintenance_items WHERE id = ?').get(item.id));
  });

  api.delete('/maintenance/:id', (req, res) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o dono pode apagar itens.');
    ctx.db.prepare('DELETE FROM maintenance_items WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // Feito: marca o item como feito agora (nas milhas atuais ou nas informadas).
  api.post('/maintenance/:id/done', (req, res) => {
    const item = ctx.db.prepare('SELECT * FROM maintenance_items WHERE id = ?').get(Number(req.params.id));
    const truck = item && getTruck(ctx, item.truck_id);
    if (!canEdit(req.user, truck)) throw new HttpError(404, 'Item não encontrado.');
    const miles = req.body?.miles == null || req.body.miles === '' ? null : int(req.body.miles, 'Milhas');
    res.status(201).json(markDone(ctx, { truck, item, miles, userId: req.user.id, notes: req.body?.notes || null }).item);
  });

  // Tela "Registrar serviço": o que foi feito, quando, milhas, oficina, valor e a próxima troca.
  api.post('/trucks/:id/services', (req, res) => {
    const truck = getTruck(ctx, req.params.id);
    if (!canEdit(req.user, truck)) throw new HttpError(404, 'Caminhão não encontrado.');
    const b = req.body || {};
    const item = b.item_id ? ctx.db.prepare('SELECT * FROM maintenance_items WHERE id = ? AND truck_id = ?').get(Number(b.item_id), truck.id) : null;
    if (b.item_id && !item) throw new HttpError(400, 'Esse item não é deste caminhão.');
    const name = String(b.name || '').trim();
    if (!item && !name) throw new HttpError(400, 'Diga o que foi feito (ex.: Troca de bateria).');
    const opt = (v) => v == null || String(v).trim() === '';
    const miles = opt(b.miles) ? null : int(b.miles, 'Milhas');
    if (miles != null && miles + 50000 < truck.odometer) throw new HttpError(400, `As milhas estão muito abaixo das atuais (${fmtMiles(truck.odometer)}). Confira o número.`);
    if (miles != null && miles - truck.odometer > 20000) throw new HttpError(400, `${fmtMiles(miles - truck.odometer)} a mais que o último registrado? Confira o número.`);
    if (!opt(b.date) && !isDay(b.date)) throw new HttpError(400, 'Data inválida.');
    if (!opt(b.date) && b.date > localDay(ctx)) throw new HttpError(400, 'A data do serviço não pode ser no futuro.');
    if (!opt(b.next_date) && !isDay(b.next_date)) throw new HttpError(400, 'Data da próxima troca inválida.');
    const nextMiles = opt(b.next_miles) ? null : int(b.next_miles, 'Próxima troca (milhas)');
    if (nextMiles != null && nextMiles <= (miles ?? truck.odometer)) throw new HttpError(400, 'A próxima troca tem que ser com mais milhas do que agora.');
    let costCents = null;
    if (!opt(b.cost)) {
      costCents = parseMoney(String(b.cost));
      if (!costCents || costCents < 0 || costCents > 5_000_000) throw new HttpError(400, 'Valor inválido.');
    }
    const out = markDone(ctx, {
      truck,
      item,
      name: name || null,
      miles,
      userId: req.user.id,
      notes: String(b.notes || '').trim() || null,
      date: opt(b.date) ? null : b.date,
      costCents,
      shop: String(b.shop || '').trim() || null,
      nextMiles,
      nextDate: opt(b.next_date) ? null : b.next_date,
    });
    res.status(201).json(out);
  });

  api.delete('/maintenance-log/:id', (req, res) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o dono pode apagar.');
    const log = ctx.db.prepare('SELECT * FROM maintenance_log WHERE id = ?').get(Number(req.params.id));
    if (!log) throw new HttpError(404, 'Serviço não encontrado.');
    removeLog(ctx, log);
    res.json({ ok: true });
  });

  // Relatório da semana (segunda a domingo) de todos os caminhões.
  api.get('/frota/semana', (req, res) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o dono vê o relatório.');
    res.json(weekReport(ctx, String(req.query.dia || '')));
  });

  api.get('/frota/semana.pdf', async (req, res) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o dono vê o relatório.');
    await sendWeekPdf(ctx, res, String(req.query.dia || ''), req.query.download === '1');
  });

  // Extrato do mês: despesas por tipo, milhas rodadas e custo por milha.
  api.get('/trucks/:id/month', (req, res) => {
    const truck = getTruck(ctx, req.params.id);
    if (!canEdit(req.user, truck)) throw new HttpError(404, 'Caminhão não encontrado.');
    res.json(truckMonth(ctx, truck, String(req.query.mes || '')));
  });

  api.get('/trucks/:id/extrato.pdf', async (req, res) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o dono vê o extrato do caminhão.');
    const truck = getTruck(ctx, req.params.id);
    if (!truck) throw new HttpError(404, 'Caminhão não encontrado.');
    const data = truckMonth(ctx, truck, String(req.query.mes || ''));
    const buf = await renderTruckMonth({
      company: ctx.api.invoice?.getCompany() || { name: ctx.config.companyName },
      logo: ctx.api.invoice ? ctx.api.invoice.logo() : null,
      data,
    });
    const name = `Despesas ${truck.name} ${data.mes}.pdf`.replace(/[^\w &.-]/g, '');
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${name}"`);
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  });

  api.get('/trucks/:id/log', (req, res) => {
    const truck = getTruck(ctx, req.params.id);
    if (!canEdit(req.user, truck)) throw new HttpError(404, 'Caminhão não encontrado.');
    res.json(
      ctx.db
        .prepare('SELECT l.*, u.name AS user_name FROM maintenance_log l LEFT JOIN users u ON u.id = l.user_id WHERE truck_id = ? ORDER BY l.id DESC LIMIT 100')
        .all(truck.id)
    );
  });
}

// Avisos: itens vencidos ou perto, e milhas sem atualizar há muito tempo.
function alerts({ ctx, user }) {
  const out = [];
  for (const t of listTrucks(ctx, user.role === 'dono' ? null : user)) {
    for (const i of t.items) {
      if (i.state === 'vencido') out.push({ text: `🔴 ${t.name}: ${i.name} atrasado (${i.note})`, href: '#/caminhoes' });
      else if (i.state === 'perto') out.push({ text: `🟡 ${t.name}: ${i.name} chegando (${i.note})`, href: '#/caminhoes' });
    }
    const days = Math.floor((Date.now() - new Date(t.odometer_at || t.created_at).getTime()) / DAY);
    if (days >= STALE_DAYS) out.push({ text: `📏 ${t.name}: milhas sem atualizar há ${days} dias (mande *odometro 123456*)`, href: '#/caminhoes' });
  }
  return out;
}

// Planilha: aba Manutenção com o que foi feito no mês.
function exportSheets({ ctx, from, to }) {
  const rows = ctx.db
    .prepare(
      `SELECT l.*, t.name AS truck_name, u.name AS user_name FROM maintenance_log l
       JOIN trucks t ON t.id = l.truck_id LEFT JOIN users u ON u.id = l.user_id
       WHERE l.done_at >= ? AND l.done_at < ? ORDER BY l.id`
    )
    .all(from, to);
  return [
    {
      name: 'Manutenção',
      columns: [
        { header: 'Data', width: 17, type: 'date' },
        { header: 'Caminhão', width: 16 },
        { header: 'O que foi feito', width: 24 },
        { header: 'Milhas', width: 11, type: 'number' },
        { header: 'Oficina', width: 18 },
        { header: 'Valor', width: 11, type: 'money' },
        { header: 'Quem registrou', width: 16 },
        { header: 'Obs.', width: 30 },
      ],
      rows: rows.map((r) => [r.done_at, r.truck_name, r.item_name, r.miles, r.shop || '', r.cost_cents != null ? r.cost_cents / 100 : '', r.user_name || '', r.notes || '']),
    },
  ];
}

// ---------- Relatório semanal ----------

const getSetting = (ctx, key) => ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
const setSetting = (ctx, key, value) =>
  ctx.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

// Semana (segunda a domingo) que contém o dia. Sem dia = esta semana.
export function weekReport(ctx, day = '') {
  const start = mondayOf(isDay(day) ? day : localDay(ctx));
  const end = addDays(start, 6);
  const from = dayStart(ctx, start);
  const to = dayStart(ctx, addDays(start, 7));
  const before = ctx.db.prepare('SELECT miles FROM odometer_readings WHERE truck_id = ? AND at < ? ORDER BY at DESC, id DESC LIMIT 1');
  const readings = ctx.db.prepare(
    `SELECT r.*, u.name AS user_name FROM odometer_readings r LEFT JOIN users u ON u.id = r.user_id
     WHERE r.truck_id = ? AND r.at >= ? AND r.at < ? ORDER BY r.at, r.id`
  );
  const services = ctx.db.prepare(
    `SELECT l.*, u.name AS user_name FROM maintenance_log l LEFT JOIN users u ON u.id = l.user_id
     WHERE l.truck_id = ? AND l.done_at >= ? AND l.done_at < ? ORDER BY l.done_at, l.id`
  );
  const spent = ctx.has('despesas') ? ctx.db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS c FROM expenses WHERE truck_id = ? AND created_at >= ? AND created_at < ?') : null;
  const ORDER = { vencido: 0, perto: 1, ok: 2 };
  const trucks = listTrucks(ctx).map((t) => {
    const rs = readings.all(t.id, from, to);
    const startMiles = before.get(t.id, from)?.miles ?? rs[0]?.miles ?? null;
    const endMiles = rs.length ? rs[rs.length - 1].miles : null;
    const informed = rs.filter((r) => r.user_id);
    const last = informed[informed.length - 1] || null;
    return {
      id: t.id,
      name: t.name,
      plate: t.plate,
      driver_name: t.driver_name || null,
      odometer: t.odometer,
      miles_start: startMiles,
      miles_end: endMiles,
      miles: startMiles != null && endMiles != null ? Math.max(0, endMiles - startMiles) : 0,
      reported: Boolean(last),
      reported_by: last?.user_name || null,
      reported_at: last?.at || null,
      services: services.all(t.id, from, to),
      expenses_cents: spent ? spent.get(t.id, from, to).c : null,
      items: [...t.items].sort((a, b) => ORDER[a.state] - ORDER[b.state]),
    };
  });
  const all = (f) => trucks.reduce((n, t) => n + f(t), 0);
  return {
    start,
    end,
    timeZone: ctx.config.timeZone,
    trucks,
    totals: {
      miles: all((t) => t.miles),
      services: all((t) => t.services.length),
      services_cents: all((t) => t.services.reduce((c, l) => c + (l.cost_cents || 0), 0)),
      late: all((t) => t.items.filter((i) => i.state === 'vencido').length),
      near: all((t) => t.items.filter((i) => i.state === 'perto').length),
      missing: trucks.filter((t) => !t.reported).length,
    },
  };
}

async function sendWeekPdf(ctx, res, day, download = false) {
  const data = weekReport(ctx, day);
  const buf = await renderFleetWeek({
    company: ctx.api.invoice?.getCompany() || { name: ctx.config.companyName },
    logo: ctx.api.invoice ? ctx.api.invoice.logo() : null,
    data,
  });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="Relatorio frota ${data.start}.pdf"`);
  res.set('Cache-Control', 'no-store');
  res.send(buf);
}

// Link do PDF sem login, para abrir direto da mensagem do WhatsApp.
function weekLink(ctx, start) {
  const base = ctx.api.invoice?.publicBase();
  if (!base) return null;
  let token = getSetting(ctx, 'frota_token');
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    setSetting(ctx, 'frota_token', token);
  }
  return `${base}/frota/${token}/${start}.pdf`;
}

const dm = (day) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const money = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function weekText(data, link = null) {
  const lines = [`📊 *Relatório semanal da frota* (${dm(data.start)} a ${dm(data.end)})`];
  for (const t of data.trucks) {
    lines.push('');
    lines.push(
      t.reported
        ? `🚛 *${t.name}*: ${fmtMiles(t.miles)} rodadas (agora ${fmtMiles(t.miles_end)}), informado por ${t.reported_by || 'alguém'}`
        : `🚛 *${t.name}*: ⚠️ milhagem *não informada* na semana${t.driver_name ? ` (${t.driver_name})` : ''}`
    );
    for (const l of t.services) lines.push(`   🔧 ${l.item_name} em ${fmtMiles(l.miles)}${l.shop ? ` – ${l.shop}` : ''}${l.cost_cents ? ` – ${money(l.cost_cents)}` : ''}`);
    for (const i of t.items.filter((x) => x.state !== 'ok')) lines.push(`   ${ICON[i.state]} ${i.name}: ${i.note}`);
    const next = t.items.find((x) => x.state === 'ok' && x.note);
    if (next && !t.items.some((x) => x.state !== 'ok')) lines.push(`   ✅ Tudo em dia. Próximo: ${next.name} (${next.note})`);
    if (t.expenses_cents) lines.push(`   💵 Gastos da semana: ${money(t.expenses_cents)}`);
  }
  if (link) lines.push('', `📄 PDF: ${link}`);
  return lines.join('\n');
}

// Roda uma vez por dia junto com o aviso da manhã.
// Segunda (ou o primeiro dia depois, se o servidor estava parado): relatório da semana passada para o dono.
async function daily({ ctx, day }) {
  const monday = mondayOf(day);
  const trucks = listTrucks(ctx);
  if (!trucks.length) return;
  const send = async (phone, text) => {
    try {
      await ctx.send(phone, text);
    } catch (err) {
      ctx.log(`Não consegui mandar a mensagem da manutenção para ${phone}`, err);
    }
  };

  const lastWeek = addDays(monday, -7);
  if (getSetting(ctx, 'frota_relatorio') !== lastWeek) {
    setSetting(ctx, 'frota_relatorio', lastWeek);
    const text = weekText(weekReport(ctx, lastWeek), weekLink(ctx, lastWeek));
    for (const owner of ctx.db.prepare("SELECT * FROM users WHERE role = 'dono' AND active = 1").all()) await send(owner.phone, text);
  }
}

// Caminhões do motorista que ainda não tiveram a milhagem informada desde o começo da semana.
function missingMileage(ctx, driverId, week) {
  const from = dayStart(ctx, week);
  return ctx.db
    .prepare(
      `SELECT t.* FROM trucks t WHERE t.active = 1 AND t.driver_id = ?
       AND NOT EXISTS (SELECT 1 FROM odometer_readings r WHERE r.truck_id = t.id AND r.at >= ? AND r.user_id IS NOT NULL)
       ORDER BY t.id`
    )
    .all(driverId, from);
}

const mileageExample = (trucks) => (trucks.length > 1 ? `odometro ${simplify(trucks[0].name).split(' ')[0]} 123456` : 'odometro 123456');

// Mensagem de bloqueio, ou null se o motorista pode ver os serviços.
function blockServices({ ctx, user }) {
  if (!user || user.role === 'dono') return null;
  const row = ctx.db.prepare('SELECT * FROM mileage_chase WHERE driver_id = ? AND blocked_at IS NOT NULL ORDER BY week DESC LIMIT 1').get(user.id);
  if (!row) return null;
  const missing = missingMileage(ctx, user.id, row.week);
  if (!missing.length) return null;
  return `🚫 Sua lista de serviços está suspensa até você mandar a milhagem do ${missing.map((t) => t.name).join(' e ')}.\nMande: *${mileageExample(missing)}* (ou no painel, em Mais › Caminhões).`;
}

// Roda a cada 10 minutos.
async function tick({ ctx, now = new Date() }) {
  const hour0 = ctx.config.dailyHour;
  if (hour0 == null) return;
  const day = localDay(ctx, now);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: ctx.config.timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now));
  if (!CHASE_DAYS.includes(weekday(day)) || hour < hour0) return;
  const week = mondayOf(day);
  const drivers = ctx.db
    .prepare('SELECT DISTINCT u.* FROM users u JOIN trucks t ON t.driver_id = u.id AND t.active = 1 WHERE u.active = 1')
    .all();
  const send = async (phone, text) => {
    try {
      await ctx.send(phone, text);
    } catch (err) {
      ctx.log(`Não consegui mandar a cobrança da milhagem para ${phone}`, err);
    }
  };
  for (const u of drivers) {
    const missing = missingMileage(ctx, u.id, week);
    if (!missing.length) continue;
    ctx.db.prepare('INSERT OR IGNORE INTO mileage_chase (driver_id, week) VALUES (?, ?)').run(u.id, week);
    const row = ctx.db.prepare('SELECT * FROM mileage_chase WHERE driver_id = ? AND week = ?').get(u.id, week);
    if (row.blocked_at) continue;
    const waited = !row.last_at || now.getTime() - Date.parse(row.last_at) >= HOUR - 60000;
    if (!waited) continue;
    const names = missing.map((t) => t.name).join(' e ');
    const first = u.name.split(' ')[0];
    if (row.count < CHASE_TIMES) {
      const n = row.count + 1;
      const last = n === CHASE_TIMES && u.role !== 'dono' ? '\n⚠️ Último aviso: se não mandar em 1 hora, sua lista de serviços fica suspensa.' : '';
      ctx.db.prepare('UPDATE mileage_chase SET count = ?, last_at = ? WHERE driver_id = ? AND week = ?').run(n, now.toISOString(), u.id, week);
      await send(u.phone, `📏 ${first}, falta a milhagem do ${names} desta semana (aviso ${n} de ${CHASE_TIMES}).\nOlhe o painel do caminhão e mande: *${mileageExample(missing)}*${last}`);
    } else if (u.role !== 'dono') {
      ctx.db.prepare('UPDATE mileage_chase SET blocked_at = ? WHERE driver_id = ? AND week = ?').run(now.toISOString(), u.id, week);
      await send(u.phone, blockServices({ ctx, user: u }));
      for (const owner of ctx.db.prepare("SELECT * FROM users WHERE role = 'dono' AND active = 1").all()) {
        await send(owner.phone, `🚫 ${u.name} não mandou a milhagem do ${names} depois de ${CHASE_TIMES} avisos. A lista de serviços dele está suspensa até ele mandar (ou até você atualizar as milhas em Caminhões).`);
      }
    }
  }
}

function publicRoutes(app, ctx) {
  app.get('/frota/:token/:start.pdf', async (req, res, next) => {
    try {
      const token = getSetting(ctx, 'frota_token');
      const a = Buffer.from(String(req.params.token));
      const b = Buffer.from(token || '');
      if (!token || a.length !== b.length || !crypto.timingSafeEqual(a, b) || !isDay(req.params.start)) {
        res.status(404).send('Não encontrado');
        return;
      }
      await sendWeekPdf(ctx, res, req.params.start);
    } catch (err) {
      next(err);
    }
  });
}

function setup(ctx) {
  ctx.api.manutencao = {
    get: (id) => getTruck(ctx, id),
    // Caminhão do motorista; se só existe um caminhão, é ele.
    truckFor(userId) {
      const mine = ctx.db.prepare('SELECT * FROM trucks WHERE active = 1 AND driver_id = ? ORDER BY id').all(userId);
      if (mine.length === 1) return mine[0];
      const all = ctx.db.prepare('SELECT * FROM trucks WHERE active = 1').all();
      return all.length === 1 ? all[0] : null;
    },
    // Caminhão citado pelo nome ou placa nas palavras ("f-550", "f550").
    findTruck(words) {
      const norm = (t) => simplify(t).replace(/[^a-z0-9]/g, '');
      const ws = words.map(norm).filter((w) => w.length > 1);
      const found = ctx.db
        .prepare('SELECT * FROM trucks WHERE active = 1')
        .all()
        .filter((t) => ws.some((w) => w === norm(t.name) || (t.plate && w === norm(t.plate)) || simplify(t.name).split(/\s+/).map(norm).includes(w)));
      return found.length === 1 ? found[0] : null;
    },
  };
}

export default {
  name: 'manutencao',
  setup,
  label: 'Manutenção do caminhão',
  migrations,
  commands,
  routes,
  publicRoutes,
  alerts,
  daily,
  tick,
  blockServices,
  exportSheets,
};
