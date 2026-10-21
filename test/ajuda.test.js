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
  assert.match(r.flat().join('\n'), /Já chamei Viviane/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, VIVIANE);
  assert.match(sent[0].text, /🆘 \*O Jay precisa de ajuda\* \(pedido #1\)\nJorge \(.*\) mandou:\n"xpto qwerty"/);
  assert.match(sent[0].text, /resolvido 1/);

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

  // Motorista não fecha; a Viviane fecha e o motorista recebe aviso.
  [r] = await chat(ctx, DRIVER_PHONE, 'resolvido 1');
  assert.match(r, /Só quem dá apoio/);
  [r] = await chat(ctx, VIVIANE, 'resolvido 1');
  assert.match(r, /Pedido #1 resolvido/);
  assert.ok(sent.some((m) => m.to === DRIVER_PHONE && /Viviane resolveu o seu pedido de ajuda \(#1\)/.test(m.text)));
  const before = sent.length;
  await runMinuteTick(ctx, new Date(t0 + 60 * 60000));
  assert.equal(sent.length, before); // resolvido: para de cobrar
});

test('socorro: qualquer um chama a Viviane na hora; sem AJUDA_TELEFONE nada muda', async () => {
  const { ctx, sent } = setup();
  const [r] = await chat(ctx, OWNER_PHONE, 'socorro não consigo lançar o serviço do Jardel');
  assert.match(r, /Já chamei Viviane/);
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
  assert.match(x, /Já chamei Viviane/);
  assert.equal(sent.at(-1).to, VIVIANE);

  const teste = await (await call('/ajuda/teste', 'POST')).json();
  assert.equal(teste.ok, true);
  assert.match(sent.at(-1).text, /Teste do pedido de ajuda/);

  // A Meta avisa pelo webhook que não entregou (fora da janela de 24 h).
  const status = { entry: [{ changes: [{ value: { statuses: [{ status: 'failed', recipient_id: VIVIANE, errors: [{ code: 131047, title: 'Re-engagement message' }] }] } }] }] };
  await fetch(`${base}/webhook/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(status) });
  assert.equal((await (await call('/ajuda/apoio')).json()).falha, 'janela');
});

test('a própria Viviane travou com o Jay: o pedido vai para o ADM, e as cobranças também', async () => {
  const { ctx, sent } = setup();
  const [r] = await chat(ctx, VIVIANE, 'xpto qwerty');
  assert.match(r, /Já chamei Caningado/);
  assert.equal(sent[0].to, OWNER_PHONE);
  await runMinuteTick(ctx, new Date(Date.now() + 3 * 60000));
  assert.equal(sent.at(-1).to, OWNER_PHONE);
  assert.match(sent.at(-1).text, /ainda aberto/);
});

test('a inteligência respondeu mas não soube resolver (duvida): chama a Viviane também', async (t) => {
  const { ctx, sent } = setup();
  ctx.config.geminiApiKey = 'chave-teste';
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  const answer = (a) => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(a) }] } }] });
  globalThis.fetch = async () => answer({ comando: '', resposta: 'Não sei fazer isso, vou pedir ajuda.', duvida: true, transcricao: 'muda a placa do caminhão no DMV' });
  const [r] = await chat(ctx, DRIVER_PHONE, 'muda a placa do caminhão no DMV');
  assert.match(r, /Não sei fazer isso/);
  assert.match(r, /Já chamei Viviane/);
  assert.match(sent[0].text, /o Jay não soube resolver/);

  globalThis.fetch = async () => answer({ comando: '', resposta: 'Bom dia, Jorge! Em que posso ajudar?', duvida: false });
  const before = sent.length;
  const [ok] = await chat(ctx, OWNER_PHONE, 'bom dia');
  assert.doesNotMatch(ok, /Já chamei/);
  assert.equal(sent.length, before);
});
