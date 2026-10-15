import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';

test('Relatório do dia: serviços do dia, sem cancelados, com pago e a receber', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone, pin) =>
    (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers.get('set-cookie').split(';')[0];
  const cookie = await login(OWNER_PHONE, '1234');
  const call = (method, path, body, c = cookie) => fetch(`${base}/api${path}`, { method, headers: { Cookie: c, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const json = (...a) => call(...a).then((r) => r.json());

  const pago = await json('POST', '/services', { contact_name: 'Ana', pickup: '12 Main St, Orlando FL', price: '150' });
  const falta = await json('POST', '/services', { contact_name: 'Bia', pickup: '12 Main St, Orlando FL', price: '200' });
  const cancelado = await json('POST', '/services', { contact_name: 'Caio', pickup: '12 Main St, Orlando FL', price: '90' });
  const ontem = await json('POST', '/services', { contact_name: 'Davi', pickup: '12 Main St, Orlando FL', price: '80' });
  await json('POST', `/services/${pago.id}/payments`, { amount: '150', method: 'zelle' });
  await json('PATCH', `/services/${cancelado.id}`, { status: 'cancelado', motivo: 'desistiu' });
  ctx.db.prepare('UPDATE services SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 3 * 86400000).toISOString(), ontem.id);

  const r = await json('GET', '/relatorio/dia');
  assert.deepEqual(r.services.map((s) => s.id), [pago.id, falta.id]);
  assert.deepEqual(r.services[0].methods, ['Zelle']);
  assert.equal(r.totals.price_cents, 35000);
  assert.equal(r.totals.received_cents, 15000);
  assert.equal(r.totals.open_cents, 20000);

  // Outro dia: o serviço de 3 dias atrás aparece lá.
  const dia = new Intl.DateTimeFormat('en-CA', { timeZone: ctx.config.timeZone }).format(new Date(Date.now() - 3 * 86400000));
  assert.deepEqual((await json('GET', `/relatorio/dia?dia=${dia}`)).services.map((s) => s.id), [ontem.id]);

  // Motorista não vê o relatório.
  const driver = await login(DRIVER_PHONE, '5678');
  assert.equal((await call('GET', '/relatorio/dia', null, driver)).status, 403);
});
