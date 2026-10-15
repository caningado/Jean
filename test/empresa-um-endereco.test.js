import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE } from './helpers.js';

test('Empresa: um endereço só, usado na cobrança e na entrega', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const json = (method, path, body) => fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());
  const c = await json('POST', '/companies', { name: 'USAVE Motors', address: '100 Main St, Orlando FL 32801' });
  assert.equal(c.address, '100 Main St, Orlando FL 32801');
  assert.equal(c.bill_to, 'USAVE MOTORS\n100 Main St, Orlando FL 32801');
  const e = await json('PATCH', `/companies/${c.id}`, { address: '5 Oak Ave, Oviedo FL' });
  assert.equal(e.bill_to, 'USAVE MOTORS\n5 Oak Ave, Oviedo FL');
  // Empresa antiga, só com Bill to: a tela recebe o endereço tirado dele.
  const old = await json('POST', '/companies', { name: 'Moving', bill_to: 'Moving\n9 Pine Rd, Orlando FL' });
  assert.equal((await json('GET', `/companies/${old.id}`)).address, '9 Pine Rd, Orlando FL');
});

test('Empresa: nome sempre em MAIÚSCULAS (novas e as que já existiam)', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  ctx.db.prepare("INSERT INTO companies (name, bill_to, token, created_at) VALUES ('Hello Auto Sales', 'Hello Auto Sales\n1 Main St', 'tok', '2026-10-01')").run();
  const empresas = (await import('../src/modules/empresas/index.js')).default;
  empresas.setup(ctx);
  const old = ctx.db.prepare('SELECT name, bill_to FROM companies').get();
  assert.equal(old.name, 'HELLO AUTO SALES');
  assert.equal(old.bill_to, 'HELLO AUTO SALES\n1 Main St');
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const r = await fetch(`${base}/api/companies`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Skyway Orlando' }) }).then((x) => x.json());
  assert.equal(r.name, 'SKYWAY ORLANDO');
});
