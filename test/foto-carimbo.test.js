import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Jimp } from 'jimp';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';
import { readPhotoMeta, takenToIso, stampDate } from '../src/lib/carimbo.js';

const comGps = fs.readFileSync(new URL('./fixtures/foto-com-gps.jpg', import.meta.url));
// Foto sem GPS (como chega do WhatsApp).
const semGps = await new Jimp({ width: 320, height: 240, color: 0x3366ccff }).getBuffer('image/jpeg');

// Endereço de mentira no lugar do mapa (sem internet nos testes).
function fakeGeo(ctx) {
  const asked = [];
  ctx.geo = { lookup: async () => ({ status: 'erro', matches: [] }), reverse: async (lat, lng) => (asked.push([lat, lng]), '11435 Rocket Blvd, Orlando, Florida 32824') };
  return asked;
}

async function startServer(t, ctx) {
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone, pin) =>
    (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers.get('set-cookie').split(';')[0];
  const dono = await login(OWNER_PHONE, '1234');
  const call = (method, p, body, type = 'application/json') =>
    fetch(`${base}/api${p}`, { method, headers: { Cookie: dono, 'Content-Type': type }, body: body && (type === 'application/json' ? JSON.stringify(body) : body) });
  return { call };
}

test('lê o GPS e a hora gravados na foto', async () => {
  const meta = await readPhotoMeta(comGps);
  assert.ok(Math.abs(meta.lat - 28.538333) < 1e-5);
  assert.ok(Math.abs(meta.lng - -81.379167) < 1e-5);
  // 14:20 em Orlando (horário de inverno, -5h) = 19:20 UTC.
  assert.equal(takenToIso(meta.taken, 'America/New_York'), '2026-11-15T19:20:33.000Z');
  assert.equal(stampDate('2026-11-15T19:20:33.000Z', 'America/New_York'), '11/15/2026 2:20 PM EST');
  assert.deepEqual(await readPhotoMeta(semGps), {});
});

test('painel: a foto sai carimbada com data, hora e endereço do GPS da foto; a original fica guardada', async (t) => {
  const ctx = makeContext();
  const asked = fakeGeo(ctx);
  const { call } = await startServer(t, ctx);
  const s = await (await call('POST', '/services', { contact_name: 'Ana', pickup: '12 Main St, Orlando FL', price: '150' })).json();
  const { id } = await (await call('POST', `/services/${s.id}/photos?kind=antes&angle=frente`, comGps, 'image/jpeg')).json();
  await ctx.api.fotos.stamped();

  const photo = ctx.db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  assert.equal(photo.place_source, 'foto');
  assert.equal(photo.address, '11435 Rocket Blvd, Orlando, Florida 32824');
  assert.equal(photo.taken_at, '2026-11-15T19:20:33.000Z');
  assert.equal(asked.length, 1);
  assert.ok(fs.existsSync(path.join(ctx.config.uploadsDir, photo.stamped_file)));

  // O painel mostra a carimbada; ?original=1 devolve a foto como chegou.
  const detail = await (await call('GET', `/services/${s.id}/photos`)).json();
  assert.match(detail[0].url, /\?c=1$/);
  assert.equal(detail[0].address, '11435 Rocket Blvd, Orlando, Florida 32824');
  const shown = Buffer.from(await (await call('GET', `/photos/${id}/file`)).arrayBuffer());
  const original = Buffer.from(await (await call('GET', `/photos/${id}/file?original=1`)).arrayBuffer());
  assert.ok(original.equals(comGps));
  assert.ok(!shown.equals(comGps));
  // A faixa escura fica no pé da foto.
  const img = await Jimp.read(shown);
  const bottom = img.getPixelColor(5, img.height - 3) >>> 24;
  const topColor = img.getPixelColor(5, 3) >>> 24;
  assert.ok(bottom < topColor, 'pé da foto mais escuro');

  // Apagar a foto apaga as duas.
  assert.equal((await call('DELETE', `/photos/${id}`)).status, 200);
  assert.ok(!fs.existsSync(path.join(ctx.config.uploadsDir, photo.stamped_file)));
});

test('painel: foto sem GPS usa o GPS do celular mandado junto', async (t) => {
  const ctx = makeContext();
  const asked = fakeGeo(ctx);
  const { call } = await startServer(t, ctx);
  const s = await (await call('POST', '/services', { contact_name: 'Ana', pickup: '12 Main St, Orlando FL', price: '150' })).json();
  const { id } = await (await call('POST', `/services/${s.id}/photos?kind=depois&lat=28.4&lng=-81.3&origem=celular`, semGps, 'image/jpeg')).json();
  await ctx.api.fotos.stamped();
  const photo = ctx.db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  assert.equal(photo.place_source, 'celular');
  assert.deepEqual(asked, [[28.4, -81.3]]);
  assert.ok(photo.stamped_file);
});

test('WhatsApp: foto depois da localização 📍 sai com o endereço dela; sem localização, com o endereço do serviço', async (t) => {
  const ctx = makeContext();
  fakeGeo(ctx);
  const driver = ctx.db.prepare('SELECT id FROM users WHERE phone = ?').get(DRIVER_PHONE);
  const sid = Number(
    ctx.db
      .prepare("INSERT INTO services (driver_id, pickup, dropoff, status, created_at) VALUES (?, '500 E Colonial Dr, Orlando, FL', '1200 N Alafaya Trail, Orlando, FL', 'aberto', ?)")
      .run(driver.id, new Date().toISOString()).lastInsertRowid
  );
  ctx.data.services.setActive(driver.id, sid);
  // Sem localização mandada: foto de antes leva o endereço de retirada.
  await ctx.bot.handle({ phone: DRIVER_PHONE, text: 'antes', media: { buffer: semGps, mime: 'image/jpeg' } });
  await ctx.api.fotos.stamped();
  let photo = ctx.db.prepare('SELECT * FROM photos ORDER BY id DESC').get();
  assert.equal(photo.service_id, sid);
  assert.equal(photo.place_source, 'servico');
  assert.equal(photo.address, '500 E Colonial Dr, Orlando, FL');
  assert.equal(photo.lat, null);
  assert.ok(photo.stamped_file);

  // Mandou a localização: as próximas fotos usam ela.
  ctx.api.fotos.noteLocation(driver.id, { latitude: 28.6, longitude: -81.2 });
  await ctx.bot.handle({ phone: DRIVER_PHONE, text: 'depois', media: { buffer: semGps, mime: 'image/jpeg' } });
  await ctx.api.fotos.stamped();
  photo = ctx.db.prepare('SELECT * FROM photos ORDER BY id DESC').get();
  assert.equal(photo.place_source, 'whatsapp');
  assert.equal(photo.lat, 28.6);
  assert.equal(photo.address, '11435 Rocket Blvd, Orlando, Florida 32824');
});

test('FOTO_CARIMBO=off: guarda a foto sem carimbo', async () => {
  const ctx = makeContext({ FOTO_CARIMBO: 'off' });
  const driver = ctx.db.prepare('SELECT id FROM users WHERE phone = ?').get(DRIVER_PHONE);
  const sid = ctx.db.prepare("INSERT INTO services (driver_id, pickup, status, created_at) VALUES (?, '500 E Colonial Dr', 'aberto', ?)").run(driver.id, new Date().toISOString()).lastInsertRowid;
  ctx.data.services.setActive(driver.id, Number(sid));
  await ctx.bot.handle({ phone: DRIVER_PHONE, text: 'antes', media: { buffer: semGps, mime: 'image/jpeg' } });
  await ctx.api.fotos.stamped();
  assert.equal(ctx.db.prepare('SELECT stamped_file FROM photos').get().stamped_file, null);
});
