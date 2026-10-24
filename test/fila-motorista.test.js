import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, chat, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';

test('fila do motorista: ele escolhe qual começa, no máximo 2 em andamento', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone) => (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin: phone === DRIVER_PHONE ? '5678' : '1234' }) })).headers.get('set-cookie').split(';')[0];
  const owner = await login(OWNER_PHONE);
  const drv = await login(DRIVER_PHONE);
  const call = async (method, path, body, cookie = owner) => {
    const r = await fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const driver = ctx.db.prepare("SELECT id FROM users WHERE role = 'motorista'").get();
  // O dono passa 3 serviços para o motorista: todos entram na fila dele.
  const ids = [];
  for (const n of ['Ana', 'Bia', 'Caio']) {
    const r = await call('POST', '/services', { contact_name: n, pickup: '12 Main St, Orlando FL', driver_id: driver.id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ids.push(r.body.id);
  }
  assert.deepEqual(ids.map((id) => ctx.data.services.get(id).status), ['pendente', 'pendente', 'pendente']);
  // Na lista "Andamento" eles aparecem (Aguardando); o "Pendentes" do dono é só o que está sem motorista.
  assert.deepEqual((await call('GET', '/services?status=aberto', null, drv)).body.map((s) => s.id).sort(), [...ids].sort());
  assert.equal((await call('GET', '/services?status=pendente')).body.length, 0);
  // Agendado: sai do "Andamento" e fica em "Pendentes" até o motorista começar.
  const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 16);
  assert.equal((await call('PUT', `/services/${ids[1]}/agenda`, { scheduled_at: amanha })).status, 200);
  assert.deepEqual((await call('GET', '/services?status=aberto', null, drv)).body.map((s) => s.id).sort(), [ids[0], ids[2]].sort());
  assert.deepEqual((await call('GET', '/services?status=pendente')).body.map((s) => s.id), [ids[1]]);
  await call('PUT', `/services/${ids[1]}/agenda`, { scheduled_at: '' });
  // Começa dois (painel e WhatsApp); o terceiro é recusado.
  assert.equal((await call('PATCH', `/services/${ids[2]}`, { status: 'aberto' }, drv)).status, 200);
  assert.match((await chat(ctx, DRIVER_PHONE, `abrir ${ids[0]}`))[0], /agora estou no serviço/);
  const terceiro = await call('PATCH', `/services/${ids[1]}`, { status: 'aberto' }, drv);
  assert.equal(terceiro.status, 409);
  assert.match(terceiro.body.error, /já tem 2 serviços em andamento/);
  assert.match((await chat(ctx, DRIVER_PHONE, `abrir ${ids[1]}`))[0], /já tem 2 serviços em andamento/);
  assert.match((await chat(ctx, DRIVER_PHONE, 'fila'))[0], new RegExp(`#${ids[1]}`));
  // Entregou um: pode começar o próximo.
  await call('PATCH', `/services/${ids[2]}`, { status: 'concluido' }, drv);
  assert.equal((await call('PATCH', `/services/${ids[1]}`, { status: 'aberto' }, drv)).status, 200);
  // Motorista criando com 2 em andamento: o novo vai para a fila dele.
  const novo = await call('POST', '/services', { contact_name: 'Davi', pickup: '12 Main St, Orlando FL' }, drv);
  assert.equal(novo.body.status, 'pendente');
  assert.equal(novo.body.driver_id, driver.id);
});
