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
  return { ctx, call, owner, drv, driver };
}

test('serviço na fila: só o dono põe na fila e escolhe o motorista', async (t) => {
  const { ctx, call, drv, driver } = await start(t);
  const sent = [];
  ctx.send = async (phone, text) => sent.push({ phone, text });

  const r = await call('POST', '/services', { pickup: '100 Main St, Oviedo FL', vehicle: 'Honda Civic', contact_name: 'Ana', driver_id: 'fila' });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'pendente');
  assert.equal(r.body.driver_id, null);
  // Não vira o serviço "em mãos" de ninguém, e ninguém é avisado ainda.
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE active_service_id IS NOT NULL').get().n, 0);
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 0);
  assert.deepEqual((await call('GET', '/services?status=pendente')).body.map((s) => s.id), [r.body.id]);

  // O motorista não vê a fila nem pega serviço.
  assert.equal((await call('GET', '/services?status=pendente', null, drv)).body.length, 0);
  assert.equal((await call('GET', `/services/${r.body.id}`, null, drv)).status, 404);
  assert.equal((await call('POST', `/services/${r.body.id}/passar`, { driver_id: driver.id }, drv)).status, 403);
  // Motorista que tenta criar "na fila" cria para si mesmo.
  const dele = await call('POST', '/services', { pickup: '200 Oak Ave, Orlando FL', driver_id: 'fila' }, drv);
  assert.equal(dele.body.status, 'aberto');
  assert.equal(dele.body.driver_id, driver.id);

  // O dono passa para o motorista: em andamento, "em mãos" se ele está livre, e avisado.
  ctx.db.prepare('UPDATE users SET active_service_id = NULL').run();
  const passou = await call('POST', `/services/${r.body.id}/passar`, { driver_id: driver.id });
  assert.equal(passou.status, 200);
  assert.equal(passou.body.status, 'aberto');
  assert.equal(passou.body.driver_id, driver.id);
  assert.equal(ctx.db.prepare('SELECT active_service_id FROM users WHERE id = ?').get(driver.id).active_service_id, r.body.id);
  await new Promise((r) => setImmediate(r));
  assert.match(sent.find((m) => m.phone === DRIVER_PHONE).text, /passou um serviço para você/);
  assert.equal((await call('POST', `/services/${r.body.id}/passar`, { driver_id: driver.id })).status, 409);

  // Voltar para a fila: só o dono.
  assert.equal((await call('PATCH', `/services/${r.body.id}`, { status: 'pendente' }, drv)).status, 403);
  const volta = await call('PATCH', `/services/${r.body.id}`, { status: 'pendente' });
  assert.equal(volta.body.status, 'pendente');
  assert.equal(volta.body.driver_id, null);
  assert.equal(ctx.db.prepare('SELECT active_service_id FROM users WHERE id = ?').get(driver.id).active_service_id, null);
  // Escolher pelo Editar também tira da fila.
  const edit = await call('PATCH', `/services/${r.body.id}`, { driver_id: driver.id });
  assert.equal(edit.body.status, 'aberto');
});

test('pelo WhatsApp: só o dono vê a fila', async (t) => {
  const { ctx, call } = await start(t);
  const [vazia] = await chat(ctx, OWNER_PHONE, 'fila');
  assert.match(vazia, /Nenhum serviço na fila/);
  const { body: s } = await call('POST', '/services', { pickup: '100 Main St, Oviedo FL', contact_name: 'Ana', fila: true });
  const [lista] = await chat(ctx, OWNER_PHONE, 'fila');
  assert.match(lista, new RegExp(`#${s.id}\\* Ana`));
  const [motorista] = await chat(ctx, DRIVER_PHONE, 'fila');
  assert.match(motorista, /Só o dono/);
  const [abrir] = await chat(ctx, DRIVER_PHONE, `abrir ${s.id}`);
  assert.match(abrir, /Não achei/);
  assert.equal(ctx.data.services.get(s.id).status, 'pendente');
});

test('cancelar serviço: guarda o motivo, avisa o dono se foi o motorista, e dá para reabrir', async (t) => {
  const { ctx, call, drv, driver } = await start(t);
  const sent = [];
  ctx.send = async (phone, text) => sent.push({ phone, text });
  const { body: s } = await call('POST', '/services', { pickup: '100 Main St, Oviedo FL', contact_name: 'Ana', driver_id: driver.id });
  const r = await call('PATCH', `/services/${s.id}`, { status: 'cancelado', motivo: 'Cliente desistiu' }, drv);
  assert.equal(r.body.status, 'cancelado');
  assert.match(r.body.notes, /Cancelado: Cliente desistiu/);
  assert.equal(ctx.db.prepare('SELECT active_service_id FROM users WHERE id = ?').get(driver.id).active_service_id, null);
  await new Promise((r) => setImmediate(r));
  assert.match(sent.find((m) => m.phone === OWNER_PHONE).text, /Jorge cancelou o serviço #\d+ \(Ana\)\.\nMotivo: Cliente desistiu/);
  // Cancelado não entra no resumo.
  assert.equal((await call('GET', '/summary')).body.services, 0);
  // Reabrir.
  assert.equal((await call('PATCH', `/services/${s.id}`, { status: 'aberto' })).body.status, 'aberto');

  // Pendente: o motorista nem vê; o dono cancela.
  const { body: p } = await call('POST', '/services', { pickup: '100 Main St, Oviedo FL', fila: true });
  assert.equal((await call('PATCH', `/services/${p.id}`, { status: 'cancelado' }, drv)).status, 404);
  assert.equal((await call('PATCH', `/services/${p.id}`, { status: 'cancelado' })).body.status, 'cancelado');
});
