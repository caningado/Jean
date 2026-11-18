import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';
import { processMessage, createWhatsAppClient } from '../src/modules/whatsapp/index.js';

// Pedido do dono (18/11): por enquanto o Jay não fala com ninguém pelo WhatsApp.
test('Jay em silêncio (padrão): não manda nada, não executa comando, mas guarda na caixa', async () => {
  const ctx = makeContext({ JAY_WHATSAPP: '' });
  assert.equal(ctx.config.whatsapp.conversar, false);
  const sent = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const client = { sendText: async (to, text) => sent.push({ to, text }), downloadMedia: async () => ({ buffer: png, mime: 'image/png' }) };
  await processMessage(ctx, client, { id: 'a1', from: OWNER_PHONE, type: 'text', text: 'Equinox azul na 7305 spring villas', mediaId: null });
  await processMessage(ctx, client, { id: 'a2', from: OWNER_PHONE, type: 'text', text: 'ajuda', mediaId: null });
  await processMessage(ctx, client, { id: 'a3', from: OWNER_PHONE, type: 'image', text: '', mediaId: 'm1' });
  await processMessage(ctx, client, { id: 'a4', from: DRIVER_PHONE, type: 'text', text: 'novo', mediaId: null });
  assert.deepEqual(sent.filter((m) => m.to === DRIVER_PHONE), [], 'nada para o motorista');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM jay_inbox').get().n, 3, 'mensagens do dono na caixa');
  assert.ok(ctx.db.prepare("SELECT file FROM jay_inbox WHERE wa_id = 'a3'").get().file, 'foto guardada');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM services').get().n, 0, 'nenhum comando executado');
});

test('Jay em silêncio: o cliente do WhatsApp não manda texto, foto nem áudio', async () => {
  const calls = [];
  const fetchImpl = async (url) => (calls.push(url), { ok: true, json: async () => ({ id: 'x' }), text: async () => '' });
  const config = { whatsapp: { token: 't', phoneNumberId: 'p', apiVersion: 'v21.0', conversar: false } };
  const client = createWhatsAppClient(config, fetchImpl, { isTeam: () => true });
  assert.equal(await client.sendText(OWNER_PHONE, 'oi'), false);
  assert.equal(await client.sendImage(OWNER_PHONE, Buffer.from('x'), 'image/png', ''), false);
  assert.equal(await client.sendAudio(OWNER_PHONE, Buffer.from('x')), false);
  assert.deepEqual(calls, []);
  const on = createWhatsAppClient({ whatsapp: { ...config.whatsapp, conversar: true } }, fetchImpl, { isTeam: () => true });
  assert.equal(await on.sendText(OWNER_PHONE, 'oi'), true);
  assert.equal(calls.length, 1);
});

test('Jay em silêncio: foto do dono com VIN volta com o VIN para copiar (só isso)', async (t) => {
  const ctx = makeContext({ JAY_WHATSAPP: '', GEMINI_API_KEY: 'k' });
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  let temVin = true;
  globalThis.fetch = async (url) => {
    if (String(url).includes('vpic.nhtsa.dot.gov')) return Response.json({ Results: [{ ModelYear: '2018', Make: 'RAM', Model: '2500' }] });
    if (String(url).includes('generativelanguage.googleapis.com')) return Response.json({ candidates: [{ content: { parts: [{ text: temVin ? '3C6URVJG2JE139479' : 'nenhum' }] } }] });
    return realFetch(url);
  };
  const sent = [];
  const jpg = Buffer.from([0xff, 0xd8, 0xff]);
  const client = { sendText: async (to, text, opts) => sent.push({ to, text, excecao: !!opts?.excecao }), downloadMedia: async () => ({ buffer: jpg, mime: 'image/jpeg' }) };
  await processMessage(ctx, client, { id: 'v1', from: OWNER_PHONE, type: 'image', text: '', mediaId: 'm1' });
  assert.deepEqual(sent.map((m) => m.to), [OWNER_PHONE, OWNER_PHONE]);
  assert.equal(sent[0].text, '3C6URVJG2JE139479'); // sozinho, para copiar
  assert.match(sent[1].text, /Li esse VIN.*\nVeículo: 2018 RAM 2500/);
  assert.ok(sent.every((m) => m.excecao));
  assert.ok(ctx.db.prepare("SELECT file FROM jay_inbox WHERE wa_id = 'v1'").get().file, 'a foto continua na caixa');

  // Foto sem VIN e foto do motorista: nada.
  temVin = false;
  await processMessage(ctx, client, { id: 'v2', from: OWNER_PHONE, type: 'image', text: '', mediaId: 'm2' });
  temVin = true;
  await processMessage(ctx, client, { id: 'v3', from: DRIVER_PHONE, type: 'image', text: '', mediaId: 'm3' });
  assert.equal(sent.length, 2);
});

test('Jay em silêncio: só a exceção do VIN passa pelo cliente do WhatsApp', async () => {
  const calls = [];
  const fetchImpl = async (url) => (calls.push(url), { ok: true, json: async () => ({ id: 'x' }), text: async () => '' });
  const client = createWhatsAppClient({ whatsapp: { token: 't', phoneNumberId: 'p', apiVersion: 'v21.0', conversar: false } }, fetchImpl, { isTeam: () => true });
  assert.equal(await client.sendText(OWNER_PHONE, 'oi'), false);
  assert.equal(await client.sendText(OWNER_PHONE, '3C6URVJG2JE139479', { excecao: true }), true);
  assert.equal(calls.length, 1);
});
