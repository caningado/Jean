import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE } from './helpers.js';

test('Lista de serviços (Todos) não mostra os cancelados', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const json = (method, path, body) => fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());
  // Com motorista: pendente sem motorista pode ser só cotação e não entra nas listas/totais.
  const me = (await json('GET', '/me')).user;
  const fica = await json('POST', '/services', { driver_id: me.id, contact_name: 'Fica', pickup: '12 Main St, Orlando FL' });
  const sai = await json('POST', '/services', { driver_id: me.id, contact_name: 'Sai', pickup: '12 Main St, Orlando FL' });
  await json('PATCH', `/services/${sai.id}`, { status: 'cancelado', motivo: 'cliente desistiu' });
  const ids = (await json('GET', '/services?status=')).map((s) => s.id);
  assert.ok(ids.includes(fica.id));
  assert.ok(!ids.includes(sai.id));
  // Continua guardado: abre pelo número.
  assert.equal((await json('GET', `/services/${sai.id}`)).status, 'cancelado');
});

test('Pendente sem motorista (cotação) fica só na aba Pendentes, fora de Todos e dos totais', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const json = (method, path, body) => fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());
  const me = (await json('GET', '/me')).user;
  const cotacao = await json('POST', '/services', { contact_name: 'Cotação', pickup: '12 Main St, Orlando FL', price: '130' });
  const feito = await json('POST', '/services', { driver_id: me.id, contact_name: 'Feito', pickup: '12 Main St, Orlando FL', price: '160' });
  assert.equal(cotacao.driver_id, null);

  const todos = (await json('GET', '/services?status=')).map((s) => s.id);
  assert.deepEqual(todos, [feito.id]);
  assert.deepEqual((await json('GET', '/services?status=pendente')).map((s) => s.id), [cotacao.id]);
  assert.equal((await json('GET', '/summary?period=dia')).billed_cents, 16000);
  const dia = await json('GET', '/relatorio/dia');
  assert.ok(!dia.reports.some((r) => r.services.some((s) => s.id === cotacao.id)));

  // Escolheu o motorista: vira serviço e entra em Todos.
  await json('POST', `/services/${cotacao.id}/passar`, { driver_id: me.id });
  assert.ok((await json('GET', '/services?status=')).some((s) => s.id === cotacao.id));
});

test('Pendente sem motorista (cotação) não gera invoice', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (method, path, body) => fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const me = (await (await call('GET', '/me')).json()).user;
  const cotacao = await (await call('POST', '/services', { contact_name: 'Cotação', pickup: '12 Main St, Orlando FL', price: '130' })).json();
  const nao = await call('POST', `/services/${cotacao.id}/invoices`, {});
  assert.equal(nao.status, 400);
  assert.match((await nao.json()).error, /cotação/);
  await call('POST', `/services/${cotacao.id}/passar`, { driver_id: me.id });
  assert.equal((await call('POST', `/services/${cotacao.id}/invoices`, {})).status, 201);
});
