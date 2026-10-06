import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, DRIVER_PHONE } from './helpers.js';
import { processMessage } from '../src/modules/whatsapp/index.js';

const CLIENT_PHONE = '15085559999';

function fakeClient() {
  const sent = [];
  return { sent, sendText: async (to, body) => sent.push({ to, body }), downloadMedia: async () => null };
}

let seq = 0;
const message = (from, text, type = 'text') => ({ id: `wamid.${++seq}`, from, name: 'Cliente Teste', type, text, mediaId: null });

test('quem é de fora com resposta nunca: o robô fica calado, mas guarda o contato', async () => {
  const ctx = makeContext({ WHATSAPP_RESPOSTA_FORA: 'nunca' });
  const client = fakeClient();
  await processMessage(ctx, client, message(CLIENT_PHONE, 'oi'));
  await processMessage(ctx, client, message(CLIENT_PHONE, '', 'audio'));
  assert.equal(client.sent.length, 0);
  const contact = ctx.db.prepare('SELECT * FROM contacts WHERE phone = ?').get(CLIENT_PHONE);
  assert.equal(contact.name, 'Cliente Teste');
});

test('quem é de fora (padrão diário): responde só na primeira mensagem', async () => {
  const ctx = makeContext();
  const client = fakeClient();
  await processMessage(ctx, client, message(CLIENT_PHONE, 'oi'));
  await processMessage(ctx, client, message(CLIENT_PHONE, 'preciso de um guincho'));
  const toClient = client.sent.filter((m) => m.to === CLIENT_PHONE);
  assert.equal(toClient.length, 1);
  assert.match(toClient[0].body, /Thanks for contacting/);
  assert.ok(client.sent.some((m) => m.body.includes('📩') && m.body.includes('oi')));
});

test('quem é de fora com resposta sempre: responde toda mensagem', async () => {
  const ctx = makeContext({ WHATSAPP_RESPOSTA_FORA: 'sempre' });
  const client = fakeClient();
  await processMessage(ctx, client, message(CLIENT_PHONE, 'oi'));
  await processMessage(ctx, client, message(CLIENT_PHONE, 'oi de novo'));
  assert.equal(client.sent.filter((m) => m.to === CLIENT_PHONE).length, 2);
});

test('a equipe continua sendo atendida pelo robô', async () => {
  const ctx = makeContext();
  const client = fakeClient();
  await processMessage(ctx, client, message(DRIVER_PHONE, 'ajuda'));
  assert.ok(client.sent.length > 0);
  assert.equal(client.sent[0].to, DRIVER_PHONE);
});

test('se o aviso ao dono falhar, o cliente recebe a resposta mesmo assim', async () => {
  const ctx = makeContext();
  const client = fakeClient();
  const send = client.sendText;
  client.sendText = async (to, body) => {
    if (to !== CLIENT_PHONE) throw new Error('falhou');
    return send(to, body);
  };
  await processMessage(ctx, client, message(CLIENT_PHONE, 'oi'));
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].to, CLIENT_PHONE);
});
