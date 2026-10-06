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
    'Maria Souza',
    '12 Main St, Framingham',
    'pular',
    'Honda Civic ABC1234',
    '10',
    'ok',
    'sim'
  );
  assert.match(replies[0], /telefone/);
  assert.match(replies[1], /Qual o \*nome\* dele/);
  assert.match(replies[7], /Confere\?/);
  assert.match(replies[7], /Maria Souza \+1 \(508\) 555-0123 \(novo\)/);
  assert.match(replies[8], /Serviço #1 criado/);
  assert.match(replies[8], /\$115\.00/); // 75 + 10 milhas x 4

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
  const replies = await chat(ctx, DRIVER_PHONE, 'novo', 'maria', 'Rua Alfa 10', 'Rua Beta 20', 'pular', 'pular', 'abc');
  assert.match(replies[1], /retirada|pegar/);
  assert.match(replies[6], /Mande só o valor/);
  const [cancel] = await chat(ctx, DRIVER_PHONE, 'cancelar');
  assert.match(cancel, /cancelado/);
  assert.equal(ctx.data.services.list().length, 0);
  assert.equal(ctx.data.contacts.search('').length, 1); // cancelar não cria contato
});

test('seguradora fica a receber e despesas entram no resumo', async () => {
  const ctx = makeContext();
  await chat(ctx, DRIVER_PHONE, 'novo', '5085550123', 'John Smith', 'I-95 exit 12', 'Joe Shop', 'pular', 'pular', '200', 'sim');
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
  await chat(ctx, DRIVER_PHONE, 'novo', '5085550123', 'John Smith', 'Rua Alfa', 'pular', 'pular', 'pular', 'pular', 'sim');
  const media = { buffer: Buffer.from([0xff, 0xd8, 0xff]), mime: 'image/jpeg' };

  const [first] = await ctx.bot.handle({ phone: DRIVER_PHONE, text: '', media });
  assert.match(first, /Ela é de quê/);
  const [answer] = await chat(ctx, DRIVER_PHONE, '1');
  assert.match(answer, /1 foto de \*antes\*/);

  const [second] = await ctx.bot.handle({ phone: DRIVER_PHONE, text: '', media });
  assert.match(second, /Foto de \*antes\* \(lateral esquerda \(motorista\)\) salva.*2 no total/);
  assert.match(second, /Próxima: \*traseira\*/);

  const [third] = await ctx.bot.handle({ phone: DRIVER_PHONE, text: 'depois', media });
  assert.match(third, /Foto de \*depois\*/);

  // Sem chave do Claude, a foto do VIN é guardada e o robô pede o número.
  const [vin] = await ctx.bot.handle({ phone: DRIVER_PHONE, text: 'vin', media });
  assert.match(vin, /Foto do VIN guardada/);

  const kinds = ctx.db.prepare('SELECT kind, COUNT(*) AS n FROM photos GROUP BY kind ORDER BY kind').all();
  assert.deepEqual(kinds.map((k) => [k.kind, k.n]), [['antes', 2], ['depois', 1], ['vin', 1]]);
  const angles = ctx.db.prepare('SELECT kind, angle FROM photos ORDER BY id').all().map((p) => `${p.kind}:${p.angle}`);
  assert.deepEqual(angles, ['antes:frente', 'antes:lateral_esquerda', 'depois:frente', 'vin:null']);
});

test('fotos da volta no carro: ordem, legenda com o lado e detalhe', async () => {
  const ctx = makeContext();
  await chat(ctx, DRIVER_PHONE, 'novo', '5085550123', 'John Smith', 'Rua Alfa', 'pular', 'pular', 'pular', 'pular', 'sim');
  const media = { buffer: Buffer.from([0xff, 0xd8, 0xff]), mime: 'image/jpeg' };
  const [start] = await chat(ctx, DRIVER_PHONE, 'antes');
  assert.match(start, /1\. frente\n2\. lateral esquerda \(motorista\)\n3\. traseira\n4\. lateral direita/);
  const send = async (caption = '') => (await ctx.bot.handle({ phone: DRIVER_PHONE, text: caption, media }))[0];
  assert.match(await send('traseira'), /\(traseira\).*Próxima: \*frente\*/);
  await send();
  await send();
  const fourth = await send();
  assert.match(fourth, /\(lateral direita \(passageiro\)\).*Volta completa/);
  assert.match(await send(), /\(detalhe \/ dano\)/);
  const angles = ctx.db.prepare('SELECT angle FROM photos ORDER BY id').all().map((p) => p.angle);
  assert.deepEqual(angles, ['traseira', 'frente', 'lateral_esquerda', 'lateral_direita', 'detalhe']);
});

test('ajuda lista os comandos dos módulos ligados', async () => {
  const ctx = makeContext({ MODULES: 'despesas' });
  const [help] = await chat(ctx, DRIVER_PHONE, 'ajuda');
  assert.match(help, /gasto/);
  assert.doesNotMatch(help, /pago/);
  const [unknown] = await chat(ctx, DRIVER_PHONE, 'pago 10 zelle');
  assert.match(unknown, /Não entendi/);
});

test('o robô recusa respostas sem sentido e repete a pergunta', async () => {
  const ctx = makeContext({ PRICE_BASE: '0', PRICE_PER_MILE: '0' });
  const r = await chat(
    ctx,
    DRIVER_PHONE,
    'novo',
    '23', // nome sem letras
    '508 555', // telefone incompleto
    'Carlos Lima',
    '123', // telefone do cliente novo inválido
    '5085550199',
    '12', // endereço sem letras
    'ajuda', // comando no meio do cadastro
    '45 Elm St, Worcester',
    'x',
    'pular',
    'x',
    'Ford F150',
    '-5',
    '20000 milhas',
    '15',
    '99999',
    '0',
    '180',
    'talvez',
    'sim'
  );
  assert.match(r[1], /O nome do cliente precisa ter letras/);
  assert.match(r[1], /telefone\* ou o \*nome/); // repete a pergunta
  assert.match(r[2], /Telefone inválido/);
  assert.match(r[3], /Cliente novo: \*Carlos Lima\*/);
  assert.match(r[4], /Telefone inválido/);
  assert.match(r[6], /local de retirada parece incompleto/);
  assert.match(r[7], /no meio do cadastro/);
  assert.match(r[9], /O destino parece incompleto/);
  assert.match(r[11], /marca e o modelo/);
  assert.match(r[13], /Milhas inválidas/);
  assert.match(r[14], /Milhas inválidas/);
  assert.match(r[16], /alto demais/);
  assert.match(r[17], /maior que zero/);
  assert.match(r[18], /Confere\?/);
  assert.match(r[19], /Mande \*sim\* para salvar/);
  assert.match(r[20], /Serviço #1 criado/);

  const s = ctx.data.services.get(1);
  assert.equal(s.contact_name, 'Carlos Lima');
  assert.equal(s.contact_phone, '15085550199');
  assert.equal(s.dropoff, null);
  assert.equal(s.vehicle, 'Ford F150');
  assert.equal(s.miles, 15);
  assert.equal(s.price_cents, 18000);

  const [tooMuch] = await chat(ctx, DRIVER_PHONE, 'pago 900000 zelle');
  assert.match(tooMuch, /alto demais/);
  const [expense] = await chat(ctx, DRIVER_PHONE, 'gasto 0 diesel');
  assert.match(expense, /Faltou o valor|maior que zero/);
});

test('duas Marias: o robô pergunta qual é', async () => {
  const ctx = makeContext({ PRICE_BASE: '0', PRICE_PER_MILE: '0' });
  ctx.data.contacts.create({ name: 'Maria Souza', phone: '5085550144' });
  ctx.data.contacts.create({ name: 'Maria Lima', phone: '5085550155' });
  const r = await chat(ctx, DRIVER_PHONE, 'novo', 'maria', '7', '2', '12 Main St', 'pular', 'pular', 'pular', 'pular', 'sim');
  assert.match(r[1], /mais de um cliente/);
  assert.match(r[1], /\*1\* Maria Lima/);
  assert.match(r[1], /\*2\* Maria Souza/);
  assert.match(r[2], /número de 0 a 2/);
  assert.match(r[3], /pegar/);
  assert.equal(ctx.data.services.get(1).contact_name, 'Maria Souza');

  // 0 = cliente novo com o mesmo nome
  const n = await chat(ctx, DRIVER_PHONE, 'novo', 'Maria', '0', '5085550166', '1 Oak St', 'pular', 'pular', 'pular', 'pular', 'sim');
  assert.match(n[2], /Cliente novo: \*Maria\*/);
  assert.equal(ctx.data.services.get(2).contact_phone, '15085550166');
  assert.equal(ctx.data.contacts.search('maria').length, 3);
});

test('destino pode ser link do mapa ou localização do WhatsApp', async () => {
  const ctx = makeContext({ PRICE_BASE: '0', PRICE_PER_MILE: '0' });
  const r = await chat(
    ctx,
    DRIVER_PHONE,
    'novo',
    'John Smith',
    'pular',
    '(42.3601, -71.0589)',
    'Oficina do Joe https://maps.app.goo.gl/AbC123xyz',
    'pular',
    'pular',
    'pular',
    'sim'
  );
  assert.match(r[3], /link do mapa/);
  assert.match(r[8], /Serviço #1 criado/);
  assert.match(r[8], /🗺️ https:\/\/www\.google\.com\/maps\?q=42\.3601,-71\.0589/);
  assert.match(r[8], /🗺️ https:\/\/maps\.app\.goo\.gl\/AbC123xyz/);
  assert.equal(ctx.data.services.get(1).dropoff, 'Oficina do Joe https://maps.app.goo.gl/AbC123xyz');
});
