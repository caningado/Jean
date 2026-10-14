import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE } from './helpers.js';

test('endereço da oficina/dealer vira apelido sozinho', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) }))
    .headers.get('set-cookie').split(';')[0];
  const call = (method, path, body) =>
    fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());
  const places = () => ctx.db.prepare('SELECT nickname, address FROM saved_places ORDER BY id').all().map((p) => ({ ...p }));

  // Sem endereço próprio: usa o Bill to (depois da linha do nome).
  const moving = await call('POST', '/companies', { name: 'Moving', bill_to: 'Moving\n100 Main St\nOrlando FL 32801' });
  assert.deepEqual(places(), [{ nickname: 'Moving', address: '100 Main St, Orlando FL 32801' }]);

  // Endereço próprio e apelido: o apelido passa a ser o da empresa.
  await call('PATCH', `/companies/${moving.id}`, { nickname: 'MV', address: '5 Dock Rd, Sanford FL' });
  assert.deepEqual(places(), [{ nickname: 'MV', address: '5 Dock Rd, Sanford FL' }]);

  // No Novo serviço, o apelido vira o endereço no destino.
  const s = await call('POST', '/services', { contact_name: 'Ana', pickup: '1 A St', dropoff: 'mv', driver_id: 1 });
  assert.equal(s.dropoff, '5 Dock Rd, Sanford FL', JSON.stringify(s));

  // O nome da empresa também vale, mesmo com outro apelido: "Moving" na lista e no destino.
  const sug = await call('GET', '/places?q=moving');
  assert.deepEqual(sug.saved, [{ nickname: 'MV · Moving', address: '5 Dock Rd, Sanford FL' }]);
  const s2 = await call('POST', '/services', { contact_name: 'Bia', pickup: '1 A St', dropoff: 'Moving', driver_id: 1 });
  assert.equal(s2.dropoff, '5 Dock Rd, Sanford FL', JSON.stringify(s2));

  // Bill to numa linha só: tira o nome e usa o resto.
  await call('POST', '/companies', { name: 'Ace Auto', bill_to: 'Ace Auto, 9 Pine St, Oviedo FL' });
  assert.equal(ctx.db.prepare("SELECT address FROM saved_places WHERE key = 'ace auto'").get()?.address, '9 Pine St, Oviedo FL');

  // Apagar a empresa apaga o apelido dela.
  await call('DELETE', `/companies/${moving.id}`);
  assert.deepEqual(places().map((p) => p.nickname), ['Ace Auto']);
});
