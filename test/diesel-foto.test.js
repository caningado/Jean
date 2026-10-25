import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, chat, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';

const photo = { buffer: Buffer.from([0xff, 0xd8, 0xff]), mime: 'image/jpeg' };

function fakeGemini(t, answer) {
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('generativelanguage.googleapis.com')) return realFetch(url, opts);
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] });
  };
}

test('diesel: "abasteci 101.40 16.464 gal" guarda os galões e o preço do galão', async () => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const [r] = await chat(ctx, DRIVER_PHONE, 'abasteci 101.40 16.464 gal');
  assert.match(r, /\$101\.40/);
  assert.match(r, /16\.464 gal · \$6\.16\/gal/);
  const e = ctx.db.prepare('SELECT * FROM expenses ORDER BY id DESC').get();
  assert.equal(e.amount_cents, 10140);
  assert.equal(e.gallons, 16.464);
  assert.equal(e.category, 'combustivel');
  // Sem galões continua como antes.
  await chat(ctx, DRIVER_PHONE, 'gasto 12 pedágio');
  assert.equal(ctx.db.prepare('SELECT gallons FROM expenses ORDER BY id DESC').get().gallons, null);
});

test('diesel: foto da bomba no WhatsApp → mostra o que leu → sim lança a despesa', async (t) => {
  const ctx = makeContext({ GEMINI_API_KEY: 'k', GEOCODER: 'off' });
  fakeGemini(t, { tipo: 'bomba', valor: 101.4, galoes: 16.464 });
  let replies = await ctx.bot.handle({ phone: DRIVER_PHONE, text: '', media: photo });
  assert.match(replies.join('\n'), /Li na foto da bomba: \*\$101\.40\* e \*16\.464 galões\*/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n, 0);
  replies = await ctx.bot.handle({ phone: DRIVER_PHONE, text: 'sim' });
  assert.match(replies.join('\n'), /Despesa de \$101\.40/);
  const e = ctx.db.prepare('SELECT * FROM expenses').get();
  assert.equal(e.gallons, 16.464);
  assert.equal(e.category, 'combustivel');
});

test('diesel: no painel, foto da bomba preenche valor e galões; registrar guarda os galões', async (t) => {
  const ctx = makeContext({ GEMINI_API_KEY: 'k', GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) })).headers.get('set-cookie').split(';')[0];
  fakeGemini(t, { tipo: 'bomba', valor: 101.4, galoes: 16.464 });
  const read = await (await fetch(`${base}/api/expenses/ler-foto`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'image/jpeg' }, body: photo.buffer })).json();
  assert.deepEqual(read, { amount: '101.40', gallons: 16.464 });
  const post = (body) => fetch(`${base}/api/expenses`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ amount: '101.40', gallons: 'abc', category: 'combustivel' })).status, 400);
  const saved = await (await post({ amount: '101.40', gallons: '16.464', category: 'combustivel', description: 'Diesel' })).json();
  assert.equal(saved.gallons, 16.464);
  const resumo = await (await fetch(`${base}/api/summary?period=mes`, { headers: { Cookie: cookie } })).json();
  assert.equal(resumo.fuel_gallons, 16.464);
});

test('diesel: foto do painel no WhatsApp → mostra a milhagem → sim atualiza o caminhão; no painel lê as milhas', async (t) => {
  const ctx = makeContext({ GEMINI_API_KEY: 'k', GEOCODER: 'off' });
  const driver = ctx.bot.findUser(DRIVER_PHONE);
  ctx.db.prepare("INSERT INTO trucks (name, plate, driver_id, odometer, odometer_at, created_at) VALUES ('F-550', '', ?, 180000, ?, ?)").run(driver.id, new Date().toISOString(), new Date().toISOString());
  // Abasteceu: o Jay pede a foto do painel.
  const [r] = await chat(ctx, DRIVER_PHONE, 'abasteci 101.40 16.464 gal');
  assert.match(r, /foto do painel/);
  fakeGemini(t, { tipo: 'painel', milhas: 184523 });
  let replies = await ctx.bot.handle({ phone: DRIVER_PHONE, text: '', media: photo });
  assert.match(replies.join('\n'), /Li no painel: \*184,523 mi\*/);
  replies = await ctx.bot.handle({ phone: DRIVER_PHONE, text: 'sim' });
  assert.match(replies.join('\n'), /184,523 mi registrado/);
  assert.equal(ctx.db.prepare('SELECT odometer FROM trucks').get().odometer, 184523);

  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) })).headers.get('set-cookie').split(';')[0];
  const read = await (await fetch(`${base}/api/expenses/ler-foto?tipo=painel`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'image/jpeg' }, body: photo.buffer })).json();
  assert.deepEqual(read, { odometer: 184523 });
});
