import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE } from './helpers.js';

test('Novo serviço: VIN digitado devolve ano/marca/modelo do carro', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const asked = [];
  ctx.api.vin.decode = async (vin) => (asked.push(vin), { year: '2003', make: 'HONDA', model: 'Accord', trim: 'EX', body: 'Sedan' });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const get = (vin) => fetch(`${base}/api/vin/decode/${vin}`, { headers: { Cookie: cookie } }).then((r) => r.json());

  const ok = await get('1hgcm82633a004352');
  assert.equal(ok.valid, true);
  assert.equal(ok.vin, '1HGCM82633A004352');
  assert.equal(ok.vehicle, '2003 HONDA Accord');
  assert.equal(ok.info.trim, 'EX');

  const bad = await get('1HGCM82633A004353');
  assert.equal(bad.valid, false);
  assert.match(bad.reason, /verificador/);

  const short = await get('1HGCM');
  assert.equal(short.vehicle, null);
  assert.deepEqual(asked, ['1HGCM82633A004352', '1HGCM82633A004353']);
});
