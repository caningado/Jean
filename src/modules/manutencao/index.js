// Módulo de manutenção: caminhões, milhagem e o que precisa trocar (óleo, pneus, freios,
// inspeção, registro). Avisa quando está perto ou já passou.
import { simplify, nowIso, HttpError } from '../../lib/util.js';

const DAY = 86400000;
// "Perto" = faltam menos que isso.
const NEAR_MILES = 500;
const NEAR_DAYS = 15;
// Pede para atualizar as milhas se ninguém mandou há mais que isso.
const STALE_DAYS = 14;

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
];

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
  if (item.every_miles) {
    miles_left = (item.last_miles ?? 0) + item.every_miles - truck.odometer;
    if (miles_left <= 0) {
      worse('vencido');
      notes.push(`passou ${fmtMiles(-miles_left)}`);
    } else {
      if (miles_left <= NEAR_MILES) worse('perto');
      notes.push(`faltam ${fmtMiles(miles_left)}`);
    }
  }
  if (item.every_days) {
    const due = new Date(item.last_date || item.created_at).getTime() + item.every_days * DAY;
    days_left = Math.ceil((due - now) / DAY);
    const date = fmtDate(new Date(due).toISOString());
    if (days_left <= 0) {
      worse('vencido');
      notes.push(`venceu em ${date}`);
    } else {
      if (days_left <= NEAR_DAYS) worse('perto');
      notes.push(`até ${date}`);
    }
  }
  return { state, miles_left, days_left, note: notes.join(' ou ') };
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

function createTruck(ctx, { name, plate = null, odometer = 0, driverId = null }) {
  const now = nowIso();
  const info = ctx.db
    .prepare('INSERT INTO trucks (name, plate, driver_id, odometer, odometer_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, plate, driverId, odometer, now, now);
  const id = Number(info.lastInsertRowid);
  const add = ctx.db.prepare(
    'INSERT INTO maintenance_items (truck_id, name, every_miles, every_days, last_miles, last_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const item of DEFAULT_ITEMS) add.run(id, item.name, item.every_miles, item.every_days, odometer, now, now);
  return getTruck(ctx, id);
}

function setOdometer(ctx, truck, miles) {
  ctx.db.prepare('UPDATE trucks SET odometer = ?, odometer_at = ? WHERE id = ?').run(miles, nowIso(), truck.id);
  return getTruck(ctx, truck.id);
}

function markDone(ctx, { truck, item, miles, userId, notes = null }) {
  const at = miles ?? truck.odometer;
  const now = nowIso();
  if (at > truck.odometer) truck = setOdometer(ctx, truck, at);
  ctx.db.prepare('UPDATE maintenance_items SET last_miles = ?, last_date = ? WHERE id = ?').run(at, now, item.id);
  ctx.db
    .prepare('INSERT INTO maintenance_log (truck_id, item_id, item_name, miles, user_id, notes, done_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(truck.id, item.id, item.name, at, userId, notes, now);
  return ctx.db.prepare('SELECT * FROM maintenance_items WHERE id = ?').get(item.id);
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
      const updated = setOdometer(ctx, truck, miles);
      const [t] = listTrucks(ctx).filter((x) => x.id === updated.id);
      const attention = t.items.filter((i) => i.state !== 'ok').map((i) => `${ICON[i.state]} ${i.name}: ${i.note}`);
      return [`📏 ${t.name}: ${fmtMiles(miles)} registrado.`, ...attention].join('\n');
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
      const item = markDone(ctx, { truck, item: found[0], miles, userId: user.id });
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
      setOdometer(ctx, truck, miles);
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
    res.status(201).json(markDone(ctx, { truck, item, miles, userId: req.user.id, notes: req.body?.notes || null }));
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
        { header: 'Quem registrou', width: 16 },
        { header: 'Obs.', width: 30 },
      ],
      rows: rows.map((r) => [r.done_at, r.truck_name, r.item_name, r.miles, r.user_name || '', r.notes || '']),
    },
  ];
}

export default {
  name: 'manutencao',
  label: 'Manutenção do caminhão',
  migrations,
  commands,
  routes,
  alerts,
  exportSheets,
};
