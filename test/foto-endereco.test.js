import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, DRIVER_PHONE } from './helpers.js';
import { hashPin } from '../src/lib/auth.js';

const VIVIANE = '14073691819';
const photo = { buffer: Buffer.from([0xff, 0xd8, 0xff]), mime: 'image/jpeg' };

// Gemini de mentira: a 1ª resposta é a leitura da foto, as outras são da conversa.
function fakeGemini(t, answers) {
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('generativelanguage.googleapis.com')) return realFetch(url, opts);
    const parts = JSON.parse(opts.body).contents[0].parts;
    const image = parts.some((p) => p.inline_data);
    const answer = image && /vin/.test(parts.at(-1).text) && !/endereco/.test(parts.at(-1).text) ? '' : JSON.stringify(answers.shift() || {});
    return Response.json({ candidates: [{ content: { parts: [{ text: answer }] } }] });
  };
}

function setup() {
  const ctx = makeContext({ GEMINI_API_KEY: 'k', AJUDA_TELEFONE: VIVIANE });
  ctx.db.prepare("INSERT INTO users (name, phone, role, pin_hash, created_at) VALUES ('Viviane', ?, 'dono', ?, ?)").run(VIVIANE, hashPin('9999'), new Date().toISOString());
  const sent = [];
  const images = [];
  ctx.send = async (to, text) => sent.push({ to, text });
  ctx.sendImage = async (to, buffer, mime, caption) => images.push({ to, caption });
  return { ctx, sent, images };
}

test('foto com endereço: o Jay mostra o que leu e pergunta se está certo; sim → serviço novo', async (t) => {
  const { ctx, sent } = setup();
  fakeGemini(t, [{ tipo: 'endereco', texto: 'WDC Painting & Body Inc, 11435 Rocket Blvd, Suite 102, Orlando, FL 32824' }]);
  let replies = await ctx.bot.handle({ phone: DRIVER_PHONE, text: '', media: photo });
  assert.match(replies.join('\n'), /📝 Li na foto:\nWDC Painting & Body Inc, 11435 Rocket Blvd/);
  assert.match(replies.join('\n'), /Está certo\?/);
  assert.equal(sent.length, 0); // nada para a Viviane
  replies = await ctx.bot.handle({ phone: DRIVER_PHONE, text: 'sim' });
  assert.match(replies.join('\n'), /pegar\* o carro ou para \*levar/);
  replies = await ctx.bot.handle({ phone: DRIVER_PHONE, text: 'levar' });
  const conv = ctx.bot.getConversation(ctx.bot.findUser(DRIVER_PHONE).id);
  assert.equal(conv?.flow, 'novo');
  assert.match(conv.data._prefill?.dropoff || conv.data.dropoff || JSON.stringify(conv.data), /11435 Rocket Blvd/);
  assert.equal(sent.length, 0);
});

test('foto com endereço lido errado: só aí vai para a Viviane, com a foto', async (t) => {
  const { ctx, sent, images } = setup();
  fakeGemini(t, [{ tipo: 'endereco', texto: '11435 Rocket Blvd, Orlando FL' }]);
  await ctx.bot.handle({ phone: DRIVER_PHONE, text: '', media: photo });
  const replies = await ctx.bot.handle({ phone: DRIVER_PHONE, text: 'não' });
  assert.match(replies.join('\n'), /Passei para Viviane resolver/);
  assert.match(sent[0].text, /o Jay leu a foto errado/);
  assert.equal(images.length, 1);
});

test('foto com pegar e deixar: sim → abre o serviço direto', async (t) => {
  const { ctx } = setup();
  fakeGemini(t, [{ tipo: 'endereco', texto: 'Pegar: 1200 N Alafaya Trail, Orlando FL\nDeixar: 500 E Colonial Dr, Orlando FL' }]);
  await ctx.bot.handle({ phone: DRIVER_PHONE, text: '', media: photo });
  const replies = await ctx.bot.handle({ phone: DRIVER_PHONE, text: 'sim' });
  assert.match(replies.join('\n'), /Pegar: 1200 N Alafaya Trail/);
  assert.equal(ctx.bot.getConversation(ctx.bot.findUser(DRIVER_PHONE).id)?.flow, 'novo');
});

test('foto com endereço que não deu para ler: vai para a Viviane, com a foto', async (t) => {
  const { ctx, sent, images } = setup();
  fakeGemini(t, [{ tipo: 'endereco', texto: '' }]);
  const replies = await ctx.bot.handle({ phone: DRIVER_PHONE, text: '', media: photo });
  assert.match(replies.join('\n'), /Passei para Viviane resolver/);
  assert.match(sent[0].text, /não conseguiu ler o endereço da foto/);
  assert.equal(images[0].to, VIVIANE);
  assert.match(images[0].caption, /Foto do pedido #1, mandada por Jorge/);
});

test('foto que o Jay não entende (sem VIN, sem serviço): vai para a Viviane, com a foto', async (t) => {
  const { ctx, sent, images } = setup();
  fakeGemini(t, [{ tipo: 'outro', texto: '' }]);
  const replies = await ctx.bot.handle({ phone: DRIVER_PHONE, text: '', media: photo });
  assert.match(replies.join('\n'), /Passei para Viviane resolver/);
  assert.match(sent[0].text, /não entendeu a foto/);
  assert.equal(images.length, 1);
});
