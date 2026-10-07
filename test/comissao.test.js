import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, chat, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';
import { driverMonth, rateFor, DEFAULT_TIERS } from '../src/modules/comissao/index.js';

function done(ctx, driverId, price, iso) {
  const s = ctx.data.services.create({ pickup: '12 Main St', price_cents: price, driver_id: driverId });
  ctx.db.prepare("UPDATE services SET status = 'concluido', created_at = ?, completed_at = ? WHERE id = ?").run(iso, iso, s.id);
  return s;
}

test('faixas: 30% abaixo de $5.000, 35% a partir de $5.000, 40% a partir de $10.000', () => {
  assert.equal(rateFor(DEFAULT_TIERS, 499999), 30);
  assert.equal(rateFor(DEFAULT_TIERS, 500000), 35);
  assert.equal(rateFor(DEFAULT_TIERS, 999999), 35);
  assert.equal(rateFor(DEFAULT_TIERS, 1000000), 40);
});

test('semana paga com a % do mês até ali; fechamento acerta pela % final', async (t) => {
  const ctx = makeContext();
  const driver = ctx.db.prepare('SELECT * FROM users WHERE phone = ?').get(DRIVER_PHONE);
  // Setembro de 2026: 1º é terça. Semanas: 1–6, 7–13, 14–20, 21–27, 28–30.
  done(ctx, driver.id, 300000, '2026-09-02T16:00:00Z');
  done(ctx, driver.id, 250000, '2026-09-08T16:00:00Z');
  done(ctx, driver.id, 200000, '2026-09-15T16:00:00Z');
  done(ctx, driver.id, 300000, '2026-09-17T16:00:00Z');
  // Cancelado e de outro mês não contam.
  const c = done(ctx, driver.id, 99900, '2026-09-18T16:00:00Z');
  ctx.db.prepare("UPDATE services SET status = 'cancelado' WHERE id = ?").run(c.id);
  done(ctx, driver.id, 50000, '2026-10-01T16:00:00Z');

  let m = driverMonth(ctx, driver, '2026-09', '2026-10-07');
  assert.deepEqual(m.weeks.map((w) => [w.start, w.end]), [
    ['2026-09-01', '2026-09-06'], ['2026-09-07', '2026-09-13'], ['2026-09-14', '2026-09-20'], ['2026-09-21', '2026-09-27'], ['2026-09-28', '2026-09-30'],
  ]);
  assert.deepEqual(m.weeks.slice(0, 3).map((w) => [w.revenue_cents, w.pct, w.amount_cents]), [
    [300000, 30, 90000],
    [250000, 35, 87500],
    [500000, 40, 200000],
  ]);
  assert.equal(m.revenue_cents, 1050000);
  assert.equal(m.pct, 40);
  assert.equal(m.commission_cents, 420000);
  assert.equal(m.settlement_cents, 420000);

  // Dono registra as semanas pelo painel.
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone, pin) =>
    (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers.get('set-cookie').split(';')[0];
  const owner = await login(OWNER_PHONE, '1234');
  const drv = await login(DRIVER_PHONE, '5678');
  const pay = (body, cookie = owner) =>
    fetch(`${base}/api/comissao/${driver.id}/pagamentos`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ mes: '2026-09', ...body }) });
  assert.equal((await pay({ week_start: '2026-09-01' }, drv)).status, 403);
  for (const w of ['2026-09-01', '2026-09-07', '2026-09-14']) assert.equal((await pay({ week_start: w })).status, 201);
  m = driverMonth(ctx, driver, '2026-09', '2026-10-07');
  assert.equal(m.weekly_paid_cents, 377500);
  assert.equal(m.settlement_cents, 42500, 'acerto = 4.200 − 3.775');
  assert.equal((await pay({ kind: 'acerto' })).status, 201);
  m = driverMonth(ctx, driver, '2026-09', '2026-10-07');
  assert.equal(m.settled_cents, 42500);

  for (const q of ['', '&semana=2026-09-14']) {
    const pdf = await fetch(`${base}/api/comissao/${driver.id}/extrato.pdf?mes=2026-09${q}`, { headers: { Cookie: drv } });
    assert.equal(pdf.status, 200);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  }
  const list = await (await fetch(`${base}/api/comissao?mes=2026-09`, { headers: { Cookie: owner } })).json();
  assert.equal(list.drivers[0].commission_cents, 420000);
});

test('robô: motorista vê a semana e o mês', async () => {
  const ctx = makeContext();
  const driver = ctx.db.prepare('SELECT * FROM users WHERE phone = ?').get(DRIVER_PHONE);
  done(ctx, driver.id, 15000, new Date().toISOString());
  const [mine] = await chat(ctx, DRIVER_PHONE, 'comissao');
  assert.match(mine, /Esta semana: \$150\.00 faturado → \$45\.00 \(30%\)/);
  assert.match(mine, /Faltam \$4,850\.00 de faturamento para 35%/);
  const [own] = await chat(ctx, OWNER_PHONE, 'comissao jorge');
  assert.match(own, /Jorge/);
});
