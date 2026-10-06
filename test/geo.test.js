import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeocoder, prettyCensus } from '../src/lib/geo.js';
import { createApp } from '../src/app.js';
import { makeContext, chat, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('Census: endereço com número vira o endereço oficial', async () => {
  const calls = [];
  const geo = createGeocoder({
    fetchImpl: async (url) => {
      calls.push(url);
      return json({ result: { addressMatches: [{ matchedAddress: '12 MAIN ST, FRAMINGHAM, MA, 01701', coordinates: { x: -71.4, y: 42.3 } }] } });
    },
  });
  const r = await geo.lookup('12 main st framingham');
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.matches, [{ label: '12 Main St, Framingham, MA 01701', lat: 42.3, lng: -71.4 }]);
  assert.match(calls[0], /geocoding\.geo\.census\.gov/);
  await geo.lookup('12 main st framingham');
  assert.equal(calls.length, 1); // guardado
  assert.equal(prettyCensus('1600 PENNSYLVANIA AVE NW, WASHINGTON, DC, 20500'), '1600 Pennsylvania Ave NW, Washington, DC 20500');
});

test('sem número ou sem achar no Census, procura no mapa aberto (só EUA)', async () => {
  const geo = createGeocoder({
    fetchImpl: async (url) => {
      if (url.includes('census')) return json({ result: { addressMatches: [] } });
      return json({
        features: [
          { properties: { countrycode: 'US', name: "Joe's Auto", housenumber: '5', street: 'Elm St', city: 'Worcester', state: 'Massachusetts', postcode: '01608' }, geometry: { coordinates: [-71.8, 42.26] } },
          { properties: { countrycode: 'BR', name: "Joe's Auto", city: 'São Paulo' }, geometry: { coordinates: [-46, -23] } },
        ],
      });
    },
  });
  const r = await geo.lookup("joe's auto worcester");
  assert.deepEqual(r.matches.map((m) => m.label), ["Joe's Auto, 5 Elm St, Worcester, Massachusetts 01608"]);
  assert.equal((await geo.lookup('99 Nowhere Rd')).matches.length, 1); // Census vazio -> mapa aberto
});

test('serviço de mapa fora do ar = erro (o endereço é aceito como digitado)', async () => {
  const geo = createGeocoder({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal((await geo.lookup('12 Main St')).status, 'erro');
  const empty = createGeocoder({ fetchImpl: async () => json({ features: [] }) });
  assert.equal((await empty.lookup('xyzzy')).status, 'nada');
});

// Mapa de mentira para os testes do robô e do painel.
function fakeGeo(ctx) {
  const table = {
    '12 main st framingham': ['12 Main St, Framingham, MA 01701'],
    'main st': ['Main St, Framingham, Massachusetts', 'Main St, Worcester, Massachusetts', 'Main St, Boston, Massachusetts'],
    '45 elm st worcester': ['45 Elm St, Worcester, MA 01609'],
  };
  ctx.geo = {
    lookups: [],
    async lookup(q) {
      this.lookups.push(q);
      const labels = table[q.toLowerCase()] || [];
      return { status: labels.length ? 'ok' : 'nada', matches: labels.map((label) => ({ label })) };
    },
  };
  return ctx;
}

test('robô confere a retirada e o destino no mapa', async () => {
  const ctx = fakeGeo(makeContext({ PRICE_BASE: '0', PRICE_PER_MILE: '0' }));
  const r = await chat(
    ctx,
    DRIVER_PHONE,
    'novo',
    'John Smith',
    'pular',
    '12 main st framingham', // achou um: usa o endereço completo
    'main st', // achou vários: pergunta qual
    '2',
    'pular',
    'pular',
    'pular',
    'sim'
  );
  assert.match(r[3], /📍 Achei no mapa: \*12 Main St, Framingham, MA 01701\*/);
  assert.match(r[3], /Para onde vai \*levar\*/);
  assert.match(r[4], /Achei mais de um endereço para "main st"/);
  assert.match(r[4], /\*2\* Main St, Worcester, Massachusetts/);
  assert.match(r[5], /veículo/);
  const s = ctx.data.services.get(1);
  assert.equal(s.pickup, '12 Main St, Framingham, MA 01701');
  assert.equal(s.dropoff, 'Main St, Worcester, Massachusetts');
});

test('robô avisa quando não acha o endereço: digitar de novo ou usar assim', async () => {
  const ctx = fakeGeo(makeContext({ PRICE_BASE: '0', PRICE_PER_MILE: '0' }));
  const r = await chat(
    ctx,
    DRIVER_PHONE,
    'novo',
    'John Smith',
    'pular',
    '45 Elm Stret Worcster', // não achou
    '45 Elm St Worcester', // digitou de novo e achou
    'Acostamento da I-95 perto da saída 12', // não achou
    '7', // número fora da lista vira tentativa de endereço -> inválido
    '0', // usar como digitei
    'pular',
    'pular',
    'pular',
    'sim'
  );
  assert.match(r[3], /Não achei "45 Elm Stret Worcster" no mapa/);
  assert.match(r[3], /mande \*0\* para usar como digitei/);
  assert.match(r[4], /📍 Achei no mapa: \*45 Elm St, Worcester, MA 01609\*/);
  assert.match(r[5], /Não achei "Acostamento da I-95/);
  assert.match(r[6], /parece incompleto|Não achei/);
  const s = ctx.data.services.get(1);
  assert.equal(s.pickup, '45 Elm St, Worcester, MA 01609');
  assert.equal(s.dropoff, 'Acostamento da I-95 perto da saída 12');

  // Link de mapa e localização 📍 não precisam ser conferidos.
  const before = ctx.geo.lookups.length;
  await chat(ctx, DRIVER_PHONE, 'novo', 'John Smith', '(42.3601, -71.0589)', 'https://maps.app.goo.gl/AbC123xyz', 'pular', 'pular', 'pular', 'sim');
  assert.equal(ctx.geo.lookups.length, before);
  assert.equal(ctx.data.services.get(2).dropoff, 'https://maps.app.goo.gl/AbC123xyz');
});

test('painel: confere o endereço ao salvar e sugere enquanto digita', async (t) => {
  const ctx = fakeGeo(makeContext());
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const login = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (path, method = 'GET', body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  let r = await call('/places?q=main%20st');
  assert.equal(r.body.matches.length, 3);

  r = await call('/services', 'POST', { contact_name: 'Ana Lima', pickup: 'Rua que nao existe 99' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'endereco');
  assert.match(r.body.error, /Não achei a retirada/);
  assert.equal((await call('/contacts')).body.length, 0); // nada criado

  r = await call('/services', 'POST', { contact_name: 'Ana Lima', pickup: 'main st' });
  assert.equal(r.body.code, 'endereco_varios');

  r = await call('/services', 'POST', { contact_name: 'Ana Lima', pickup: 'Main St, Boston, Massachusetts' });
  assert.equal(r.status, 201); // escolheu da lista

  r = await call('/services', 'POST', { contact_name: 'Ana Lima', pickup: '12 main st framingham', dropoff: 'Rua que nao existe 99', address_ok: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.dropoff, 'Rua que nao existe 99'); // salvar assim mesmo

  // Editar outra coisa não confere de novo o endereço que já estava salvo.
  r = await call(`/services/${r.body.id}`, 'PATCH', { pickup: r.body.pickup, dropoff: r.body.dropoff, notes: 'ok' });
  assert.equal(r.status, 200);
  r = await call(`/services/${r.body.id}`, 'PATCH', { dropoff: '45 elm st worcester' });
  assert.equal(r.body.dropoff, '45 Elm St, Worcester, MA 01609');
});
