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
  const driver = ctx.db.prepare('SELECT * FROM users WHERE phone = ?').get(DRIVER_PHONE);
  return { ctx, call, drv, driver };
}

test('empresa com apelido: "ss" acha a Super Speed e seus solicitantes', async (t) => {
  const { call } = await start(t);
  const { body: co } = await call('POST', '/companies', { name: 'Super Speed', nickname: 'SS', bill_to: 'Super Speed\n1 Main St' });
  assert.equal(co.nickname, 'SS');
  assert.equal((await call('POST', '/companies', { name: 'Outra', nickname: 'ss' })).status, 409);

  // Sem solicitantes: oferece a própria empresa.
  let sug = await call('GET', '/contacts/suggest?q=ss');
  assert.deepEqual(sug.body.map((c) => [c.id, c.name, c.company_id]), [[null, 'Super Speed', co.id]]);

  // Digitar só "SS" no nome cria o cliente Super Speed já ligado à empresa.
  const s = await call('POST', '/services', { contact_name: 'SS', pickup: '1 Main St, Oviedo FL' });
  assert.equal(s.body.contact_name, 'Super Speed');
  assert.equal((await call('GET', `/services/${s.body.id}`)).body.company_name, 'Super Speed');

  // Com solicitantes: aparecem todos.
  const { body: joao } = await call('POST', '/contacts', { name: 'João Pereira', phone: '(407) 555-0123' });
  await call('PUT', `/contacts/${joao.id}/company`, { company_id: co.id });
  sug = await call('GET', '/contacts/suggest?q=SS');
  assert.deepEqual(sug.body.map((c) => c.name).sort(), ['João Pereira', 'Super Speed']);
  assert.ok(sug.body.every((c) => c.company_name === 'Super Speed'));
});

test('pelo WhatsApp: "ss" no novo serviço pergunta qual solicitante da Super Speed', async (t) => {
  const { ctx, call } = await start(t);
  const { body: co } = await call('POST', '/companies', { name: 'Super Speed', nickname: 'SS' });
  for (const name of ['João Pereira', 'Maria Lima']) {
    const { body: c } = await call('POST', '/contacts', { name });
    await call('PUT', `/contacts/${c.id}/company`, { company_id: co.id });
  }
  await chat(ctx, OWNER_PHONE, 'novo');
  const [pick] = await chat(ctx, OWNER_PHONE, 'SS');
  assert.match(pick, /\*1\* João Pereira/);
  assert.match(pick, /\*2\* Maria Lima/);
});

test('empresa que exige VIN e sempre faz invoice', async (t) => {
  const { ctx, call, drv, driver } = await start(t);
  const { body: co } = await call('POST', '/companies', { name: 'Super Speed', nickname: 'SS', requires_vin: true, always_invoice: true });
  assert.equal(co.requires_vin, 1);
  const { body: s } = await call('POST', '/services', { contact_name: 'ss', pickup: '1 Main St, Oviedo FL', price: '150', driver_id: driver.id });
  assert.equal((await call('GET', `/services/${s.id}`)).body.company_requires_vin, true);

  // Sem VIN não fecha (painel e WhatsApp).
  const r = await call('PATCH', `/services/${s.id}`, { status: 'concluido' }, drv);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Super Speed exige o VIN/);
  const [bot] = await chat(ctx, DRIVER_PHONE, 'entregue');
  assert.match(bot, /exige o VIN/);
  assert.equal(ctx.data.services.get(s.id).status, 'aberto');

  // Com VIN fecha e o invoice sai sozinho.
  ctx.db.prepare("UPDATE services SET vin = '1HGCM82633A004352' WHERE id = ?").run(s.id);
  const ok = await call('PATCH', `/services/${s.id}`, { status: 'concluido' }, drv);
  assert.equal(ok.status, 200);
  assert.match(ok.body.notices[0], /Invoice nº \d+ criado para a Super Speed/);
  assert.equal(ctx.api.invoice.numbersFor(s.id).length, 1);
  // Reabrir e fechar de novo não cria outro.
  await call('PATCH', `/services/${s.id}`, { status: 'aberto' }, drv);
  await call('PATCH', `/services/${s.id}`, { status: 'concluido' }, drv);
  assert.equal(ctx.api.invoice.numbersFor(s.id).length, 1);

  // Pelo WhatsApp também.
  const { body: s2 } = await call('POST', '/services', { contact_name: 'ss', pickup: '1 Main St, Oviedo FL', price: '90', driver_id: driver.id });
  ctx.db.prepare("UPDATE services SET vin = '1HGCM82633A004352' WHERE id = ?").run(s2.id);
  const [fim] = await chat(ctx, DRIVER_PHONE, 'entregue');
  assert.match(fim, /entregue/);
  assert.match(fim, /Invoice nº \d+ criado/);
});
