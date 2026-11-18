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
