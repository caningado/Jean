import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { findVin, readVinText, stopVinOcr } from '../src/lib/vin-ocr.js';

after(() => stopVinOcr());

test('findVin: acha o VIN numa palavra e confere o dígito verificador', () => {
  assert.equal(findVin('MADE IN USA\nVIN: 1HGCM82633A004352\nTYPE TRUCK'), '1HGCM82633A004352');
  // O e I viram 0 e 1 (VIN não usa essas letras).
  assert.equal(findVin('VIN 1HGCM82633A0O4352'), '1HGCM82633A004352');
  // Uma letra parecida trocada (S no lugar de 5).
  assert.equal(findVin('1HGCM82633A0043S2'), '1HGCM82633A004352');
  // Juntar palavras diferentes não vira VIN.
  assert.equal(findVin('GAWR FRT: 3500 LB RR: 3900 LB'), null);
  assert.equal(findVin('nada aqui'), null);
});

test('readVinText: lê o VIN escrito no para-brisa e na etiqueta de lado (grátis)', async () => {
  assert.equal(await readVinText(fs.readFileSync(new URL('./fixtures/vin-parabrisa.jpg', import.meta.url))), '1HGCM82633A004352');
  assert.equal(await readVinText(fs.readFileSync(new URL('./fixtures/vin-etiqueta-deitada.jpg', import.meta.url))), '1HGCM82633A004352');
});
