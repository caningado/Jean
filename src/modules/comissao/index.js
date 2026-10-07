// Módulo comissão: quanto pagar a cada motorista.
// Regra do Caningado: a % depende do faturamento do motorista no mês (padrão: 30% até $5.000,
// 35% a partir de $5.000, 40% a partir de $10.000). Toda semana paga o faturamento da semana
// vezes a % do faturamento do mês até aquela semana. No fim do mês faz o acerto: faturamento do
// mês vezes a % final, menos o que já pagou nas semanas.
import { nowIso, formatMoney, parseMoney, simplify, HttpError } from '../../lib/util.js';
import { monthRange } from '../planilha/index.js';
import { renderDriverStatement } from './extrato.js';

export const DEFAULT_TIERS = [
  { from_cents: 0, pct: 30 },
  { from_cents: 500000, pct: 35 },
  { from_cents: 1000000, pct: 40 },
];

const migrations = [
  `CREATE TABLE driver_payments (
     id INTEGER PRIMARY KEY,
     driver_id INTEGER NOT NULL REFERENCES users(id),
     month TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('semanal', 'acerto')),
     week_start TEXT,
     amount_cents INTEGER NOT NULL,
     notes TEXT,
     created_by INTEGER REFERENCES users(id),
     created_at TEXT NOT NULL
   );
   CREATE INDEX driver_payments_month ON driver_payments(driver_id, month);`,
];

export function getTiers(ctx) {
  try {
    const row = ctx.db.prepare("SELECT value FROM settings WHERE key = 'comissao'").get();
    const tiers = row && JSON.parse(row.value).tiers;
    if (Array.isArray(tiers) && tiers.length) return tiers;
  } catch {}
  return DEFAULT_TIERS;
}

export function rateFor(tiers, revenueCents) {
  let pct = tiers[0].pct;
  for (const t of [...tiers].sort((a, b) => a.from_cents - b.from_cents)) if (revenueCents >= t.from_cents) pct = t.pct;
  return pct;
}

const localDay = (ctx, iso) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ctx.config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

// Segunda-feira da semana do dia ("2026-10-07" -> "2026-10-05"), sem sair do mês.
function weekStart(day) {
  const d = new Date(`${day}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  const monday = d.toISOString().slice(0, 10);
  return monday.slice(0, 7) === day.slice(0, 7) ? monday : `${day.slice(0, 7)}-01`;
}

// Semanas do mês: [{ start, end }], segunda a domingo, cortadas no começo e no fim do mês.
function monthWeeks(mes) {
  const [y, m] = mes.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const weeks = [];
  for (let d = 1; d <= last; d++) {
    const day = `${mes}-${String(d).padStart(2, '0')}`;
    const start = weekStart(day);
    if (!weeks.length || weeks[weeks.length - 1].start !== start) weeks.push({ start, end: day });
    else weeks[weeks.length - 1].end = day;
  }
  return weeks;
}

const drivers = (ctx) => ctx.db.prepare("SELECT id, name, phone, active FROM users WHERE role = 'motorista' ORDER BY name").all();

// Tudo do mês de um motorista: serviços, semanas, % e acerto.
export function driverMonth(ctx, driver, mes, today = localDay(ctx, nowIso())) {
  const range = monthRange(mes, ctx.config.timeZone);
  if (range.label === 'tudo') throw new HttpError(400, 'Escolha o mês.');
  const tiers = getTiers(ctx);
  const services = ctx.db
    .prepare(
      `SELECT s.id, s.price_cents, s.vehicle, s.completed_at, s.created_at, c.name AS contact_name
       FROM services s LEFT JOIN contacts c ON c.id = s.contact_id
       WHERE s.driver_id = ? AND s.status = 'concluido' AND s.price_cents > 0
         AND COALESCE(s.completed_at, s.created_at) >= ? AND COALESCE(s.completed_at, s.created_at) < ?
       ORDER BY COALESCE(s.completed_at, s.created_at)`
    )
    .all(driver.id, range.from, range.to)
    .map((s) => ({ ...s, day: localDay(ctx, s.completed_at || s.created_at) }));
  const payments = ctx.db.prepare('SELECT * FROM driver_payments WHERE driver_id = ? AND month = ? ORDER BY id').all(driver.id, range.label);

  let running = 0;
  const weeks = monthWeeks(range.label).map((w) => {
    const list = services.filter((s) => s.day >= w.start && s.day <= w.end);
    const revenue = list.reduce((t, s) => t + s.price_cents, 0);
    running += revenue;
    const pct = rateFor(tiers, running);
    const paid = payments.filter((p) => p.kind === 'semanal' && p.week_start === w.start);
    return {
      ...w,
      services: list.length,
      revenue_cents: revenue,
      month_to_date_cents: running,
      pct,
      amount_cents: Math.round((revenue * pct) / 100),
      paid_cents: paid.reduce((t, p) => t + p.amount_cents, 0),
      paid_at: paid.length ? paid[paid.length - 1].created_at : null,
      closed: w.end < today,
      current: w.start <= today && today <= w.end,
    };
  });

  const revenue = running;
  const pct = rateFor(tiers, revenue);
  const commission = Math.round((revenue * pct) / 100);
  const weeklyPaid = payments.filter((p) => p.kind === 'semanal').reduce((t, p) => t + p.amount_cents, 0);
  const settled = payments.filter((p) => p.kind === 'acerto').reduce((t, p) => t + p.amount_cents, 0);
  const next = [...tiers].sort((a, b) => a.from_cents - b.from_cents).find((t) => t.from_cents > revenue);
  return {
    mes: range.label,
    timeZone: ctx.config.timeZone,
    driver: { id: driver.id, name: driver.name },
    tiers,
    services,
    weeks,
    revenue_cents: revenue,
    pct,
    commission_cents: commission,
    weekly_paid_cents: weeklyPaid,
    settlement_cents: commission - weeklyPaid,
    settled_cents: settled,
    month_over: range.to <= nowIso(),
    next_tier: next ? { pct: next.pct, missing_cents: next.from_cents - revenue } : null,
    payments,
  };
}

const thisMonth = (ctx) => localDay(ctx, nowIso()).slice(0, 7);

function findDriver(ctx, user, text) {
  if (user.role !== 'dono') return drivers(ctx).find((d) => d.id === user.id) || null;
  const q = simplify(text);
  const all = drivers(ctx).filter((d) => d.active);
  if (!q) return all.length === 1 ? all[0] : null;
  const found = all.filter((d) => simplify(d.name).split(/\s+/).some((w) => w.startsWith(q)) || simplify(d.name).startsWith(q));
  return found.length === 1 ? found[0] : null;
}

const commands = [
  {
    names: ['comissao', 'semana', 'ganhos'],
    help: '*comissao* – faturamento e quanto o motorista recebe na semana e no mês (dono: *comissao Jorge*)',
    run({ ctx, user, rawArgs }) {
      const driver = findDriver(ctx, user, rawArgs);
      if (!driver) {
        if (user.role !== 'dono') return 'A comissão é só para motoristas.';
        const names = drivers(ctx).filter((d) => d.active).map((d) => d.name.split(' ')[0]);
        return names.length ? `De qual motorista? Ex: *comissao ${names[0]}*` : 'Nenhum motorista cadastrado.';
      }
      const m = driverMonth(ctx, driver, thisMonth(ctx));
      const week = m.weeks.find((w) => w.current) || m.weeks[m.weeks.length - 1];
      const lines = [
        `*${driver.name} – ${m.mes.slice(5)}/${m.mes.slice(0, 4)}*`,
        `Esta semana: ${formatMoney(week.revenue_cents)} faturado → ${formatMoney(week.amount_cents)} (${week.pct}%)`,
        `No mês: ${formatMoney(m.revenue_cents)} faturado → ${m.pct}% = ${formatMoney(m.commission_cents)}`,
        `Já pago nas semanas: ${formatMoney(m.weekly_paid_cents)}`,
      ];
      if (m.next_tier) lines.push(`Faltam ${formatMoney(m.next_tier.missing_cents)} de faturamento para ${m.next_tier.pct}%.`);
      return lines.join('\n');
    },
  },
];

function routes(api, ctx) {
  const driverOf = (req) => {
    const d = drivers(ctx).find((x) => x.id === Number(req.params.driverId));
    if (!d || (req.user.role !== 'dono' && d.id !== req.user.id)) throw new HttpError(404, 'Motorista não encontrado.');
    return d;
  };
  const owner = (req) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o dono faz isso.');
  };
  const mesOf = (req) => (/^\d{4}-\d{2}$/.test(String(req.query.mes || req.body?.mes)) ? String(req.query.mes || req.body.mes) : thisMonth(ctx));

  api.get('/comissao', (req, res) => {
    const mes = mesOf(req);
    const list = req.user.role === 'dono' ? drivers(ctx) : drivers(ctx).filter((d) => d.id === req.user.id);
    res.json({
      mes,
      tiers: getTiers(ctx),
      drivers: list.map((d) => {
        const m = driverMonth(ctx, d, mes);
        return { id: d.id, name: d.name, active: !!d.active, revenue_cents: m.revenue_cents, pct: m.pct, commission_cents: m.commission_cents, weekly_paid_cents: m.weekly_paid_cents, settlement_cents: m.settlement_cents };
      }),
    });
  });

  api.put('/comissao/faixas', (req, res) => {
    owner(req);
    const tiers = (req.body?.tiers || []).map((t) => ({ from_cents: Math.max(0, parseMoney(String(t.from ?? '0')) || 0), pct: Number(t.pct) }));
    if (!tiers.length || tiers.some((t) => !(t.pct >= 0 && t.pct <= 100))) throw new HttpError(400, 'Porcentagem inválida.');
    tiers.sort((a, b) => a.from_cents - b.from_cents);
    tiers[0].from_cents = 0;
    ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('comissao', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ tiers }));
    res.json(tiers);
  });

  api.get('/comissao/:driverId', (req, res) => {
    res.json(driverMonth(ctx, driverOf(req), mesOf(req)));
  });

  // Dono registra o pagamento da semana (ou o acerto do mês).
  api.post('/comissao/:driverId/pagamentos', (req, res) => {
    owner(req);
    const d = driverOf(req);
    const mes = mesOf(req);
    const kind = req.body?.kind === 'acerto' ? 'acerto' : 'semanal';
    const m = driverMonth(ctx, d, mes);
    let weekStartDay = null;
    let suggested;
    if (kind === 'semanal') {
      const w = m.weeks.find((x) => x.start === req.body?.week_start);
      if (!w) throw new HttpError(400, 'Semana inválida.');
      weekStartDay = w.start;
      suggested = w.amount_cents - w.paid_cents;
    } else suggested = m.settlement_cents - m.settled_cents;
    const raw = req.body?.amount;
    const amountCents = raw == null || raw === '' ? suggested : parseMoney(String(raw));
    if (amountCents == null || Math.abs(amountCents) > 10_000_000) throw new HttpError(400, 'Valor inválido.');
    if (amountCents === 0) throw new HttpError(400, 'Nada a pagar.');
    ctx.db
      .prepare('INSERT INTO driver_payments (driver_id, month, kind, week_start, amount_cents, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(d.id, mes, kind, weekStartDay, amountCents, req.body?.notes || null, req.user.id, nowIso());
    res.status(201).json(driverMonth(ctx, d, mes));
  });

  api.delete('/comissao/pagamentos/:id', (req, res) => {
    owner(req);
    ctx.db.prepare('DELETE FROM driver_payments WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  api.get('/comissao/:driverId/extrato.pdf', async (req, res) => {
    const d = driverOf(req);
    const data = driverMonth(ctx, d, mesOf(req));
    // ?semana=2026-10-05: PDF da semana; sem semana: fechamento do mês.
    const week = data.weeks.find((w) => w.start === req.query.semana)?.start || null;
    const buf = await renderDriverStatement({
      company: ctx.api.invoice?.getCompany() || { name: ctx.config.companyName },
      logo: ctx.api.invoice ? ctx.api.invoice.logo() : null,
      data,
      week,
    });
    const name = `${week ? `Semana ${week}` : `Fechamento ${data.mes}`} ${d.name}.pdf`.replace(/[^\w &.-]/g, '');
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${name}"`);
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  });
}

export default {
  name: 'comissao',
  label: 'Comissão dos motoristas',
  migrations,
  commands,
  routes,
};
