import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, chat, DRIVER_PHONE } from './helpers.js';

// Gemini de mentira: responde a próxima resposta da fila.
function fakeGemini(t) {
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  const answers = [];
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('generativelanguage.googleapis.com')) return realFetch(url, opts);
    calls.push(JSON.parse(opts.body).contents[0].parts);
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answers.shift() || {}) }] } }] });
  };
  return { answers, calls };
}

test('Robô com Gemini: entende texto livre e traduz para o comando', async (t) => {
  const ctx = makeContext({ GEMINI_API_KEY: 'k' });
  const g = fakeGemini(t);

  // Comando normal não chama o Gemini
  await chat(ctx, DRIVER_PHONE, 'ajuda');
  assert.equal(g.calls.length, 0);

  // Consulta: roda direto
  g.answers.push({ comando: 'resumo', transcricao: 'quanto deu hoje?' });
  let [r] = await chat(ctx, DRIVER_PHONE, 'quanto deu hoje?');
  assert.match(r, /🤖 \*resumo\*/);
  assert.match(g.calls[0][0].text, /\*gasto 80 diesel\*/); // o Gemini recebe a lista de comandos
  assert.match(g.calls[0][0].text, /quanto deu hoje\?/);

  // Despesa: pede "sim" antes
  g.answers.push({ comando: 'gasto 80 diesel' });
  [r] = await chat(ctx, DRIVER_PHONE, 'abasteci oitenta de diesel agora');
  assert.match(r, /Entendi: \*gasto 80 diesel\*[\s\S]*sim/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n, 0);
  [r] = await chat(ctx, DRIVER_PHONE, 'sim');
  assert.match(r, /Despesa de \$80\.00/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n, 1);

  // Outra coisa no lugar do "sim": não faz e segue a mensagem normal
  g.answers.push({ comando: 'gasto 20 pedagio' });
  await chat(ctx, DRIVER_PHONE, 'paguei vinte de pedágio');
  [r] = await chat(ctx, DRIVER_PHONE, 'fila');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n, 1);

  // Pergunta / conversa: responde o texto do Gemini
  g.answers.push({ comando: '', resposta: 'Mande a foto do VIN com a legenda vin.' });
  [r] = await chat(ctx, DRIVER_PHONE, 'como eu salvo o chassi?');
  assert.equal(r, 'Mande a foto do VIN com a legenda vin.');

  // Gemini inventou um comando que não existe: não faz nada
  g.answers.push({ comando: 'apagar tudo' });
  [r] = await chat(ctx, DRIVER_PHONE, 'apaga tudo');
  assert.match(r, /Não entendi/);
});

test('Robô com Gemini: serviço novo ditado já responde as perguntas e pergunta o que falta', async (t) => {
  const ctx = makeContext({ GEMINI_API_KEY: 'k' });
  const g = fakeGemini(t);
  g.answers.push({ comando: 'novo', cliente: 'Ana Lima', telefone: '4075551234', retirada: '1 Main St, Oviedo FL (28.67, -81.2)', veiculo: 'Honda Civic ABC1234' });
  let [r] = await chat(ctx, DRIVER_PHONE, 'serviço pra Ana Lima 407 555 1234, pegar na 1 Main St em Oviedo, Honda Civic ABC1234');
  // Telefone novo: o nome entrou sozinho; parou no destino (não foi dito)
  assert.match(r, /Para onde vai \*levar\*/);
  [r] = await chat(ctx, DRIVER_PHONE, 'pular');
  assert.match(r, /\*valor\*/); // o Jay não pergunta milhas
  [r] = await chat(ctx, DRIVER_PHONE, '150');
  assert.match(r, /Confere\?[\s\S]*Ana Lima[\s\S]*Honda Civic · ABC1234[\s\S]*\$150\.00/);
  [r] = await chat(ctx, DRIVER_PHONE, 'sim');
  assert.match(r, /Serviço #\d+ criado/);
});

test('Robô com Gemini: áudio vira comando, e no meio do cadastro vira a resposta', async (t) => {
  const ctx = makeContext({ GEMINI_API_KEY: 'k' });
  const g = fakeGemini(t);
  const audio = { buffer: Buffer.from('ogg'), mime: 'audio/ogg; codecs=opus' };

  g.answers.push({ comando: 'resumo', transcricao: 'como foi o dia' });
  let r = await ctx.bot.handle({ phone: DRIVER_PHONE, audio });
  assert.equal(r[0], '🎤 Ouvi: "como foi o dia"');
  assert.match(r[1], /🤖 \*resumo\*/);
  assert.equal(g.calls[0][0].inline_data.mime_type, 'audio/ogg');

  await chat(ctx, DRIVER_PHONE, 'novo');
  g.answers.push({ texto: 'Ana Lima' });
  r = await ctx.bot.handle({ phone: DRIVER_PHONE, audio });
  assert.equal(r[0], '🎤 Ouvi: "Ana Lima"');
  assert.match(g.calls[1][1].text, /telefone/); // o Gemini recebeu a pergunta do robô
  assert.match(r.at(-1), /telefone/);
});

test('Robô com Gemini: comando falado ("ajuda", "Novo serviço.") funciona mesmo se o Gemini não preencher o comando', async (t) => {
  const ctx = makeContext({ GEMINI_API_KEY: 'k' });
  const g = fakeGemini(t);
  const audio = { buffer: Buffer.from('ogg'), mime: 'audio/ogg' };
  g.answers.push({ comando: '', transcricao: 'ajuda' });
  let r = await ctx.bot.handle({ phone: DRIVER_PHONE, audio });
  assert.equal(r[0], '🎤 Ouvi: "ajuda"');
  assert.match(r.join('\n'), /\*Comandos\*/);

  g.answers.push({ comando: '', transcricao: 'Novo serviço.' });
  r = await ctx.bot.handle({ phone: DRIVER_PHONE, audio });
  assert.match(r.at(-1), /telefone/);
  assert.equal(ctx.bot.getConversation(ctx.bot.findUser(DRIVER_PHONE).id).flow, 'novo');
});

test('Robô com Gemini: no meio do cadastro, fala tudo fora de ordem e ele só pergunta o que falta', async (t) => {
  const ctx = makeContext({ GEMINI_API_KEY: 'k' });
  const g = fakeGemini(t);
  await chat(ctx, DRIVER_PHONE, 'novo');
  g.answers.push({ texto: 'Ana Lima', cliente: 'Ana Lima', retirada: '1200 Alafaya Trail, Oviedo', destino: 'Ribas Auto, Orlando', veiculo: 'Honda Civic' });
  let r = await ctx.bot.handle({ phone: DRIVER_PHONE, audio: { buffer: Buffer.from('ogg'), mime: 'audio/ogg' } });
  assert.equal(r[0], '🎤 Ouvi: "Ana Lima"');
  assert.match(g.calls[0][1].text, /cadastrando um serviço/);
  assert.match(r.at(-1), /celular|telefone/i); // cliente novo: pede o telefone dela
  [r] = await chat(ctx, DRIVER_PHONE, '4075550123');
  assert.match(r, /\*valor\*/); // retirada, destino e carro já foram respondidos sozinhos
  const data = ctx.bot.getConversation(ctx.bot.findUser(DRIVER_PHONE).id).data;
  assert.equal(data.pickup, '1200 Alafaya Trail, Oviedo');
  assert.equal(data.vehicle, 'Honda Civic');

  // Escrito também: frase comprida no meio do cadastro
  g.answers.push({ texto: '200', valor: 200 });
  [r] = await chat(ctx, DRIVER_PHONE, 'cobra 200 dolares desse cliente');
  assert.match(r, /Confere\?/);
  assert.match(r, /\$200\.00/);
});

test('Robô sem GEMINI_API_KEY: só os comandos de sempre', async (t) => {
  const ctx = makeContext();
  const g = fakeGemini(t);
  const [r] = await chat(ctx, DRIVER_PHONE, 'quanto deu hoje?');
  assert.match(r, /Não entendi/);
  const a = await ctx.bot.handle({ phone: DRIVER_PHONE, audio: { buffer: Buffer.from('x'), mime: 'audio/ogg' } });
  assert.match(a[0], /texto e fotos/);
  assert.equal(g.calls.length, 0);
});

test('Testar o robô: áudio pelo painel vai para o robô igual ao WhatsApp', async (t) => {
  const { createApp } = await import('../src/app.js');
  const { OWNER_PHONE } = await import('./helpers.js');
  const ctx = makeContext({ GEMINI_API_KEY: 'k' });
  const g = fakeGemini(t);
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const real = globalThis.fetch;
  const login = await real(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  g.answers.push({ comando: 'resumo', transcricao: 'como foi hoje' });
  const res = await real(`${base}/api/bot/simulate/audio`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'audio/wav' }, body: Buffer.alloc(2000, 1) });
  const { replies } = await res.json();
  assert.equal(replies[0], '🎤 Ouvi: "como foi hoje"');
  assert.match(replies[1], /🤖 \*resumo\*/);
  assert.equal(g.calls[0][0].inline_data.mime_type, 'audio/wav');
});
