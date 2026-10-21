import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, chat, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

test('Conferir caixa e banco: pagamentos de hoje de serviços de dias anteriores', async (t) => {
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

  const antigo = await json('POST', '/services', { contact_name: 'Ana', pickup: '12 Main St, Orlando FL', price: '300' });
  const outro = await json('POST', '/services', { contact_name: 'Bia', pickup: '12 Main St, Orlando FL', price: '120' });
  const hoje = await json('POST', '/services', { contact_name: 'Caio', pickup: '12 Main St, Orlando FL', price: '90' });
  ctx.db.prepare('UPDATE services SET created_at = ? WHERE id IN (?, ?)').run(daysAgo(3), antigo.id, outro.id);
  await json('POST', `/services/${antigo.id}/payments`, { amount: '200', method: 'zelle' });
  await json('POST', `/services/${antigo.id}/payments`, { amount: '100', method: 'dinheiro' });
  await json('POST', `/services/${outro.id}/payments`, { amount: '120', method: 'zelle' });
  await json('POST', `/services/${hoje.id}/payments`, { amount: '90', method: 'zelle' });
  // Pago há dois dias: não entra na lista de hoje.
  const velho = await json('POST', '/services/' + outro.id + '/payments', { amount: '5', method: 'cheque' });
  ctx.db.prepare('UPDATE payments SET received_at = ? WHERE id = ?').run(daysAgo(2), velho.id);

  const r = await json('GET', '/payments/recebidos');
  assert.deepEqual(r.list.map((p) => p.service_id), [antigo.id, antigo.id, outro.id]);
  assert.equal(r.list[0].contact_name, 'Ana');
  assert.deepEqual(r.by_method, { zelle: 32000, dinheiro: 10000 });
  assert.equal(r.total_cents, 42000);

  const [msg] = await chat(ctx, OWNER_PHONE, 'recebidos');
  assert.match(msg, /Recebidos hoje de serviços anteriores/);
  assert.match(msg, new RegExp(`#${antigo.id} Ana`));
  assert.match(msg, /Zelle: \$320\.00/);
  assert.match(msg, /Total: \$420\.00/);
  assert.doesNotMatch(msg, /Caio/);

  const [ontem] = await chat(ctx, OWNER_PHONE, 'recebidos ontem');
  assert.match(ontem, /Nenhum pagamento recebido ontem/);

  const [denied] = await chat(ctx, DRIVER_PHONE, 'recebidos');
  assert.match(denied, /Só o ADM/);
  const driverCookie = await login(DRIVER_PHONE, '5678');
  assert.equal((await call('GET', '/payments/recebidos', null, driverCookie)).status, 403);
});
