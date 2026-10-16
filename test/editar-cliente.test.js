import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE } from './helpers.js';

test('Editar serviço: troca o cliente (quem pediu)', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (method, path, body) => fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const json = (...a) => call(...a).then((r) => r.json());

  const s = await json('POST', '/services', { contact_name: 'Ana', pickup: '12 Main St, Orlando FL' });
  const edy = await json('POST', '/contacts', { name: 'Edy', phone: '4075550133' });
  const updated = await json('PATCH', `/services/${s.id}`, { contact_id: edy.id });
  assert.equal(updated.contact_id, edy.id);
  assert.equal(updated.contact_name, 'Edy');
  assert.equal((await call('PATCH', `/services/${s.id}`, { contact_id: 99999 })).status, 400);
  // Salvar sem mexer no cliente não apaga o cliente.
  assert.equal((await json('PATCH', `/services/${s.id}`, { notes: 'x' })).contact_id, edy.id);
});
