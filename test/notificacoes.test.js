import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';

test('Notificação: motorista recebe o serviço dado para ele; ADM recebe serviço novo; quem fez não recebe', async (t) => {
  const ctx = makeContext();
  const sent = [];
  ctx.push = async (sub, payload) => sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone, pin) =>
    (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers
      .get('set-cookie')
      .split(';')[0];
  const adm = await login(OWNER_PHONE, '1234');
  const drv = await login(DRIVER_PHONE, '5678');
  const call = (cookie, method, path, body) =>
    fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const tick = () => new Promise((r) => setTimeout(r, 20));

  assert.ok((await (await call(adm, 'GET', '/push/chave')).json()).key);
  const keys = { p256dh: 'BPx', auth: 'ax' };
  assert.equal((await call(adm, 'POST', '/push/assinar', { endpoint: 'https://push.example/adm', keys })).status, 200);
  assert.equal((await call(drv, 'POST', '/push/assinar', { endpoint: 'https://push.example/drv', keys })).status, 200);
  assert.equal((await call(drv, 'POST', '/push/assinar', { endpoint: 'http://inseguro', keys })).status, 400);
  const jorge = ctx.db.prepare('SELECT id FROM users WHERE phone = ?').get(DRIVER_PHONE).id;

  // ADM cria já com o Jorge: só o Jorge recebe.
  await call(adm, 'POST', '/services', { contact_name: 'Ana Lima', pickup: '1 Main St, Oviedo FL', driver_id: jorge });
  await tick();
  assert.deepEqual(sent.map((s) => s.endpoint), ['https://push.example/drv']);
  assert.equal(sent[0].title, '🔔 Serviço novo');
  assert.match(sent[0].body, /^#1 Ana Lima · 1 Main St/);

  // ADM cria na fila (sem motorista): ninguém (só ele é ADM). Depois passa para o Jorge: o Jorge recebe.
  sent.length = 0;
  const fila = await (await call(adm, 'POST', '/services', { contact_name: 'Bia Souza', pickup: '2 Main St, Oviedo FL', driver_id: 'fila' })).json();
  await tick();
  assert.equal(sent.length, 0);
  await call(adm, 'PATCH', `/services/${fila.id}`, { driver_id: jorge });
  await tick();
  assert.deepEqual(sent.map((s) => s.endpoint), ['https://push.example/drv']);

  // O motorista cria um serviço: o ADM recebe; ele mesmo não.
  sent.length = 0;
  await call(drv, 'POST', '/services', { contact_name: 'Caio Reis', pickup: '3 Main St, Oviedo FL' });
  await tick();
  assert.deepEqual(sent.map((s) => s.endpoint), ['https://push.example/adm']);

  // Aparelho que não existe mais é apagado.
  ctx.push = async () => {
    throw Object.assign(new Error('gone'), { statusCode: 410 });
  };
  await call(drv, 'POST', '/services', { contact_name: 'Davi Melo', pickup: '4 Main St, Oviedo FL' });
  await tick();
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n, 1);
});
