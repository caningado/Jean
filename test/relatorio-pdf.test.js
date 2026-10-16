import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';

test('relatório do mês em PDF: o motorista recebe só os dele', async (t) => {
  const ctx = makeContext();
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone, pin) =>
    (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers.get('set-cookie').split(';')[0];
  const adm = await login(OWNER_PHONE, '1234');
  const jorge = await login(DRIVER_PHONE, '5678');
  const driverId = ctx.db.prepare('SELECT id FROM users WHERE phone = ?').get(DRIVER_PHONE).id;
  await fetch(`${base}/api/services`, { method: 'POST', headers: { Cookie: adm, 'Content-Type': 'application/json' }, body: JSON.stringify({ contact_name: 'Paulo', pickup: '1 Main St', price: '100', driver_id: driverId }) });

  const now = new Date();
  const mes = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  for (const cookie of [jorge, adm]) {
    const res = await fetch(`${base}/api/planilha.pdf?mes=${mes}`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition'), /^inline/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 4).toString(), '%PDF');
  }
});
