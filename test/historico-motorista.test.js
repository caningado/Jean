import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';

// Pedido do dono (18/11): o motorista não vê o histórico do serviço; o ADM vê.
test('histórico do serviço: o ADM vê, o motorista não', async (t) => {
  const ctx = makeContext();
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const as = async (phone, pin) => {
    const login = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    return (path) => fetch(base + path, { headers: { Cookie: cookie } }).then((r) => r.json());
  };
  const driver = ctx.bot.findUser(DRIVER_PHONE);
  const s = ctx.data.services.create({ pickup: '12 Main St, Orlando FL', driver_id: driver.id });
  ctx.db.prepare("INSERT INTO service_events (service_id, action, user_id, source, created_at) VALUES (?, 'fotos_anexadas', ?, 'claude', ?)").run(s.id, driver.id, new Date().toISOString());
  const owner = await as(OWNER_PHONE, '1234');
  const motorista = await as(DRIVER_PHONE, '5678');
  assert.equal((await owner(`/services/${s.id}`)).events.length, 1);
  const seen = await motorista(`/services/${s.id}`);
  assert.equal(seen.id, s.id);
  assert.deepEqual(seen.events, []);
});
