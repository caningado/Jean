import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE } from './helpers.js';

test('Clientes: recent=1 traz os mais novos primeiro', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const n of ['Zeca', 'Ana', 'Bruno', 'Carla', 'Davi', 'Eva', 'Fabio']) ctx.data.contacts.create({ name: n });
  const get = (p) => fetch(`${base}/api${p}`, { headers: { Cookie: cookie } });
  const r = await get('/contacts?recent=1&limit=5');
  assert.deepEqual((await r.json()).map((c) => c.name), ['Fabio', 'Eva', 'Davi', 'Carla', 'Bruno']);
  assert.equal(r.headers.get('X-Total-Count'), '7');
  // Sem recent continua em ordem alfabética.
  assert.equal((await (await get('/contacts?limit=1')).json())[0].name, 'Ana');
});
