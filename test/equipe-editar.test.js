import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';

test('Equipe: o ADM edita nome, telefone, PIN e função de quem é da equipe', async (t) => {
  const ctx = makeContext();
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone, pin) =>
    fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) });
  const adm = (await login(OWNER_PHONE, '1234')).headers.get('set-cookie').split(';')[0];
  const patch = (id, body) => fetch(`${base}/api/users/${id}`, { method: 'PATCH', headers: { Cookie: adm, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const id = (phone) => ctx.db.prepare('SELECT id FROM users WHERE phone = ?').get(phone).id;
  const jorge = id(DRIVER_PHONE);

  const r = await patch(jorge, { name: 'Jorge Silva', phone: '(508) 555-0199', pin: '4321', role: 'dono' });
  assert.equal(r.status, 200);
  const u = await r.json();
  assert.equal(u.name, 'Jorge Silva');
  assert.equal(u.role, 'dono');
  assert.equal((await login(u.phone, '4321')).status, 200);

  // Volta a ser motorista; o ADM não tira o próprio ADM nem usa telefone de outro.
  assert.equal((await (await patch(jorge, { role: 'motorista' })).json()).role, 'motorista');
  assert.equal((await patch(id(OWNER_PHONE), { role: 'motorista' })).status, 400);
  assert.equal((await patch(jorge, { phone: OWNER_PHONE })).status, 409);

});
