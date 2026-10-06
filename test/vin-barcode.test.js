import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { writeBarcode, prepareZXingModule } from 'zxing-wasm/full';
import { readVinBarcode, vinFromCode } from '../src/lib/barcode.js';
import { createApp } from '../src/app.js';
import { makeContext, chat, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';

const require = createRequire(import.meta.url);
prepareZXingModule({
  overrides: { wasmBinary: readFileSync(require.resolve('zxing-wasm/full/zxing_full.wasm')) },
  fireImmediately: true,
});

const VIN = '1HGCM82633A004352';
async function barcodePng(text, format) {
  const { image, error } = await writeBarcode(text, { format, scale: 4 });
  assert.equal(error, '');
  return Buffer.from(await image.arrayBuffer());
}

test('acha o VIN no texto do código de barras', () => {
  assert.equal(vinFromCode(VIN), VIN);
  assert.equal(vinFromCode('I' + VIN), VIN);
  assert.equal(vinFromCode('12345'), null);
});

test('lê o VIN do código de barras da porta (Code 39) e do para-brisa (Data Matrix)', async () => {
  assert.equal(await readVinBarcode(await barcodePng(VIN, 'Code39')), VIN);
  assert.equal(await readVinBarcode(await barcodePng(VIN, 'DataMatrix')), VIN);
  assert.equal(await readVinBarcode(await barcodePng('HELLO', 'Code39')), null);
});

test('foto do VIN pelo WhatsApp é lida sem chave do Claude', async () => {
  const ctx = makeContext();
  await chat(ctx, DRIVER_PHONE, 'novo', '5085550123', 'John Smith', 'Rua Alfa', 'pular', 'pular', 'pular', 'pular', 'sim');
  const media = { buffer: await barcodePng(VIN, 'Code39'), mime: 'image/png' };
  const [reply] = await ctx.bot.handle({ phone: DRIVER_PHONE, text: 'vin', media });
  assert.match(reply, new RegExp(`Li o VIN: \\*${VIN}\\*`));
  const [saved] = await chat(ctx, DRIVER_PHONE, 'sim');
  assert.match(saved, /VIN 1HGCM82633A004352 salvo/);
});

test('painel: "Ler da foto" lê o código de barras e o leitor do iPhone é servido', async (t) => {
  const ctx = makeContext();
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const read = (body) => fetch(`${base}/api/vin/read`, { method: 'POST', headers: { 'Content-Type': 'image/png', Cookie: cookie }, body });

  let res = await read(await barcodePng(VIN, 'DataMatrix'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.vin, VIN);
  assert.equal(body.valid, true);

  res = await read(await barcodePng('HELLO', 'Code39'));
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /Não achei o código de barras/);

  for (const file of ['/vendor/barcode-detector.js', '/vendor/zxing_reader.wasm']) {
    res = await fetch(base + file);
    assert.equal(res.status, 200, file);
    assert.ok((await res.arrayBuffer()).byteLength > 10000, file);
  }
});
