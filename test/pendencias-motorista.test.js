import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';

test('Pendências: o motorista vê só as dele; o ADM vê todas', async (t) => {
  const ctx = makeContext();
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone, pin) =>
    (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers
      .get('set-cookie')
      .split(';')[0];
  const adm = await login(OWNER_PHONE, '1234');
  const drv = await login(DRIVER_PHONE, '5678');
  const call = async (cookie, method, path, body) =>
    (await fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })).json();
  const jorge = ctx.db.prepare('SELECT id FROM users WHERE phone = ?').get(DRIVER_PHONE).id;
  const dono = ctx.db.prepare('SELECT id FROM users WHERE phone = ?').get(OWNER_PHONE).id;

  await call(adm, 'POST', '/services', { contact_name: 'Ana Lima', pickup: '1 Main St, Oviedo FL', driver_id: jorge, price: 150 });
  await call(adm, 'POST', '/services', { contact_name: 'Bia Souza', pickup: '2 Main St, Oviedo FL', driver_id: dono, price: 200 });

  const mine = await call(drv, 'GET', '/payments/pending');
  assert.deepEqual(mine.map((s) => s.contact_name), ['Ana Lima']);
  const all = await call(adm, 'GET', '/payments/pending');
  assert.deepEqual(all.map((s) => s.contact_name).sort(), ['Ana Lima', 'Bia Souza']);
  const resumo = await call(drv, 'GET', '/summary');
  assert.equal(resumo.open_cents, 15000);
});
