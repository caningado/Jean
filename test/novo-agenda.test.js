import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE } from './helpers.js';

test('novo serviço: busca o cliente pelo nome na agenda e traz telefone e último veículo', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) }))
    .headers.get('set-cookie').split(';')[0];
  const get = (p) => fetch(`${base}/api${p}`, { headers: { Cookie: cookie } }).then((r) => r.json());
  const post = (p, b) => fetch(`${base}/api${p}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

  const joao = ctx.data.contacts.create({ name: 'João Silva', phone: '13215550199' });
  ctx.data.contacts.create({ name: 'Maria Souza', phone: '13215550111' });
  ctx.data.contacts.create({ name: 'Jonas Pereira' });
  ctx.data.services.create({ pickup: '1 Main St', vehicle: 'Toyota Camry', plate: 'ABC1234', contact_id: joao.id });

  // Sem acento, minúsculo, pedaço do nome.
  const r = await get('/contacts/suggest?q=joao');
  assert.equal(r.length, 1);
  assert.equal(r[0].phone, '13215550199');
  assert.equal(r[0].last.vehicle, 'Toyota Camry');
  assert.equal(r[0].last.plate, 'ABC1234');
  assert.deepEqual((await get('/contacts/suggest?q=jo')).map((c) => c.name), ['João Silva', 'Jonas Pereira']);
  assert.deepEqual((await get('/contacts/suggest?q=silva jo')).map((c) => c.name), ['João Silva']);
  assert.equal((await get('/contacts/suggest?q=5550111'))[0].name, 'Maria Souza');
  assert.deepEqual(await get('/contacts/suggest?q=j'), []);

  // Escolhido da lista: usa o mesmo contato.
  const s1 = await post('/services', { contact_id: joao.id, contact_name: 'João Silva', contact_phone: '(321) 555-0199', pickup: '2 Main St' });
  assert.equal(s1.contact_id, joao.id);
  // Só o nome igual (sem escolher): não duplica.
  const jonas = await post('/services', { contact_name: 'jonas pereira', pickup: '3 Main St' });
  const s3 = await post('/services', { contact_name: 'Jonas Pereira', contact_phone: '(321) 555-0177', pickup: '4 Main St' });
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE name LIKE 'jonas%'").get().n >= 1, true);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE name = 'Jonas Pereira'").get().n, 1);
  assert.ok(jonas.contact_id);
  assert.ok(s3.contact_id);
});
