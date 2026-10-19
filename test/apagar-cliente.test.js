import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';

test('Apagar cliente: só o ADM, e só cliente sem serviço', async (t) => {
  const ctx = makeContext();
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
  const del = (cookie, id) => fetch(`${base}/api/contacts/${id}`, { method: 'DELETE', headers: { Cookie: cookie } });

  const sem = ctx.data.contacts.findOrCreate({ name: 'Car Mix Orlando', phone: null });
  const com = ctx.data.contacts.findOrCreate({ name: 'Ana Lima', phone: '14075550123' });
  ctx.data.services.create({ contact_id: com.id, pickup: '1 Main St', status: 'pendente' });

  assert.equal((await del(drv, sem.id)).status, 403);
  const r = await del(adm, com.id);
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /Ana Lima tem 1 serviço/);
  assert.equal((await del(adm, sem.id)).status, 200);
  assert.equal(ctx.data.contacts.get(sem.id), undefined);
  assert.equal((await del(adm, sem.id)).status, 404);
});
