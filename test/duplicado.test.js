import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE } from './helpers.js';

test('toque duplo em "Criar serviço" não cria dois serviços', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) }))
    .headers.get('set-cookie').split(';')[0];
  const post = (b) => fetch(`${base}/api/services`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

  const body = { contact_name: 'Ana Lima', contact_phone: '(407) 555-0199', pickup: '1 Main St' };
  const [a, b] = await Promise.all([post(body), post(body)]);
  assert.equal(a.id, b.id);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM services').get().n, 1);
  // Outro endereço é outro serviço.
  const c = await post({ ...body, pickup: '2 Main St' });
  assert.notEqual(c.id, a.id);
});
