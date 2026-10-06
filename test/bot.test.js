import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, chat, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';

test('número fora da equipe recebe aviso', async () => {
  const ctx = makeContext();
  const [reply] = await chat(ctx, '15085559999', 'oi');
  assert.match(reply, /não está cadastrado/);
});

test('motorista registra um serviço completo pelo robô', async () => {
  const ctx = makeContext();
  const replies = await chat(
    ctx,
    DRIVER_PHONE,
    'novo',
    '(508) 555-0123',
    '12 Main St, Framingham',
    'pular',
    'Honda Civic ABC1234',
    '10',
    'ok'
  );
  assert.match(replies[0], /telefone/);
  assert.match(replies[6], /Serviço #1 criado/);
  assert.match(replies[6], /\$115\.00/); // 75 + 10 milhas x 4

  const service = ctx.data.services.get(1);
  assert.equal(service.contact_phone, '15085550123');
  assert.equal(service.pickup, '12 Main St, Framingham');
  assert.equal(service.dropoff, null);
  assert.equal(service.vehicle, 'Honda Civic');
  assert.equal(service.plate, 'ABC1234');
  assert.equal(service.price_cents, 11500);

  const [paid] = await chat(ctx, DRIVER_PHONE, 'pago 100 zelle');
  assert.match(paid, /\$100\.00 recebido por Zelle/);
  assert.match(paid, /falta \$15\.00/);

  const [charge] = await chat(ctx, DRIVER_PHONE, 'cobrar');
  assert.match(charge, /\$15\.00/);
  assert.match(charge, /Zelle to Towing J&J \(\(508\) 555-0100\)/);

  const [done] = await chat(ctx, DRIVER_PHONE, 'entregue');
  assert.match(done, /entregue/);
  assert.match(done, /Falta receber \$15\.00/);
  assert.equal(ctx.data.services.get(1).status, 'concluido');

  const [none] = await chat(ctx, DRIVER_PHONE, 'pago 15 dinheiro');
  assert.match(none, /Nenhum serviço em andamento/);
});

test('cliente pelo nome, erro de valor e cancelar', async () => {
  const ctx = makeContext({ PRICE_BASE: '0', PRICE_PER_MILE: '0' });
  ctx.data.contacts.create({ name: 'Maria Souza', phone: '5085550144' });
  const replies = await chat(ctx, DRIVER_PHONE, 'novo', 'maria', 'Rua A', 'Rua B', 'pular', 'pular', 'abc');
  assert.match(replies[1], /retirada|pegar/);
  assert.match(replies[6], /Não entendi o valor/);
  const [cancel] = await chat(ctx, DRIVER_PHONE, 'cancelar');
  assert.match(cancel, /cancelado/);
  assert.equal(ctx.data.services.list().length, 0);
});

test('seguradora fica a receber e despesas entram no resumo', async () => {
  const ctx = makeContext();
  await chat(ctx, DRIVER_PHONE, 'novo', '5085550123', 'I-95 exit 12', 'Shop', 'pular', 'pular', '200');
  const [aaa] = await chat(ctx, DRIVER_PHONE, 'pago 200 aaa');
  assert.match(aaa, /a receber de AAA/);
  await chat(ctx, DRIVER_PHONE, 'gasto 80 diesel', 'gasto $12.50 pedágio');

  const [driverSummary] = await chat(ctx, DRIVER_PHONE, 'resumo');
  assert.match(driverSummary, /Serviços: 1/);
  assert.match(driverSummary, /Despesas: \$92\.50/);
  assert.match(driverSummary, /Combustível: \$80\.00/);
  assert.match(driverSummary, /A receber de seguradoras: \$200\.00/);

  const [ownerSummary] = await chat(ctx, OWNER_PHONE, 'resumo mes');
  assert.match(ownerSummary, /Resumo do mês \(empresa\)/);
  assert.match(ownerSummary, /Faturado: \$200\.00/);
});

test('fotos sem legenda perguntam o tipo e as seguintes seguem o mesmo tipo', async () => {
  const ctx = makeContext();
  await chat(ctx, DRIVER_PHONE, 'novo', '5085550123', 'Rua A', 'pular', 'pular', 'pular', 'pular');
  const media = { buffer: Buffer.from([0xff, 0xd8, 0xff]), mime: 'image/jpeg' };

  const [first] = await ctx.bot.handle({ phone: DRIVER_PHONE, text: '', media });
  assert.match(first, /Ela é de quê/);
  const [answer] = await chat(ctx, DRIVER_PHONE, '1');
  assert.match(answer, /1 foto de \*antes\*/);

  const [second] = await ctx.bot.handle({ phone: DRIVER_PHONE, text: '', media });
  assert.match(second, /Foto de \*antes\* salva.*2 no total/);

  const [third] = await ctx.bot.handle({ phone: DRIVER_PHONE, text: 'depois', media });
  assert.match(third, /Foto de \*depois\*/);

  // Sem chave do Claude, a foto do VIN é guardada e o robô pede o número.
  const [vin] = await ctx.bot.handle({ phone: DRIVER_PHONE, text: 'vin', media });
  assert.match(vin, /Foto do VIN guardada/);

  const kinds = ctx.db.prepare('SELECT kind, COUNT(*) AS n FROM photos GROUP BY kind ORDER BY kind').all();
  assert.deepEqual(kinds.map((k) => [k.kind, k.n]), [['antes', 2], ['depois', 1], ['vin', 1]]);
});

test('ajuda lista os comandos dos módulos ligados', async () => {
  const ctx = makeContext({ MODULES: 'despesas' });
  const [help] = await chat(ctx, DRIVER_PHONE, 'ajuda');
  assert.match(help, /gasto/);
  assert.doesNotMatch(help, /pago/);
  const [unknown] = await chat(ctx, DRIVER_PHONE, 'pago 10 zelle');
  assert.match(unknown, /Não entendi/);
});
