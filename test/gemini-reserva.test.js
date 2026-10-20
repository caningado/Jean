import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext } from './helpers.js';
import { askGemini } from '../src/lib/gemini.js';

test('Gemini: se o modelo principal falha, tenta o modelo leve', async () => {
  const ctx = makeContext({ GEMINI_API_KEY: 'k', GEMINI_MODEL: 'modelo-leve', GEMINI_VOICE_MODEL: 'modelo-bom' });
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('modelo-bom')) return new Response('quota', { status: 429 });
    return Response.json({ candidates: [{ content: { parts: [{ text: '{"comando":"ajuda"}' }] } }] });
  };
  const a = await askGemini(ctx, { prompt: 'oi', schema: { type: 'OBJECT' }, model: ctx.config.geminiVoiceModel }, fetchImpl);
  assert.equal(a.comando, 'ajuda');
  assert.equal(urls.length, 2);
  assert.match(urls[1], /modelo-leve/);
});

test('Gemini lotado (503): dá uma segunda volta e consegue; chave errada (403) para logo', async () => {
  const ctx = makeContext({ GEMINI_API_KEY: 'k', GEMINI_MODEL: 'a', GEMINI_VOICE_MODEL: 'b', GEMINI_RESERVAS: 'c' });
  let n = 0;
  const busy = async (url) => {
    n++;
    if (n <= 3) return new Response('{"message":"This model is currently experiencing high demand."}', { status: 503 });
    return Response.json({ candidates: [{ content: { parts: [{ text: '{"comando":"ajuda"}' }] } }] });
  };
  const a = await askGemini(ctx, { prompt: 'oi', schema: { type: 'OBJECT' } }, busy);
  assert.equal(a.comando, 'ajuda');
  assert.equal(n, 4); // b, a, c falharam; na 2ª volta b respondeu

  let m = 0;
  const denied = async () => (m++, new Response('bad key', { status: 403 }));
  await assert.rejects(askGemini(ctx, { prompt: 'oi', schema: { type: 'OBJECT' } }, denied), /403/);
  assert.equal(m, 1);
});
