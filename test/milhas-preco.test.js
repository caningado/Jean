import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createRouter, routeLines } from '../src/lib/rotas.js';
import { fitPrices, priceSuggestion } from '../src/core/preco.js';
import { makeContext, chat, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';

// Google Maps de mentira: rota normal com pedágio de $3.25, e a sem pedágio mais longa.
function fakeGoogle(calls = []) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body, headers: opts.headers });
    const avoid = body.routeModifiers?.avoidTolls;
    const route = avoid
      ? { distanceMeters: 40234, duration: '2700s' } // 25 mi, 45 min
      : { distanceMeters: 32187, duration: '1800s', travelAdvisory: { tollInfo: { estimatedPrice: [{ currencyCode: 'USD', units: '3', nanos: 250000000 }] } } }; // 20 mi, 30 min
    return new Response(JSON.stringify({ routes: [route] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

test('Google Maps: rota com pedágio (valor e tempo) e rota sem pedágio', async () => {
  const calls = [];
  const router = createRouter({ apiKey: 'k', fetchImpl: fakeGoogle(calls) });
  const r = await router.route('28.512, -81.345', '100 Main St, Orlando FL');
  assert.deepEqual(r, { miles: 20, minutes: 30, has_tolls: true, toll_cents: 325, sem_pedagio: { miles: 25, minutes: 45 } });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body.origin, { location: { latLng: { latitude: 28.512, longitude: -81.345 } } });
  assert.deepEqual(calls[0].body.destination, { address: '100 Main St, Orlando FL' });
  assert.deepEqual(calls[0].body.extraComputations, ['TOLLS']);
  assert.equal(calls[0].headers['X-Goog-Api-Key'], 'k');
  // Mesmo caminho de novo: não gasta outro cálculo.
  await router.route('28.512, -81.345', '100 Main St, Orlando FL');
  assert.equal(calls.length, 2);
  const text = routeLines(r).join('\n');
  assert.match(text, /Com pedágio: 20 mi, uns 30 min, pedágio ~\$3\.25/);
  assert.match(text, /Sem pedágio: 25 mi, uns 45 min/);
  // Sem chave, não existe cálculo.
  assert.equal(createRouter({ apiKey: '' }), null);
});

test('Google Maps: caminho sem pedágio faz um cálculo só', async () => {
  const calls = [];
  const router = createRouter({
    apiKey: 'k',
    fetchImpl: async (url, opts) => {
      calls.push(opts);
      return new Response(JSON.stringify({ routes: [{ distanceMeters: 16093, duration: '900s' }] }));
    },
  });
  const r = await router.route('A St, Orlando', 'B St, Orlando');
  assert.equal(calls.length, 1);
  assert.deepEqual(r, { miles: 10, minutes: 15, has_tolls: false, toll_cents: null, sem_pedagio: null });
  assert.match(routeLines(r)[0], /10 mi, uns 15 min \(sem pedágio no caminho\)/);
});

test('preço aprende com os serviços já feitos', () => {
  // $50 + $3 por milha
  const rows = [5, 10, 20, 30, 40].map((miles) => ({ miles, price_cents: 5000 + miles * 300 }));
  assert.deepEqual(fitPrices(rows), { baseCents: 5000, perMileCents: 300, n: 5 });
  // Poucos serviços ou milhas todas iguais: não dá para confiar.
  assert.equal(fitPrices(rows.slice(0, 4)), null);
  assert.equal(fitPrices([10, 10, 10, 10, 10].map((miles) => ({ miles, price_cents: 9000 }))), null);
});

test('sugestão: tabela sem histórico; depois histórico geral e da empresa', () => {
  const ctx = makeContext();
  assert.equal(priceSuggestion(ctx, 10).fonte, 'tabela');
  assert.equal(priceSuggestion(ctx, 10).cents, 7500 + 10 * 400);
  const driver = ctx.db.prepare('SELECT id FROM users WHERE phone = ?').get(DRIVER_PHONE).id;
  const add = (miles, price, contactId = null) =>
    ctx.db
      .prepare("INSERT INTO services (driver_id, contact_id, pickup, miles, price_cents, status, created_at) VALUES (?, ?, 'x', ?, ?, 'concluido', ?)")
      .run(driver, contactId, miles, price, new Date().toISOString());
  for (const m of [5, 10, 20, 30, 40]) add(m, 5000 + m * 300);
  const geral = priceSuggestion(ctx, 15);
  assert.equal(geral.fonte, 'historico');
  assert.equal(geral.cents, 9500);
  assert.match(geral.texto, /Sugestão \$95/);
  // Cotação (pendente sem motorista) e cancelado não ensinam nada.
  ctx.db.prepare("INSERT INTO services (pickup, miles, price_cents, status, created_at) VALUES ('x', 15, 99900, 'pendente', ?)").run(new Date().toISOString());
  assert.equal(priceSuggestion(ctx, 15).cents, 9500);

  // Empresa que paga diferente ($100 + $2/mi).
  const co = ctx.db.prepare("INSERT INTO companies (name, token, created_at) VALUES ('Copart', 'tok', ?)").run(new Date().toISOString()).lastInsertRowid;
  const c = ctx.data.contacts.create({ name: 'Copart Orlando' });
  ctx.db.prepare('UPDATE contacts SET company_id = ? WHERE id = ?').run(co, c.id);
  for (const m of [5, 10, 20, 30, 40]) add(m, 10000 + m * 200, c.id);
  const emp = priceSuggestion(ctx, 15, { contactId: c.id });
  assert.equal(emp.fonte, 'empresa');
  assert.equal(emp.cents, 13000);
  assert.match(emp.texto, /Copart/);
});

async function start(t) {
  const ctx = makeContext({ GOOGLE_MAPS_API_KEY: 'k' });
  ctx.rotas = createRouter({ apiKey: 'k', fetchImpl: fakeGoogle() });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) }))
    .headers.get('set-cookie')
    .split(';')[0];
  const call = (method, path, body) =>
    fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { ctx, call };
}

test('painel: milhas calculadas ao criar e ao mudar o destino; estimativa com rotas e sugestão', async (t) => {
  const { call } = await start(t);
  const est = await call('GET', `/estimate?pickup=${encodeURIComponent('28.512, -81.345')}&dropoff=${encodeURIComponent('28.612, -81.245')}`);
  assert.equal(est.body.miles, 20);
  assert.equal(est.body.route.toll_cents, 325);
  assert.equal(est.body.route.sem_pedagio.miles, 25);
  assert.equal(est.body.suggestion.cents, 7500 + 20 * 400);
  // Milhas digitadas: não chama o mapa.
  assert.equal((await call('GET', '/estimate?miles=10')).body.suggestion.cents, 7500 + 10 * 400);

  const s = await call('POST', '/services', { pickup: '28.512, -81.345', dropoff: '28.612, -81.245', vehicle: 'Civic', contact_name: 'Ana' });
  assert.equal(s.status, 201);
  assert.equal(s.body.miles, 20);
  assert.equal(s.body.price_cents, null); // o valor só o dono decide
  // Milhas digitadas valem mais que o mapa.
  const typed = await call('POST', '/services', { pickup: '28.412, -81.345', dropoff: '28.612, -81.245', miles: 7, vehicle: 'Civic', contact_name: 'Bia' });
  assert.equal(typed.body.miles, 7);
  // Mudou o destino sem mexer nas milhas: calcula de novo.
  const moved = await call('PATCH', `/services/${typed.body.id}`, { dropoff: '28.712, -81.145', miles: 7 });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.miles, 20);
  // Mudou o destino e as milhas juntas: valem as digitadas.
  const both = await call('PATCH', `/services/${typed.body.id}`, { dropoff: '28.812, -81.145', miles: 9 });
  assert.equal(both.body.miles, 9);
});

test('Jay: mostra as rotas antes do valor e troca para a sem pedágio', async () => {
  const ctx = makeContext({ GOOGLE_MAPS_API_KEY: 'k' });
  ctx.rotas = createRouter({ apiKey: 'k', fetchImpl: fakeGoogle() });
  const r = await chat(ctx, DRIVER_PHONE, 'novo', '(508) 555-0123', 'Maria Souza', '28.512, -81.345', '28.612, -81.245', 'Honda Civic ABC1234', 'sem pedagio', 'ok', 'sim');
  assert.match(r[5], /Com pedágio: \*20 mi\*, uns 30 min, pedágio ~\$3\.25/);
  assert.match(r[5], /Sem pedágio: \*25 mi\*, uns 45 min/);
  assert.match(r[5], /\$155/); // 75 + 20 x 4
  assert.match(r[6], /rota \*sem pedágio\*/);
  assert.match(r[6], /\$175/); // 75 + 25 x 4
  assert.match(r[8], /Serviço #1 criado/);
  const s = ctx.data.services.get(1);
  assert.equal(s.miles, 25);
  assert.equal(s.price_cents, 17500);
});

test('sugestão pelo tempo: ida + volta + 30 min a $100 a hora, quando dá mais que as milhas', () => {
  const ctx = makeContext();
  ctx.config.pricing = { baseCents: 10000, perMileCents: 0, perHourCents: 10000, loadMinutes: 30 };
  // 40 min de ida + 40 de volta + 30 = 1h50 → $183,33 → $185
  const s = priceSuggestion(ctx, 20, { minutes: 40 });
  assert.equal(s.fonte, 'tempo');
  assert.equal(s.cents, 18500);
  assert.equal(s.minutos_total, 110);
  assert.match(s.texto, /Sugestão \$185 pelo tempo: 40 min de ida \+ 40 de volta \+ 30 para pegar e entregar = 1h50 a \$100 a hora\. \(Só pelas milhas daria \$100\.\)/);
  // Corrida curta: as milhas (o mínimo de $100) ganham do tempo.
  assert.equal(priceSuggestion(ctx, 3, { minutes: 10 }).fonte, 'tabela');
  // Sem minutos: só milhas, como antes.
  assert.equal(priceSuggestion(ctx, 20).cents, 10000);
  // Sem valor da hora: só milhas.
  ctx.config.pricing.perHourCents = 0;
  assert.equal(priceSuggestion(ctx, 20, { minutes: 40 }).fonte, 'tabela');
});
