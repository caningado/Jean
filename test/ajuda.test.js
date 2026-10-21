import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, chat, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';
import { hashPin } from '../src/lib/auth.js';
import { runMinuteTick } from '../src/lib/daily.js';
import { createApp } from '../src/app.js';

const VIVIANE = '14073691819';

function setup() {
  const ctx = makeContext({ AJUDA_TELEFONE: '+1 (407) 369-1819' });
  ctx.db.prepare("INSERT INTO users (name, phone, role, pin_hash, created_at) VALUES ('Viviane', ?, 'dono', ?, ?)").run(VIVIANE, hashPin('9999'), new Date().toISOString());
  const sent = [];
  ctx.send = async (to, text) => sent.push({ to, text });
  return { ctx, sent };
}

test('Jay não entendeu: chama a Viviane, junta as mensagens seguidas e cobra até ela mandar resolvido', async () => {
  const { ctx, sent } = setup();
  let r = await chat(ctx, DRIVER_PHONE, 'xpto qwerty');
  assert.match(r.flat().join('\n'), /Passei para Viviane resolver/);
  assert.doesNotMatch(r.flat().join('\n'), /Não entendi|explicar de outro jeito/); // o motorista não precisa ajudar
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, VIVIANE);
  assert.match(sent[0].text, /🆘 \*O Jay precisa de ajuda\* \(pedido #1\)\nJorge \(.*\) mandou:\n"xpto qwerty"/);
  assert.match(sent[0].text, /Me responda aqui/); // o Jay já abre a conversa com ela

  // Outra mensagem logo depois entra no mesmo pedido.
  await chat(ctx, DRIVER_PHONE, 'zzz www');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM help_requests').get().n, 1);
  assert.match(sent[1].text, /Mais sobre o pedido de ajuda \*#1\*/);

  // Cobrança: antes de 2 min não manda; depois manda a cada 2 min.
  const t0 = Date.now();
  await runMinuteTick(ctx, new Date(t0 + 60000));
  assert.equal(sent.length, 2);
  await runMinuteTick(ctx, new Date(t0 + 2 * 60000 + 5000));
  assert.equal(sent.length, 3);
  assert.match(sent[2].text, /⏰ \*Pedido de ajuda #1 ainda aberto\*/);
  assert.match(sent[2].text, /"xpto qwerty\nzzz www"/);
  await runMinuteTick(ctx, new Date(t0 + 3 * 60000 + 5000));
  assert.equal(sent.length, 3); // só 2 min depois da última cobrança
  await runMinuteTick(ctx, new Date(t0 + 4 * 60000 + 5000));
  assert.equal(sent.length, 4);

  // Motorista não fecha.
  [r] = await chat(ctx, DRIVER_PHONE, 'resolvido 1');
  assert.match(r, /Só quem dá apoio/);
  // A Viviane responde do jeito dela; o Jay confirma antes de passar.
  [r] = await chat(ctx, VIVIANE, 'Ele queria saber o horário da oficina, abre às 8h');
  assert.match(r, /Vou mandar para Jorge:\n"Ele queria saber o horário da oficina, abre às 8h"/);
  [r] = await chat(ctx, VIVIANE, 'A oficina abre às 8h, pode levar o carro');
  assert.match(r, /Vou mandar para Jorge:\n"A oficina abre às 8h, pode levar o carro"/);
  assert.equal(ctx.db.prepare('SELECT resolved_at FROM help_requests WHERE id = 1').get().resolved_at, null);
  [r] = await chat(ctx, VIVIANE, 'sim');
  assert.match(r, /Pedido #1 resolvido. Passei a solução para Jorge/);
  const sol = sent.find((m) => m.to === DRIVER_PHONE && /Resolvido/.test(m.text));
  assert.match(sol.text, /✅ \*Resolvido\* \(sobre "xpto qwerty…"\):\nA oficina abre às 8h, pode levar o carro/);
  const before = sent.length;
  await runMinuteTick(ctx, new Date(t0 + 60 * 60000));
  assert.equal(sent.length, before); // resolvido: para de cobrar
});

test('Viviane ocupada em outra conversa: usa *resolvido N solução*; sem solução não fecha', async () => {
  const { ctx, sent } = setup();
  const vivi = ctx.bot.findUser(VIVIANE);
  await ctx.bot.startFlow(vivi, 'ajuda_resposta', { reqId: 999 }); // ocupada
  await chat(ctx, DRIVER_PHONE, 'xpto qwerty');
  assert.match(sent[0].text, /mande \*resolvido 1\* e a solução/);
  ctx.bot.clearConversation(vivi.id);
  let [r] = await chat(ctx, VIVIANE, 'resolvido 1');
  assert.match(r, /o que foi feito/);
  [r] = await chat(ctx, VIVIANE, 'resolvido 1 cadastrei o serviço do João');
  assert.match(r, /Pedido #1 resolvido/);
  assert.match(sent.at(-1).text, /cadastrei o serviço do João/);
});

test('resposta da Viviane com cara de serviço: o Jay abre o serviço novo para o motorista, no padrão', async () => {
  const { ctx, sent } = setup();
  await chat(ctx, DRIVER_PHONE, 'xpto qwerty');
  let [r] = await chat(ctx, VIVIANE, 'Pegar: 1200 N Alafaya Trail, Orlando FL\nDeixar: 500 E Colonial Dr, Orlando FL\nHonda Civic\n$160\nContato do cliente: Maria 4075551234');
  assert.match(r, /Vou abrir um \*serviço novo\* para Jorge/);
  [r] = await chat(ctx, VIVIANE, 'sim');
  assert.match(r, /Abri o serviço novo para Jorge/);
  const msg = sent.find((m) => m.to === DRIVER_PHONE && /Resolvido/.test(m.text));
  assert.match(msg.text, /Serviço #1 criado/);
  const s = ctx.db.prepare('SELECT * FROM services').get();
  assert.match(s.pickup, /^1200 N Alafaya Trail/);
  assert.match(s.dropoff, /^500 E Colonial Dr/);
  assert.equal(s.price_cents, 16000);
  assert.equal(ctx.bot.getConversation(ctx.bot.findUser(DRIVER_PHONE).id), null); // o motorista não precisa responder nada
});

test('faltou algo no serviço da Viviane: o Jay pergunta de novo para ela, não para o motorista', async () => {
  const { ctx, sent } = setup();
  await chat(ctx, DRIVER_PHONE, 'xpto qwerty');
  const before = sent.filter((m) => m.to === DRIVER_PHONE).length;
  // Sem o cliente: o cadastro precisa de quem é o cliente.
  await chat(ctx, VIVIANE, 'Pegar: 1200 N Alafaya Trail, Orlando FL\nDeixar: 500 E Colonial Dr, Orlando FL');
  const [r] = await chat(ctx, VIVIANE, 'sim');
  assert.match(r, /Não consegui abrir o serviço ainda/);
  assert.match(r, /me mande o serviço completo de novo/);
  assert.equal(sent.filter((m) => m.to === DRIVER_PHONE).length, before); // nada para o motorista
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM services').get().n, 0);
  assert.equal(ctx.db.prepare('SELECT resolved_at FROM help_requests WHERE id = 1').get().resolved_at, null);
  assert.equal(ctx.bot.getConversation(ctx.bot.findUser(VIVIANE).id)?.flow, 'ajuda_resposta');
});

test('socorro: qualquer um chama a Viviane na hora; sem AJUDA_TELEFONE nada muda', async () => {
  const { ctx, sent } = setup();
  const [r] = await chat(ctx, OWNER_PHONE, 'socorro não consigo lançar o serviço do Jardel');
  assert.match(r, /Passei para Viviane resolver/);
  assert.match(sent[0].text, /Caningado .* mandou:\n"não consigo lançar o serviço do Jardel"/);

  const plain = makeContext();
  const [x] = await chat(plain, DRIVER_PHONE, 'xpto qwerty');
  assert.equal(x, 'Não entendi. Mande *ajuda* para ver os comandos.');
});

test('painel: ADM escolhe quem ajuda (sem AJUDA_TELEFONE), testa e vê quando a Meta não entregou', async (t) => {
  const ctx = makeContext();
  const vivi = ctx.db.prepare("INSERT INTO users (name, phone, role, created_at) VALUES ('Viviane', ?, 'dono', ?)").run(VIVIANE, new Date().toISOString());
  const sent = [];
  ctx.send = async (to, text) => sent.push({ to, text });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone, pin) => (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers.get('set-cookie').split(';')[0];
  const owner = await login(OWNER_PHONE, '1234');
  const call = (path, method = 'GET', body, cookie = owner) =>
    fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });

  assert.equal((await (await call('/ajuda/apoio')).json()).user_id, null);
  assert.equal((await call('/ajuda/apoio', 'PUT', { user_id: 2 }, await login(DRIVER_PHONE, '5678'))).status, 403);
  const r = await (await call('/ajuda/apoio', 'PUT', { user_id: Number(vivi.lastInsertRowid) })).json();
  assert.equal(r.name, 'Viviane');

  // Agora o Jay chama a Viviane mesmo sem AJUDA_TELEFONE.
  const [x] = await chat(ctx, DRIVER_PHONE, 'xpto qwerty');
  assert.match(x, /Passei para Viviane resolver/);
  assert.equal(sent.at(-1).to, VIVIANE);

  const teste = await (await call('/ajuda/teste', 'POST')).json();
  assert.equal(teste.ok, true);
  assert.match(sent.at(-1).text, /Teste do pedido de ajuda/);

  // A Meta avisa pelo webhook que não entregou (fora da janela de 24 h).
  const status = { entry: [{ changes: [{ value: { statuses: [{ status: 'failed', recipient_id: VIVIANE, errors: [{ code: 131047, title: 'Re-engagement message' }] }] } }] }] };
  await fetch(`${base}/webhook/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(status) });
  assert.equal((await (await call('/ajuda/apoio')).json()).falha, 'janela');
});

test('a própria Viviane travou com o Jay: ninguém é chamado (o ADM não ajuda, só recebe solução)', async () => {
  const { ctx, sent } = setup();
  const [r] = await chat(ctx, VIVIANE, 'xpto qwerty');
  assert.match(r, /Não entendi/);
  assert.equal(sent.length, 0);
});

test('a inteligência respondeu mas não soube resolver (duvida): chama a Viviane também', async (t) => {
  const { ctx, sent } = setup();
  ctx.config.geminiApiKey = 'chave-teste';
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  const answer = (a) => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(a) }] } }] });
  globalThis.fetch = async () => answer({ comando: '', resposta: 'Não sei fazer isso, vou pedir ajuda.', duvida: true, transcricao: 'muda a placa do caminhão no DMV' });
  const [r] = await chat(ctx, DRIVER_PHONE, 'muda a placa do caminhão no DMV');
  assert.doesNotMatch(r, /Não sei fazer isso/); // não pergunta nada ao motorista
  assert.match(r, /Passei para Viviane resolver/);
  assert.match(sent[0].text, /o Jay não soube resolver/);

  globalThis.fetch = async () => answer({ comando: '', resposta: 'Bom dia, Jorge! Em que posso ajudar?', duvida: false });
  const before = sent.length;
  const [ok] = await chat(ctx, OWNER_PHONE, 'bom dia');
  assert.doesNotMatch(ok, /Passei para/);
  assert.equal(sent.length, before);
});
