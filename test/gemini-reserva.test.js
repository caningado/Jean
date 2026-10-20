import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext } from './helpers.js';
import { askGemini } from '../src/lib/gemini.js';

test('Gemini: se o modelo principal falha, tenta o modelo leve', async () => {
  const ctx = makeContext({ GEMINI_API_KEY: 'k', GEMINI_MODEL: 'modelo-bom', GEMINI_VOICE_MODEL: 'modelo-leve' });
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('modelo-bom')) return new Response('quota', { status: 429 });
    return Response.json({ candidates: [{ content: { parts: [{ text: '{"comando":"ajuda"}' }] } }] });
  };
  const a = await askGemini(ctx, { prompt: 'oi', schema: { type: 'OBJECT' }, model: ctx.config.geminiModel }, fetchImpl);
  assert.equal(a.comando, 'ajuda');
  assert.equal(urls.length, 2);
  assert.match(urls[1], /modelo-leve/);
});
