import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Jimp } from 'jimp';
import { imageForClaude } from '../src/lib/imagem.js';

test('foto grande para o Claude sai diminuída em JPEG; pequena sai como está', async () => {
  const big = await new Jimp({ width: 4000, height: 3000, color: 0x3366ccff }).getBuffer('image/png');
  const out = await imageForClaude(big, 'image/png');
  assert.equal(out.mimeType, 'image/jpeg');
  const back = await Jimp.read(Buffer.from(out.data, 'base64'));
  assert.equal(Math.max(back.width, back.height), 1568);

  const small = await new Jimp({ width: 10, height: 10, color: 0xffffffff }).getBuffer('image/png');
  assert.deepEqual(await imageForClaude(small, 'image/png'), { data: small.toString('base64'), mimeType: 'image/png' });
  // Arquivo que não é imagem: manda como veio.
  assert.equal((await imageForClaude(Buffer.from('xx'), 'image/webp')).mimeType, 'image/webp');
});
