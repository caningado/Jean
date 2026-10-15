import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE } from './helpers.js';

test('Lista de serviços (Todos) não mostra os cancelados', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const json = (method, path, body) => fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());
  const fica = await json('POST', '/services', { contact_name: 'Fica', pickup: '12 Main St, Orlando FL' });
  const sai = await json('POST', '/services', { contact_name: 'Sai', pickup: '12 Main St, Orlando FL' });
  await json('PATCH', `/services/${sai.id}`, { status: 'cancelado', motivo: 'cliente desistiu' });
  const ids = (await json('GET', '/services?status=')).map((s) => s.id);
  assert.ok(ids.includes(fica.id));
  assert.ok(!ids.includes(sai.id));
  // Continua guardado: abre pelo número.
  assert.equal((await json('GET', `/services/${sai.id}`)).status, 'cancelado');
});
