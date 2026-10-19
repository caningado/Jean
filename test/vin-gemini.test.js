import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readVinGemini, readVinFromImage } from '../src/modules/vin/index.js';

const ctx = { config: { geminiApiKey: 'chave-teste', geminiModel: 'gemini-flash-latest', vinOcr: false, anthropicApiKey: '' }, log() {} };
const reply = (text, status = 200) => ({ ok: status === 200, status, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });

test('Gemini: manda a foto com a chave e devolve o VIN lido', async () => {
  let call;
  const vin = await readVinGemini(ctx, Buffer.from('foto'), 'image/png', async (url, opts) => {
    call = { url, opts };
    return reply('The VIN is 1hgcm82633a004352.');
  });
  assert.equal(vin, '1HGCM82633A004352');
  assert.match(call.url, /models\/gemini-flash-latest:generateContent$/);
  assert.equal(call.opts.headers['x-goog-api-key'], 'chave-teste');
  const part = JSON.parse(call.opts.body).contents[0].parts[0].inline_data;
  assert.deepEqual(part, { mime_type: 'image/png', data: Buffer.from('foto').toString('base64') });
  assert.equal(await readVinGemini(ctx, Buffer.from('x'), 'image/jpeg', async () => reply('NONE')), null);
  await assert.rejects(readVinGemini(ctx, Buffer.from('x'), 'image/jpeg', async () => reply('', 403)), /403/);
});

test('Foto sem código de barras: com GEMINI_API_KEY, usa o Gemini; sem chave, não chama', async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  let calls = 0;
  globalThis.fetch = async () => (calls++, reply('JTDKBRFUXJ3063205'));
  assert.deepEqual(await readVinFromImage(ctx, Buffer.from('não é imagem'), 'image/jpeg'), { vin: 'JTDKBRFUXJ3063205', source: 'gemini' });
  const semChave = { ...ctx, config: { ...ctx.config, geminiApiKey: '' } };
  assert.equal((await readVinFromImage(semChave, Buffer.from('não é imagem'), 'image/jpeg')).reason, 'sem-chave');
  assert.equal(calls, 1);
});
