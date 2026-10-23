import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, chat, DRIVER_PHONE } from './helpers.js';

// Gemini e NHTSA de mentira: a foto "tem" o VIN e o carro é uma RAM 2018.
function fakeApis(t, geminiAnswers) {
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  const prompts = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('vpic.nhtsa.dot.gov')) return Response.json({ Results: [{ ModelYear: '2018', Make: 'RAM', Model: '2500' }] });
    if (String(url).includes('generativelanguage.googleapis.com')) {
      const parts = JSON.parse(opts.body).contents[0].parts;
      prompts.push(parts.map((p) => p.text || '').join(' '));
      if (parts.some((p) => p.inline_data)) return Response.json({ candidates: [{ content: { parts: [{ text: '3C6URVJG2JE139479' }] } }] });
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(geminiAnswers.shift() || {}) }] } }] });
    }
    return realFetch(url, opts);
  };
  return prompts;
}

test('foto de VIN sem serviço aberto: lê, mostra o carro e põe no próximo serviço', async (t) => {
  const ctx = makeContext({ GEMINI_API_KEY: 'k' });
  const answers = [];
  const prompts = fakeApis(t, answers);
  const media = { buffer: Buffer.from([0xff, 0xd8, 0xff]), mime: 'image/jpeg' };

  const [read] = await ctx.bot.handle({ phone: DRIVER_PHONE, text: '', media });
  assert.match(read, /VIN: \*3C6URVJG2JE139479\*/);
  assert.match(read, /Veículo: 2018 RAM 2500/);
  assert.match(read, /Quando você mandar \*novo\*/);

  // "Qual VIN?": a inteligência recebe o último VIN lido para responder.
  answers.push({ comando: '', resposta: 'O VIN é 3C6URVJG2JE139479 (2018 RAM 2500).' });
  const [qual] = await chat(ctx, DRIVER_PHONE, 'Qual VIN?');
  assert.match(qual, /3C6URVJG2JE139479/);
  assert.match(prompts.at(-1), /Último VIN que ele mandou em foto[^\n]*3C6URVJG2JE139479 \(2018 RAM 2500\)/);
  assert.match(prompts.at(-1), /Lê o VIN de uma foto/);

  const replies = await chat(ctx, DRIVER_PHONE, 'novo', '5085550123', 'John Smith', 'Rua Alfa', 'pular', 'pular', 'pular', 'sim');
  assert.match(replies.at(-1), /VIN: 3C6URVJG2JE139479/);
  const service = ctx.db.prepare('SELECT vin, vehicle FROM services').get();
  assert.equal(service.vin, '3C6URVJG2JE139479');
  assert.equal(service.vehicle, '2018 RAM 2500');
});

test('foto sem VIN e sem serviço: explica em vez de só recusar', async () => {
  const ctx = makeContext();
  const media = { buffer: Buffer.from([0xff, 0xd8, 0xff]), mime: 'image/jpeg' };
  const [reply] = await ctx.bot.handle({ phone: DRIVER_PHONE, text: '', media });
  assert.match(reply, /Não achei um VIN nessa foto/);
});
