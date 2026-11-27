import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeContext, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSmsClient, extractSms, paraSms, partes, processSms, validTwilioSignature, vcardParaTexto } from '../src/modules/sms/index.js';

const CLIENT_PHONE = '15085559999';
const TWILIO = { TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'segredo', TWILIO_NUMERO: '+14075550000' };

function fakeSms() {
  const sent = [];
  return { canal: 'sms', sent, sendText: async (to, body) => sent.push({ to, body }), downloadMedia: async () => null };
}

let seq = 0;
const sms = (from, text) => ({ id: `SM${++seq}`, from, to: '14075550000', name: null, type: 'text', text, mediaId: null });

function assinar(url, params, token = 'segredo') {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return crypto.createHmac('sha1', token).update(data).digest('base64');
}

test('SMS: a equipe é atendida com os mesmos comandos do WhatsApp', async () => {
  const ctx = makeContext();
  const client = fakeSms();
  const primeira = sms(DRIVER_PHONE, 'ajuda');
  await processSms(ctx, client, primeira);
  assert.ok(client.sent.length > 0);
  assert.equal(client.sent[0].to, DRIVER_PHONE);
  // A mesma mensagem entregue duas vezes não é respondida de novo
  const n = client.sent.length;
  await processSms(ctx, client, { ...primeira });
  assert.equal(client.sent.length, n);
});

test('SMS: cliente (fora da equipe) não recebe resposta, só fica nos contatos', async () => {
  const ctx = makeContext();
  const client = fakeSms();
  await processSms(ctx, client, sms(CLIENT_PHONE, 'preciso de guincho'));
  assert.equal(client.sent.length, 0);
  assert.equal(ctx.db.prepare('SELECT source FROM contacts WHERE phone = ?').get(CLIENT_PHONE).source, 'sms');
});

test('SMS: o cliente da Twilio só manda para a equipe, tira o negrito e divide texto comprido', async () => {
  const ctx = makeContext(TWILIO);
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, body: new URLSearchParams(opts.body), auth: opts.headers.Authorization });
    return new Response('{}', { status: 201 });
  };
  const client = createSmsClient(ctx.config, fakeFetch, { isTeam: (phone) => Boolean(ctx.bot.findUser(phone)) });
  assert.equal(client.configured, true);
  await client.sendText(DRIVER_PHONE, 'Mande *ajuda* para ver os _comandos_.');
  await assert.rejects(client.sendText(CLIENT_PHONE, 'oi'), /não é da equipe/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
  assert.equal(calls[0].body.get('To'), '+' + DRIVER_PHONE);
  assert.equal(calls[0].body.get('From'), '+14075550000');
  assert.equal(calls[0].body.get('Body'), 'Mande ajuda para ver os comandos.');
  assert.equal(calls[0].auth, 'Basic ' + Buffer.from('AC123:segredo').toString('base64'));

  const longo = Array.from({ length: 60 }, (_, i) => `Linha ${i} com um texto qualquer`).join('\n');
  await client.sendText(DRIVER_PHONE, longo);
  const pedacos = calls.slice(1).map((c) => c.body.get('Body'));
  assert.ok(pedacos.length >= 2);
  assert.ok(pedacos.every((p) => p.length <= 1600));
  assert.equal(pedacos.join('\n'), longo);
});

test('SMS: limpa a formatação do WhatsApp sem estragar links e e-mails', () => {
  assert.equal(paraSms('*Serviço #12* entregue'), 'Serviço #12 entregue');
  assert.equal(paraSms('veja https://site.com/a_b_c e foo_bar@x.com'), 'veja https://site.com/a_b_c e foo_bar@x.com');
  assert.deepEqual(partes('curto'), ['curto']);
});

test('SMS: lê o formato da Twilio (texto, fotos, áudio, PDF e cartão de contato)', () => {
  const [texto] = extractSms({ MessageSid: 'SM1', From: '+15085550111', To: '+14075550000', Body: 'oi', NumMedia: '0' });
  assert.deepEqual(texto, { id: 'SM1', from: DRIVER_PHONE, to: '14075550000', name: null, type: 'text', text: 'oi', mediaId: null });
  const mms = extractSms({
    MessageSid: 'SM2', From: '+15085550111', Body: 'VIN', NumMedia: '4',
    MediaUrl0: 'https://x/0', MediaContentType0: 'image/jpeg',
    MediaUrl1: 'https://x/1', MediaContentType1: 'audio/amr',
    MediaUrl2: 'https://x/2', MediaContentType2: 'application/pdf',
    MediaUrl3: 'https://x/3', MediaContentType3: 'text/vcard',
  });
  assert.deepEqual(mms.map((m) => [m.id, m.type, m.text]), [['SM2', 'image', 'VIN'], ['SM2-1', 'audio', ''], ['SM2-2', 'document', ''], ['SM2-3', 'contacts', '']]);
  assert.equal(mms[1].audio, true);
  assert.equal(mms[2].doc.mime, 'application/pdf');
  assert.equal(vcardParaTexto('BEGIN:VCARD\nVERSION:3.0\nFN:Moita\nTEL;TYPE=CELL:+1 407 555 0111\nEND:VCARD'), 'Contato do cliente: Moita +1 407 555 0111');
});

test('SMS: avisos vão pelo canal que a pessoa usou por último', async () => {
  const ctx = makeContext({ ...TWILIO, WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1' });
  const pelo = [];
  ctx.api.sms.client.sendText = async (to, text) => pelo.push(['sms', to, text]);
  ctx.api.whatsapp.client.sendText = async (to, text) => pelo.push(['whatsapp', to, text]);
  ctx.api.whatsapp.client.sendImage = async (to, b, m, caption) => pelo.push(['whatsapp', to, caption]);
  {
    const driver = ctx.bot.findUser(DRIVER_PHONE);
    await ctx.send(DRIVER_PHONE, 'aviso 1'); // nunca usou SMS: vai pelo WhatsApp
    ctx.api.canais.mark(driver.id, 'sms');
    await ctx.send(DRIVER_PHONE, 'aviso 2');
    await ctx.send(OWNER_PHONE, 'aviso 3'); // o dono continua no WhatsApp
    await ctx.sendImage(DRIVER_PHONE, Buffer.from('x'), 'image/jpeg', 'Foto do pedido #3');
    // Voltou a mandar pelo WhatsApp: volta para o WhatsApp
    ctx.api.canais.mark(driver.id, 'whatsapp');
    await ctx.send(DRIVER_PHONE, 'aviso 4');
  }
  assert.deepEqual(pelo, [
    ['whatsapp', DRIVER_PHONE, 'aviso 1'],
    ['sms', DRIVER_PHONE, 'aviso 2'],
    ['whatsapp', OWNER_PHONE, 'aviso 3'],
    ['sms', DRIVER_PHONE, '📷 Foto do pedido #3\n(A foto está no painel.)'],
    ['whatsapp', DRIVER_PHONE, 'aviso 4'],
  ]);
});

test('SMS: quem escreve por SMS passa a receber os avisos por SMS', async () => {
  const ctx = makeContext({ ...TWILIO, WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1' });
  await processSms(ctx, fakeSms(), sms(DRIVER_PHONE, 'oi'));
  assert.equal(ctx.api.canais.of(DRIVER_PHONE), 'sms');
  assert.equal(ctx.api.canais.of(OWNER_PHONE), 'whatsapp');
});

test('SMS: sem WhatsApp ligado, tudo vai por SMS', async () => {
  const ctx = makeContext(TWILIO);
  const pelo = [];
  ctx.api.sms.client.sendText = async (to, text) => pelo.push(text);
  await ctx.send(OWNER_PHONE, 'bom dia');
  assert.deepEqual(pelo, ['bom dia']);
});

test('SMS: o webhook só aceita pedido assinado pela Twilio', async () => {
  const ctx = makeContext({ ...TWILIO, PUBLIC_URL: 'https://jay.example.com' });
  const respondidas = [];
  ctx.api.sms.client.sendText = async (to, text) => respondidas.push({ to, text });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const params = { MessageSid: 'SMweb1', From: '+15085550111', To: '+14075550000', Body: 'ajuda', NumMedia: '0' };
    const post = (sig) =>
      fetch(`${base}/webhook/sms`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig }, body: new URLSearchParams(params).toString() });
    assert.equal((await post('assinatura-falsa')).status, 403);
    assert.equal(validTwilioSignature('https://jay.example.com/webhook/sms', params, assinar('https://jay.example.com/webhook/sms', params), 'segredo'), true);
    const ok = await post(assinar('https://jay.example.com/webhook/sms', params));
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /<Response><\/Response>/);
    for (let i = 0; i < 50 && !respondidas.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(respondidas.length > 0);
    assert.equal(respondidas[0].to, DRIVER_PHONE);
  } finally {
    server.close();
  }
});
