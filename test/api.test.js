import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE } from './helpers.js';

// Sobe o servidor numa porta livre, faz login como dono e devolve um "fetch" já logado.
async function startServer() {
  const ctx = makeContext();
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (path, method = 'GET', body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, close: () => server.close() };
}

test('painel recusa contato e serviço com dados sem sentido', async (t) => {
  const { call, close } = await startServer();
  t.after(close);

  let r = await call('/contacts', 'POST', { name: '23' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /precisa ter letras/);

  r = await call('/contacts', 'POST', { name: 'Maria Souza', phone: '555' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Telefone inválido/);

  r = await call('/contacts', 'POST', { name: 'Maria Souza', phone: '(508) 555-0144' });
  assert.equal(r.status, 201);
  const maria = r.body;

  r = await call(`/contacts/${maria.id}`, 'PATCH', { name: '99' });
  assert.equal(r.status, 400);

  r = await call('/services', 'POST', { contact_name: '23', pickup: '12 Main St' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /nome do cliente/);
  assert.equal((await call('/contacts')).body.length, 1); // nada criado

  r = await call('/services', 'POST', { contact_id: maria.id, pickup: '1' });
  assert.equal(r.status, 400);

  r = await call('/services', 'POST', { contact_id: maria.id, pickup: '12 Main St', price: '999999' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /alto demais/);

  r = await call('/services', 'POST', { contact_id: maria.id, pickup: '12 Main St', miles: '10', price: '115' });
  assert.equal(r.status, 201);
  assert.equal(r.body.price_cents, 11500);

  r = await call(`/services/${r.body.id}`, 'PATCH', { miles: 'abc' });
  assert.equal(r.status, 400);

  r = await call('/users', 'POST', { name: 'Jo', phone: '123' });
  assert.equal(r.status, 400);
});
