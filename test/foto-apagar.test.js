import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';

test('Apagar foto: motorista só enquanto o serviço não foi entregue; dono sempre', async (t) => {
  const ctx = makeContext();
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone, pin) =>
    (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers.get('set-cookie').split(';')[0];
  const dono = await login(OWNER_PHONE, '1234');
  const jorge = await login(DRIVER_PHONE, '5678');
  const call = (c, method, path, body, type = 'application/json') =>
    fetch(`${base}/api${path}`, { method, headers: { Cookie: c, 'Content-Type': type }, body: body && (type === 'application/json' ? JSON.stringify(body) : body) });
  const jpg = Buffer.from([255, 216, 255, 217]);

  const s = await (await call(dono, 'POST', '/services', { contact_name: 'Ana', pickup: '12 Main St, Orlando FL', price: '150' })).json();
  const driverId = ctx.db.prepare('SELECT id FROM users WHERE phone = ?').get(DRIVER_PHONE).id;
  ctx.db.prepare("UPDATE services SET driver_id = ?, status = 'aberto' WHERE id = ?").run(driverId, s.id);
  const foto = async () => (await (await call(jorge, 'POST', `/services/${s.id}/photos?kind=antes&angle=frente`, jpg, 'image/jpeg')).json()).id;

  // Durante o serviço o motorista apaga.
  const a = await foto();
  assert.equal((await call(jorge, 'DELETE', `/photos/${a}`)).status, 200);

  // Entregue: o motorista não apaga mais, o dono sim.
  const b = await foto();
  ctx.db.prepare("UPDATE services SET status = 'concluido' WHERE id = ?").run(s.id);
  const negado = await call(jorge, 'DELETE', `/photos/${b}`);
  assert.equal(negado.status, 403);
  assert.match((await negado.json()).error, /só o ADM/);
  assert.equal((await call(dono, 'DELETE', `/photos/${b}`)).status, 200);
});
