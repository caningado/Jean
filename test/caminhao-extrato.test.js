import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, chat, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';
import { truckMonth } from '../src/modules/manutencao/index.js';

test('despesas vão para o caminhão do motorista e o extrato do mês soma tudo', async (t) => {
  const ctx = makeContext();
  const driver = ctx.db.prepare('SELECT id FROM users WHERE phone = ?').get(DRIVER_PHONE);
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone, pin) =>
    (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers.get('set-cookie').split(';')[0];
  const owner = await login(OWNER_PHONE, '1234');
  const post = (path, body, cookie = owner) =>
    fetch(`${base}/api${path}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

  const f550 = await post('/trucks', { name: 'F-550', odometer: 100000, driver_id: driver.id });
  const ram = await post('/trucks', { name: 'Ram 5500', odometer: 50000 });

  const [diesel] = await chat(ctx, DRIVER_PHONE, 'gasto 120 diesel');
  assert.match(diesel, /registrada no F-550/);
  const [pneu] = await chat(ctx, OWNER_PHONE, 'gasto 300 pneu ram');
  assert.match(pneu, /registrada no Ram 5500/);
  const [geral] = await chat(ctx, OWNER_PHONE, 'gasto 40 almoco');
  assert.doesNotMatch(geral, /registrada no/);
  await post('/expenses', { amount: '80', category: 'pedagio', description: 'I-4', truck_id: f550.id });
  await chat(ctx, DRIVER_PHONE, 'odometro 101500', 'fiz oleo');

  const mes = new Intl.DateTimeFormat('en-CA', { timeZone: ctx.config.timeZone, year: 'numeric', month: '2-digit' }).format(new Date());
  const m = truckMonth(ctx, ctx.api.manutencao.get(f550.id), mes);
  assert.equal(m.total_cents, 20000);
  assert.deepEqual(m.by_category, { combustivel: 12000, pedagio: 8000 });
  assert.equal(m.miles, 1500);
  assert.equal(m.cost_per_mile_cents, 13);
  assert.equal(m.maintenance.length, 1);
  assert.equal(truckMonth(ctx, ctx.api.manutencao.get(ram.id), mes).total_cents, 30000);

  const pdf = await fetch(`${base}/api/trucks/${f550.id}/extrato.pdf?mes=${mes}`, { headers: { Cookie: owner } });
  assert.equal(pdf.status, 200);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  const drv = await login(DRIVER_PHONE, '5678');
  assert.equal((await fetch(`${base}/api/trucks/${f550.id}/extrato.pdf?mes=${mes}`, { headers: { Cookie: drv } })).status, 403);
});
