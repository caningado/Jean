import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';

test('lista de clientes: só o dono vê serviços e valores do mês e do ano, sem os cancelados', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone, pin) =>
    (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers.get('set-cookie').split(';')[0];
  const owner = await login(OWNER_PHONE, '1234');
  const drv = await login(DRIVER_PHONE, '5678');
  const call = (method, path, body, cookie = owner) =>
    fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());

  const a = await call('POST', '/services', { contact_name: 'Ana Lima', contact_phone: '(407) 555-0199', pickup: '1 Main St', price: '100' });
  await call('POST', '/services', { contact_id: a.contact_id, pickup: '2 Main St', price: '50' });
  const cancelado = await call('POST', '/services', { contact_id: a.contact_id, pickup: '3 Main St', price: '999' });
  ctx.db.prepare("UPDATE services SET status = 'cancelado' WHERE id = ?").run(cancelado.id);
  // Um do ano passado: conta no ano? Não.
  const velho = await call('POST', '/services', { contact_id: a.contact_id, pickup: '4 Main St', price: '70' });
  ctx.db.prepare("UPDATE services SET created_at = '2000-03-01T12:00:00.000Z' WHERE id = ?").run(velho.id);

  const [ana] = (await call('GET', '/contacts?q=Ana')).filter((c) => c.name === 'Ana Lima');
  assert.equal(ana.month_count, 2);
  assert.equal(ana.year_count, 2);
  assert.equal(ana.month_cents, 15000);
  assert.equal(ana.year_cents, 15000);

  const [visto] = await call('GET', '/contacts?q=Ana', undefined, drv);
  assert.equal(visto.name, 'Ana Lima');
  for (const k of ['month_count', 'year_count', 'month_cents', 'year_cents', 'services_count']) assert.equal(visto[k], undefined, k);
});
