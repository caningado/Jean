import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeVehicle, describeVehicle } from '../src/modules/vin/index.js';
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
  assert.equal(ok.vehicle, '2003 Honda Accord');
  assert.equal(ok.info.trim, 'EX');

  const bad = await get('1HGCM82633A004353');
  assert.equal(bad.valid, false);
  assert.match(bad.reason, /verificador/);

  const short = await get('1HGCM');
  assert.equal(short.vehicle, null);
  assert.deepEqual(asked, ['1HGCM82633A004352', '1HGCM82633A004353']);
});

test('VIN completa o veículo: marca/modelo/ano do VIN, e cor ou detalhe digitado ficam', () => {
  const q7 = { year: '2014', make: 'AUDI', model: 'Q7' };
  assert.equal(mergeVehicle('Audi Q7', q7), '2014 Audi Q7');
  assert.equal(mergeVehicle('', q7), '2014 Audi Q7');
  assert.equal(mergeVehicle(null, q7), '2014 Audi Q7');
  const silverado = { year: '2019', make: 'CHEVROLET', model: 'Silverado' };
  assert.equal(mergeVehicle('Silverado Red', silverado), '2019 Chevrolet Silverado Red');
  assert.equal(mergeVehicle('Chev silverado', silverado), '2019 Chevrolet Silverado');
  assert.equal(mergeVehicle('chevy 2018', silverado), '2019 Chevrolet Silverado');
  assert.equal(mergeVehicle('Mazda CX9', { year: '2016', make: 'MAZDA', model: 'CX-9' }), '2016 Mazda CX-9');
  assert.equal(mergeVehicle('Camry', { year: '2018', make: 'TOYOTA', model: 'Camry' }), '2018 Toyota Camry');
  // Juntar de novo não repete nada.
  assert.equal(mergeVehicle('2019 Chevrolet Silverado Red', silverado), '2019 Chevrolet Silverado Red');
  assert.equal(describeVehicle({ year: '2020', make: 'MERCEDES-BENZ', model: 'GLB-Class' }), '2020 Mercedes-Benz GLB-Class');
  assert.equal(describeVehicle({ year: '2021', make: 'BMW', model: 'X5' }), '2021 BMW X5');
  assert.equal(mergeVehicle('Sentra', null), 'Sentra');
});

test('Salvar VIN num serviço que já tem veículo digitado troca pela marca/modelo do VIN', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  ctx.api.vin.decode = async () => ({ year: '2014', make: 'AUDI', model: 'Q7' });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const owner = ctx.data.users.byPhone ? ctx.data.users.byPhone(OWNER_PHONE) : null;
  const s = ctx.data.services.create({ pickup: '1 Main St', vehicle: 'Q7 preto' }, owner?.id ?? 1);
  const res = await fetch(`${base}/api/services/${s.id}/vin`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ vin: '1HGCM82633A004352' }) });
  assert.equal(res.status, 200);
  assert.equal(ctx.data.services.get(s.id).vehicle, '2014 Audi Q7 preto');

  const prev = await fetch(`${base}/api/vin/decode/1HGCM82633A004352?veiculo=${encodeURIComponent('Audi branco')}`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.equal(prev.merged, '2014 Audi Q7 branco');
});
