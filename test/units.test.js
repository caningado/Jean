import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, formatMoney, normalizePhone, startOfDayIso } from '../src/lib/util.js';
import { validateVin, cleanVin, decodeVin } from '../src/modules/vin/index.js';
import { parseVcf } from '../src/core/data.js';
import { splitVehicle } from '../src/core/index.js';
import { parseMethod } from '../src/modules/pagamentos/index.js';
import { guessCategory } from '../src/modules/despesas/index.js';
import { extractMessages, validSignature } from '../src/modules/whatsapp/index.js';
import { kindFromText, angleFromText } from '../src/modules/fotos/index.js';
import crypto from 'node:crypto';

test('dinheiro', () => {
  assert.equal(parseMoney('250'), 25000);
  assert.equal(parseMoney('$1,250.50'), 125050);
  assert.equal(parseMoney('250,50'), 25050);
  assert.equal(parseMoney('abc'), null);
  assert.equal(formatMoney(125050), '$1,250.50');
});

test('telefone', () => {
  assert.equal(normalizePhone('(508) 555-0123'), '15085550123');
  assert.equal(normalizePhone('+1 508 555 0123'), '15085550123');
  assert.equal(normalizePhone('+55 11 98888-7777'), '5511988887777');
});

test('início do dia no fuso da empresa', () => {
  // 03:00 UTC de 4/out ainda é 3/out em Nova York (UTC-4 no horário de verão).
  assert.equal(startOfDayIso('America/New_York', new Date('2026-10-04T03:00:00Z')), '2026-10-03T04:00:00.000Z');
});

test('VIN', () => {
  assert.equal(validateVin('1HGCM82633A004352').valid, true);
  assert.equal(validateVin('1hgcm82633a004352').valid, true);
  assert.equal(validateVin('1HGCM82633A004353').valid, false);
  assert.match(validateVin('1HGCM8263').reason, /17 caracteres/);
  assert.equal(cleanVin('1HGCM8263 3AOO4352'), '1HGCM82633A004352');
});

test('decodificação do VIN usa a resposta da NHTSA', async () => {
  const fakeFetch = async (url) => {
    assert.match(url, /DecodeVinValues\/1HGCM82633A004352/);
    return { ok: true, json: async () => ({ Results: [{ Make: 'HONDA', Model: 'Accord', ModelYear: '2003', BodyClass: 'Coupe' }] }) };
  };
  assert.deepEqual(await decodeVin('1HGCM82633A004352', fakeFetch), { year: '2003', make: 'HONDA', model: 'Accord', trim: null, body: 'Coupe' });
  assert.equal(await decodeVin('X', async () => { throw new Error('offline'); }), null);
});

test('agenda .vcf', () => {
  const vcf = [
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:Maria Souza', 'TEL;TYPE=CELL:+1 (508) 555-0144', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:3.0', 'N:Silva;Jo\\,ão;;;', 'item1.TEL:5085550155', 'EMAIL:joao@example.com', 'END:VCARD',
    'BEGIN:VCARD', 'FN:Sem Telefone', 'END:VCARD',
  ].join('\r\n');
  assert.deepEqual(parseVcf(vcf), [
    { name: 'Maria Souza', phone: '+1 (508) 555-0144', email: '' },
    { name: 'Jo,ão Silva', phone: '5085550155', email: 'joao@example.com' },
    { name: 'Sem Telefone', phone: '', email: '' },
  ]);
});

test('veículo e placa', () => {
  assert.deepEqual(splitVehicle('Honda Civic ABC1234'), { vehicle: 'Honda Civic', plate: 'ABC1234' });
  assert.deepEqual(splitVehicle('Ford F-150 branca'), { vehicle: 'Ford F-150 branca', plate: null });
  assert.deepEqual(splitVehicle('Ford F150'), { vehicle: 'Ford F150', plate: null });
});

test('formas de pagamento, categorias e tipo de foto', () => {
  assert.deepEqual(parseMethod('Zelle'), { method: 'zelle' });
  assert.deepEqual(parseMethod('cash'), { method: 'dinheiro' });
  assert.deepEqual(parseMethod('AAA'), { method: 'seguradora', payer: 'AAA' });
  assert.equal(parseMethod('250'), null);
  assert.equal(guessCategory('diesel posto'), 'combustivel');
  assert.equal(guessCategory('E-ZPass'), 'pedagio');
  assert.equal(guessCategory('presente'), 'outros');
  assert.equal(kindFromText('Antes da retirada'), 'antes');
  assert.equal(kindFromText('entrega'), 'depois');
  assert.equal(kindFromText('foto'), null);
  assert.equal(angleFromText('antes frente'), 'frente');
  assert.equal(angleFromText('Traseira'), 'traseira');
  assert.equal(angleFromText('lado do motorista'), 'lateral_esquerda');
  assert.equal(angleFromText('lado direito'), 'lateral_direita');
  assert.equal(angleFromText('amassado na porta'), 'detalhe');
  assert.equal(angleFromText('antes'), null);
});

test('webhook do WhatsApp', () => {
  const payload = {
    entry: [{ changes: [{ value: {
      contacts: [{ wa_id: '15085550111', profile: { name: 'Jorge' } }],
      messages: [
        { id: 'a', from: '15085550111', type: 'text', text: { body: 'novo' } },
        { id: 'b', from: '15085550111', type: 'image', image: { id: 'm1', caption: 'antes' } },
      ],
    } }] }],
  };
  assert.deepEqual(extractMessages(payload), [
    { id: 'a', from: '15085550111', name: 'Jorge', type: 'text', text: 'novo', mediaId: null },
    { id: 'b', from: '15085550111', name: 'Jorge', type: 'image', text: 'antes', mediaId: 'm1' },
  ]);
  const body = Buffer.from(JSON.stringify(payload));
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
  assert.equal(validSignature(body, sig, 's3cret'), true);
  assert.equal(validSignature(body, sig, 'outro'), false);
  assert.equal(validSignature(body, undefined, 's3cret'), false);
});

test('local: endereço colado, link de mapa e coordenadas', async () => {
  const { checkLocation, mapLink } = await import('../src/lib/validate.js');
  assert.equal(checkLocation('12 Main St\nFramingham, MA'), '12 Main St, Framingham, MA');
  const link = 'https://maps.app.goo.gl/AbC123xyz';
  assert.equal(checkLocation(link), link);
  assert.equal(mapLink(link), link);
  assert.equal(checkLocation('Waze https://waze.com/ul/hdrt1234'), 'Waze https://waze.com/ul/hdrt1234');
  assert.throws(() => checkLocation('https://example.com/x'), /não é de mapa/);
  assert.equal(checkLocation('42.3601, -71.0589'), '42.3601, -71.0589');
  assert.equal(mapLink('42.3601, -71.0589'), 'https://www.google.com/maps?q=42.3601,-71.0589');
  assert.throws(() => checkLocation('123'), /parece incompleto/);
  assert.match(mapLink('12 Main St, Framingham'), /maps\/search\/\?api=1&query=12%20Main%20St%2C%20Framingham/);
});

test('localização 📍 do WhatsApp vira texto com coordenadas', () => {
  const payload = { entry: [{ changes: [{ value: { messages: [
    { id: 'l', from: '15085550111', type: 'location', location: { latitude: 42.3601, longitude: -71.0589, name: "Joe's Auto", address: '1 Elm St' } },
  ] } }] }] };
  assert.equal(extractMessages(payload)[0].text, "Joe's Auto, 1 Elm St (42.3601, -71.0589)");
});
