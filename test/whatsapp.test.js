import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';
import { processMessage, createWhatsAppClient } from '../src/modules/whatsapp/index.js';

const CLIENT_PHONE = '15085559999';

function fakeClient() {
  const sent = [];
  return { sent, sendText: async (to, body) => sent.push({ to, body }), downloadMedia: async () => null };
}

let seq = 0;
const message = (from, text, type = 'text') => ({ id: `wamid.${++seq}`, from, name: 'Cliente Teste', type, text, mediaId: null });

test('quem é de fora (padrão): o robô não responde nada ao cliente, mas guarda o contato', async () => {
  const ctx = makeContext();
  const client = fakeClient();
  await processMessage(ctx, client, message(CLIENT_PHONE, 'oi'));
  await processMessage(ctx, client, message(CLIENT_PHONE, '', 'audio'));
  assert.equal(client.sent.length, 0);
  const contact = ctx.db.prepare('SELECT * FROM contacts WHERE phone = ?').get(CLIENT_PHONE);
  assert.equal(contact.name, 'Cliente Teste');
});

test('quem é de fora nunca recebe resposta, mesmo com a variável antiga ligada', async () => {
  const ctx = makeContext({ WHATSAPP_RESPOSTA_FORA: 'sempre' });
  const client = fakeClient();
  await processMessage(ctx, client, message(CLIENT_PHONE, 'oi'));
  await processMessage(ctx, client, message(CLIENT_PHONE, 'preciso de um guincho'));
  assert.equal(client.sent.length, 0);
});

test('trava: o robô só manda mensagem para telefones da equipe', async () => {
  const ctx = makeContext({ WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '123' });
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body).to);
    return new Response('{}', { status: 200 });
  };
  const client = createWhatsAppClient(ctx.config, fakeFetch, { isTeam: (phone) => Boolean(ctx.bot.findUser(phone)) });
  assert.equal(await client.sendText(DRIVER_PHONE, 'oi'), true);
  await assert.rejects(client.sendText(CLIENT_PHONE, 'oi'), /não é da equipe/);
  // Motorista desligado da equipe também não recebe
  ctx.db.prepare('UPDATE users SET active = 0 WHERE phone = ?').run(DRIVER_PHONE);
  await assert.rejects(client.sendText(DRIVER_PHONE, 'oi'), /não é da equipe/);
  assert.deepEqual(calls, [DRIVER_PHONE]);
  // Sem dizer quem é da equipe, não manda para ninguém
  await assert.rejects(createWhatsAppClient(ctx.config, fakeFetch).sendText(OWNER_PHONE, 'oi'), /não é da equipe/);
});

test('a equipe continua sendo atendida pelo robô', async () => {
  const ctx = makeContext();
  const client = fakeClient();
  await processMessage(ctx, client, message(DRIVER_PHONE, 'ajuda'));
  assert.ok(client.sent.length > 0);
  assert.equal(client.sent[0].to, DRIVER_PHONE);
});
