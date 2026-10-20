import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';
import { textoParaFala, toWav, toOgg, speak, MAX_FALA } from '../src/lib/tts.js';
import { createWhatsAppClient, replyByVoice } from '../src/modules/whatsapp/index.js';

const pcm = { pcm: Buffer.alloc(24000 * 2 * 0.2), rate: 24000 }; // 0,2 s de silêncio

test('voz: tira negrito, emojis e links do texto falado', () => {
  assert.equal(textoParaFala('🤖 *resumo*\nHoje: $150.00 ✅ https://x.com/a'), 'resumo\nHoje: $150.00');
});

test('voz: PCM vira .wav e .ogg (mensagem de voz)', async () => {
  const wav = toWav(pcm);
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 24000);
  const ogg = await toOgg(pcm);
  assert.equal(ogg.subarray(0, 4).toString(), 'OggS');
});

test('voz: pede o áudio ao Gemini e lê a taxa do PCM', async () => {
  const ctx = makeContext({ GEMINI_API_KEY: 'k' });
  let body;
  const fetchImpl = async (url, opts) => {
    body = JSON.parse(opts.body);
    assert.match(url, /gemini-2\.5-flash-preview-tts:generateContent/);
    return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.from('abcd').toString('base64') } }] } }] });
  };
  const out = await speak(ctx, 'Oi, tudo certo', fetchImpl);
  assert.equal(out.rate, 24000);
  assert.equal(out.pcm.toString(), 'abcd');
  assert.deepEqual(body.generationConfig.responseModalities, ['AUDIO']);
  assert.match(body.contents[0].parts[0].text, /Oi, tudo certo/);
});

test('WhatsApp: sobe o áudio e manda como mensagem de voz, só para a equipe', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return url.endsWith('/media') ? Response.json({ id: 'm1' }) : Response.json({});
  };
  const config = { whatsapp: { token: 't', phoneNumberId: '99', apiVersion: 'v21.0' } };
  const client = createWhatsAppClient(config, fetchImpl, { isTeam: (p) => p === DRIVER_PHONE });
  await client.sendAudio(DRIVER_PHONE, Buffer.from('OggS'));
  assert.match(calls[0].url, /\/99\/media$/);
  assert.ok(calls[0].opts.body instanceof FormData);
  assert.deepEqual(JSON.parse(calls[1].opts.body).audio, { id: 'm1' });
  await assert.rejects(client.sendAudio('15085559999', Buffer.from('x')), /não é da equipe/);
});

test('WhatsApp: responde em áudio quando é curto; texto comprido fica só escrito', async () => {
  const ctx = makeContext({ GEMINI_API_KEY: 'k' });
  const sent = [];
  const client = { sendAudio: async (to, ogg) => sent.push([to, ogg.toString()]) };
  const voice = { speak: async (c, text) => ({ text }), toOgg: async (p) => Buffer.from(`ogg:${p.text}`) };
  await replyByVoice(ctx, client, DRIVER_PHONE, ['✅ *Despesa* salva'], voice);
  assert.deepEqual(sent, [[DRIVER_PHONE, 'ogg:Despesa salva']]);
  await replyByVoice(ctx, client, DRIVER_PHONE, ['x'.repeat(MAX_FALA + 1)], voice);
  assert.equal(sent.length, 1);

  const off = makeContext({ GEMINI_API_KEY: 'k', ROBO_VOZ: 'off' });
  await replyByVoice(off, client, DRIVER_PHONE, ['oi'], voice);
  assert.equal(sent.length, 1);
});

test('Testar o robô: áudio recebe a resposta também em áudio (.wav)', async (t) => {
  const { createApp } = await import('../src/app.js');
  const ctx = makeContext({ GEMINI_API_KEY: 'k' });
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('generativelanguage.googleapis.com')) return real(url, opts);
    if (String(url).includes('-tts:')) {
      return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(100).toString('base64') } }] } }] });
    }
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ comando: 'caixa', transcricao: 'quanto tem no caixa' }) }] } }] });
  };
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await real(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const res = await real(`${base}/api/bot/simulate/audio`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'audio/wav' }, body: Buffer.alloc(2000, 1) });
  const { replies, voz } = await res.json();
  assert.ok(replies.length >= 1);
  assert.equal(Buffer.from(voz, 'base64').subarray(0, 4).toString(), 'RIFF');
});
