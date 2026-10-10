import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, chat, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';

async function start(t) {
  const ctx = makeContext();
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone, pin) =>
    (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers.get('set-cookie').split(';')[0];
  const owner = await login(OWNER_PHONE, '1234');
  const drv = await login(DRIVER_PHONE, '5678');
  const call = (method, path, body, cookie = owner) =>
    fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { ctx, call, drv };
}

test('endereço com apelido: "ribas" vira o endereço na retirada e no destino', async (t) => {
  const { ctx, call, drv } = await start(t);
  const r = await call('POST', '/saved-places', { nickname: 'Ribas', address: '643 Barry St, Orlando FL' });
  assert.equal(r.status, 201);
  assert.equal((await call('POST', '/saved-places', { nickname: 'RIBAS', address: 'x St' })).status, 409);
  assert.equal((await call('POST', '/saved-places', { nickname: 'Loja', address: '1 Main St' }, drv)).status, 403);
  await call('POST', '/saved-places', { nickname: 'Auto Peças João', address: '10 Oak Ave, Oviedo FL' });

  // Painel: só o apelido, sem acento e minúsculo.
  const s = await call('POST', '/services', { pickup: 'auto pecas joao', dropoff: 'ribas' });
  assert.equal(s.status, 201);
  assert.equal(s.body.pickup, '10 Oak Ave, Oviedo FL');
  assert.equal(s.body.dropoff, '643 Barry St, Orlando FL');
  const det = await call('GET', `/services/${s.body.id}`);
  assert.equal(det.body.dropoff_name, 'Ribas');
  const edit = await call('PATCH', `/services/${s.body.id}`, { dropoff: 'Ribas ' });
  assert.equal(edit.body.dropoff, '643 Barry St, Orlando FL');

  // Sugestões ao digitar.
  const sug = await call('GET', '/places?q=rib');
  assert.deepEqual(sug.body.saved.map((p) => p.nickname), ['Ribas']);

  // WhatsApp.
  const [lista] = await chat(ctx, DRIVER_PHONE, 'endereços');
  assert.match(lista, /\*Ribas\* – 643 Barry St/);
  await chat(ctx, OWNER_PHONE, 'novo');
  await chat(ctx, OWNER_PHONE, '(407) 555-0199');
  const steps = [];
  for (const text of ['Maria', 'ribas']) steps.push(...(await chat(ctx, OWNER_PHONE, text)));
  assert.ok(steps.some((m) => /Ribas: \*643 Barry St, Orlando FL\*/.test(m)), steps.join('\n---\n'));

  // Apagar.
  await call('DELETE', `/saved-places/${r.body.id}`);
  assert.equal((await call('GET', '/saved-places')).body.length, 1);
});
