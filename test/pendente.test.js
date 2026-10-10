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

test('serviço na fila: entra pendente, sem motorista, e o motorista é avisado', async (t) => {
  const { ctx, call, drv, driver } = await start(t);
  const sent = [];
  ctx.send = async (phone, text) => sent.push({ phone, text });

  const r = await call('POST', '/services', { pickup: '100 Main St, Oviedo FL', vehicle: 'Honda Civic', contact_name: 'Ana', driver_id: 'fila' });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'pendente');
  assert.equal(r.body.driver_id, null);
  // Não vira o serviço "em mãos" de ninguém.
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE active_service_id IS NOT NULL').get().n, 0);
  await new Promise((r) => setImmediate(r));
  const aviso = sent.find((m) => m.phone === DRIVER_PHONE);
  assert.match(aviso.text, new RegExp(`Serviço #${r.body.id} na fila`));
  assert.match(aviso.text, new RegExp(`pegar ${r.body.id}`));

  // O motorista vê a fila (mas não os serviços dos outros).
  await call('POST', '/services', { pickup: '200 Oak Ave, Orlando FL' }); // do dono, em andamento
  const fila = await call('GET', '/services?status=pendente', null, drv);
  assert.deepEqual(fila.body.map((s) => s.id), [r.body.id]);
  assert.equal((await call('GET', '/services?status=aberto', null, drv)).body.length, 0);
  assert.equal((await call('GET', `/services/${r.body.id}`, null, drv)).status, 200);
  // Na fila ele não mexe: precisa pegar antes.
  assert.equal((await call('PATCH', `/services/${r.body.id}`, { status: 'concluido' }, drv)).status, 403);

  // Pegou: passa a ser dele, em andamento e "em mãos".
  const peguei = await call('POST', `/services/${r.body.id}/pegar`, null, drv);
  assert.equal(peguei.status, 200);
  assert.equal(peguei.body.status, 'aberto');
  assert.equal(peguei.body.driver_id, driver.id);
  assert.equal(ctx.db.prepare('SELECT active_service_id FROM users WHERE id = ?').get(driver.id).active_service_id, r.body.id);
  // Ninguém pega de novo.
  assert.equal((await call('POST', `/services/${r.body.id}/pegar`)).status, 409);

  // Voltar para a fila: sem motorista e sai das mãos dele.
  const volta = await call('PATCH', `/services/${r.body.id}`, { status: 'pendente' }, drv);
  assert.equal(volta.body.status, 'pendente');
  assert.equal(volta.body.driver_id, null);
  assert.equal(ctx.db.prepare('SELECT active_service_id FROM users WHERE id = ?').get(driver.id).active_service_id, null);

  // O dono passa para o motorista.
  const passou = await call('POST', `/services/${r.body.id}/pegar`, { driver_id: driver.id });
  assert.equal(passou.body.driver_id, driver.id);
  assert.equal(passou.body.status, 'aberto');
});

test('pelo WhatsApp: fila e pegar', async (t) => {
  const { ctx, call } = await start(t);
  const [vazia] = await chat(ctx, DRIVER_PHONE, 'fila');
  assert.match(vazia, /Nenhum serviço na fila/);
  const { body: s } = await call('POST', '/services', { pickup: '100 Main St, Oviedo FL', contact_name: 'Ana', fila: true });
  const [lista] = await chat(ctx, DRIVER_PHONE, 'fila');
  assert.match(lista, new RegExp(`#${s.id}\\* Ana`));
  const [ok] = await chat(ctx, DRIVER_PHONE, `pegar ${s.id}`);
  assert.match(ok, /é seu agora/);
  assert.equal(ctx.data.services.get(s.id).status, 'aberto');
  const [denovo] = await chat(ctx, OWNER_PHONE, `pegar ${s.id}`);
  assert.match(denovo, /não está mais na fila \(está com Jorge\)/);
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

  // Pendente: só o dono cancela.
  const { body: p } = await call('POST', '/services', { pickup: '100 Main St, Oviedo FL', fila: true });
  assert.equal((await call('PATCH', `/services/${p.id}`, { status: 'cancelado' }, drv)).status, 403);
  assert.equal((await call('PATCH', `/services/${p.id}`, { status: 'cancelado' })).body.status, 'cancelado');
});
