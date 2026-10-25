import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, chat, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';

const photo = { buffer: Buffer.from([0xff, 0xd8, 0xff]), mime: 'image/jpeg' };

// Gemini de mentira: responde a fila de leituras, uma por foto.
function fakeGemini(t, answers) {
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('generativelanguage.googleapis.com')) return realFetch(url, opts);
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answers.shift() || {}) }] } }] });
  };
}

function withTruck(env = {}) {
  const ctx = makeContext({ GEOCODER: 'off', ...env });
  const driver = ctx.bot.findUser(DRIVER_PHONE);
  const now = new Date().toISOString();
  const id = Number(ctx.db.prepare("INSERT INTO trucks (name, plate, driver_id, odometer, odometer_at, created_at) VALUES ('F-550', '', ?, 180000, ?, ?)").run(driver.id, now, now).lastInsertRowid);
  return { ctx, driver, truckId: id };
}

async function serve(t, ctx, phone, pin) {
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers.get('set-cookie').split(';')[0];
  const json = (path, body) => fetch(`${base}/api${path}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const image = (path) => fetch(`${base}/api${path}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'image/jpeg' }, body: photo.buffer });
  return { base, cookie, json, image };
}

test('diesel sem caminhão cadastrado: "abasteci 101.40 16.464 gal" grava direto com os galões', async () => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const [r] = await chat(ctx, DRIVER_PHONE, 'abasteci 101.40 16.464 gal');
  assert.match(r, /Despesa de \$101\.40 \(Combustível, 16\.464 gal · \$6\.16\/gal\) registrada/);
  const e = ctx.db.prepare('SELECT * FROM expenses').get();
  assert.equal(e.gallons, 16.464);
  assert.equal(e.category, 'combustivel');
});

test('WhatsApp: foto da bomba → Jay pede a foto do painel (obrigatória) → grava diesel, galões e milhas', async (t) => {
  const { ctx, truckId } = withTruck({ GEMINI_API_KEY: 'k' });
  fakeGemini(t, [{ tipo: 'bomba', valor: 101.4, galoes: 16.464 }, { tipo: 'carro' }, { tipo: 'painel', milhas: 184523 }]);
  let replies = await ctx.bot.handle({ phone: DRIVER_PHONE, text: '', media: photo });
  assert.match(replies.join('\n'), /Diesel \*\$101\.40\* · 16\.464 gal/);
  assert.match(replies.join('\n'), /foto do painel/);
  // Texto não serve: a foto é obrigatória.
  replies = await ctx.bot.handle({ phone: DRIVER_PHONE, text: '184523' });
  assert.match(replies.join('\n'), /foto do painel é obrigatória/);
  // Foto que não é o painel: pede de novo.
  replies = await ctx.bot.handle({ phone: DRIVER_PHONE, text: '', media: photo });
  assert.match(replies.join('\n'), /Não achei a milhagem/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n, 0);
  replies = await ctx.bot.handle({ phone: DRIVER_PHONE, text: '', media: photo });
  assert.match(replies.join('\n'), /Diesel registrado no F-550: \$101\.40 · 16\.464 gal · \$6\.16\/gal · painel 184,523 mi/);
  const e = ctx.db.prepare('SELECT * FROM expenses').get();
  assert.equal(e.category, 'combustivel');
  assert.equal(e.description, 'Diesel');
  assert.equal(e.truck_id, truckId);
  assert.equal(e.odometer, 184523);
  assert.ok(e.photo && e.pump_photo);
  assert.equal(ctx.api.manutencao.get(truckId).odometer, 184523);
  assert.equal(ctx.bot.getConversation(ctx.bot.findUser(DRIVER_PHONE).id), null);
});

test('WhatsApp: "gasto 80 diesel" também pede a foto do painel; milhas menores são recusadas', async (t) => {
  const { ctx } = withTruck({ GEMINI_API_KEY: 'k' });
  fakeGemini(t, [{ tipo: 'painel', milhas: 1000 }]);
  const [r] = await chat(ctx, DRIVER_PHONE, 'gasto 80 diesel');
  assert.match(r, /foto do painel/);
  const replies = await ctx.bot.handle({ phone: DRIVER_PHONE, text: '', media: photo });
  assert.match(replies.join('\n'), /menos do que o último registrado/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n, 0);
});

test('app: Abastecer com foto da bomba e do painel; sem foto do painel não grava; motorista não troca o caminhão', async (t) => {
  const { ctx, truckId } = withTruck({ GEMINI_API_KEY: 'k' });
  const other = Number(ctx.db.prepare("INSERT INTO trucks (name, plate, driver_id, odometer, odometer_at, created_at) VALUES ('Ram', '', NULL, 50000, ?, ?)").run(new Date().toISOString(), new Date().toISOString()).lastInsertRowid);
  const drv = await serve(t, ctx, DRIVER_PHONE, '5678');
  fakeGemini(t, [{ tipo: 'bomba', valor: 101.4, galoes: 16.464 }, { tipo: 'painel', milhas: 184523 }]);
  const pump = await (await drv.image('/expenses/ler-foto')).json();
  assert.equal(pump.amount, '101.40');
  assert.equal(pump.gallons, 16.464);
  const panel = await (await drv.image('/expenses/ler-foto?tipo=painel')).json();
  assert.equal(panel.odometer, 184523);

  const noPhoto = await drv.json('/abastecer', { amount: pump.amount, gallons: pump.gallons, odometer: panel.odometer });
  assert.equal(noPhoto.status, 400);
  assert.match((await noPhoto.json()).error, /foto do painel é obrigatória/);
  // Diesel pela tela comum de despesas não vale.
  assert.equal((await drv.json('/expenses', { amount: '50', category: 'combustivel' })).status, 400);

  // Mesmo mandando outro caminhão, o do motorista é usado.
  const ok = await drv.json('/abastecer', { amount: pump.amount, gallons: pump.gallons, odometer: panel.odometer, photo: panel.photo, pump_photo: pump.photo, truck_id: other });
  assert.equal(ok.status, 201);
  const e = await ok.json();
  assert.equal(e.truck_id, truckId);
  assert.equal(e.gallons, 16.464);
  assert.equal(e.odometer, 184523);
  const img = await fetch(`${drv.base}/api/expenses/${e.id}/foto`, { headers: { Cookie: drv.cookie } });
  assert.equal(img.status, 200);

  // ADM escolhe o caminhão.
  const adm = await serve(t, ctx, OWNER_PHONE, '1234');
  fakeGemini(t, [{ tipo: 'painel', milhas: 50100 }]);
  const p2 = await (await adm.image('/expenses/ler-foto?tipo=painel')).json();
  const e2 = await (await adm.json('/abastecer', { amount: '60', odometer: p2.odometer, photo: p2.photo, truck_id: other })).json();
  assert.equal(e2.truck_id, other);
  assert.equal(ctx.api.manutencao.get(other).odometer, 50100);
  const resumo = await (await fetch(`${adm.base}/api/summary?period=mes`, { headers: { Cookie: adm.cookie } })).json();
  assert.equal(resumo.fuel_gallons, 16.464);
});
