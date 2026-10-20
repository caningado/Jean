import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, chat, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';
import { hashPin } from '../src/lib/auth.js';
import { runMinuteTick } from '../src/lib/daily.js';

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
  assert.match(r.flat().join('\n'), /Já chamei a Viviane/);
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
  assert.match(r, /Já chamei a Viviane/);
  assert.match(sent[0].text, /Caningado .* mandou:\n"não consigo lançar o serviço do Jardel"/);

  const plain = makeContext();
  const [x] = await chat(plain, DRIVER_PHONE, 'xpto qwerty');
  assert.equal(x, 'Não entendi. Mande *ajuda* para ver os comandos.');
});
