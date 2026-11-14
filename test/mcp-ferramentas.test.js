import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';

// Sobe o sistema e conecta um cliente MCP com um crachá do dono (o login em si é testado em mcp.test.js).
async function setup(t) {
  const ctx = makeContext({ GEOCODER: 'off' });
  ctx.send = async () => true;
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  ctx.config.publicUrl = base;
  const owner = ctx.bot.findUser(OWNER_PHONE);
  const token = crypto.randomBytes(16).toString('hex');
  ctx.db
    .prepare("INSERT INTO mcp_tokens (token_hash, kind, client_id, user_id, expires_at, created_at) VALUES (?, 'access', 'teste', ?, ?, ?)")
    .run(crypto.createHash('sha256').update(token).digest('hex'), owner.id, Math.floor(Date.now() / 1000) + 3600, new Date().toISOString());
  const client = new Client({ name: 'teste', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: r.content.map((c) => c.text).join('\n'), error: !!r.isError };
  };
  return { ctx, client, call, owner, driver: ctx.bot.findUser(DRIVER_PHONE) };
}

const events = (ctx, id) => ctx.db.prepare('SELECT action, source FROM service_events WHERE service_id = ? ORDER BY id').all(id).map((e) => ({ ...e }));

test('mcp ferramentas: lista tudo e não tem ferramenta de apagar', async (t) => {
  const { client } = await setup(t);
  const names = (await client.listTools()).tools.map((x) => x.name).sort();
  assert.deepEqual(names, ['apelido_cliente', 'atribuir_motorista', 'atualizar_servico', 'atualizar_status', 'buscar_cliente', 'criar_servico', 'equipe', 'listar_servicos', 'marcar_pago', 'teste', 'ver_servico']);
  assert.ok(!names.some((n) => /apagar|delete|excluir/.test(n)));
});

test('mcp ferramentas: criar serviço avisa o que falta e cria com o motorista, marcando o Claude', async (t) => {
  const { ctx, call, driver } = await setup(t);
  const falta = await call('criar_servico', { cliente_nome: 'Luan', retirada: '12 Main St, Orlando FL' });
  assert.match(falta.text, /Falta: endereço de entrega, veículo \(marca e modelo\), preço/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM services').get().n, 0);

  const r = await call('criar_servico', {
    cliente_nome: 'Luan',
    cliente_telefone: '407 555 0101',
    marca: 'Honda',
    modelo: 'Civic',
    ano: '2018',
    cor: 'preto',
    retirada: '12 Main St, Orlando FL',
    destino: '40 Oak Ave, Kissimmee FL',
    preco: 180,
    forma_pagamento: 'Zelle',
    motorista: 'Jorge',
  });
  assert.equal(r.error, false, r.text);
  const s = ctx.db.prepare('SELECT * FROM services').get();
  assert.equal(s.vehicle, '2018 Honda Civic preto');
  assert.equal(s.price_cents, 18000);
  assert.equal(s.driver_id, driver.id);
  assert.equal(s.status, 'pendente');
  assert.match(s.notes, /Pagamento combinado: Zelle/);
  assert.match(r.text, /Serviço #1 criado/);
  assert.match(r.text, /google\.com\/maps/);
  assert.deepEqual(events(ctx, s.id), [{ action: 'criado_servico', source: 'claude' }]);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM mcp_actions WHERE tool = 'criar_servico'").get().n, 1);

  // Sem motorista: fica como cotação.
  const q = await call('criar_servico', { cliente_id: s.contact_id, marca: 'Ford', modelo: 'F150', retirada: '1 A St, Orlando FL', destino: '2 B St, Orlando FL', preco: '90' });
  assert.match(q.text, /cotação/);
  // Motorista que não existe: não cria e diz quem é da equipe.
  const bad = await call('criar_servico', { cliente_id: s.contact_id, marca: 'Ford', modelo: 'F150', retirada: '3 C St', destino: '4 D St', preco: 90, motorista: 'Zé' });
  assert.equal(bad.error, true);
  assert.match(bad.text, /Não achei o motorista "Zé".*Jorge/);
});

test('mcp ferramentas: status, pagamento, VIN, motorista, ver e listar', async (t) => {
  const { ctx, call, owner, driver } = await setup(t);
  await call('criar_servico', { cliente_nome: 'Ana', cliente_telefone: '4075550199', marca: 'Toyota', modelo: 'Corolla', retirada: '5 Pine St, Orlando FL', destino: '6 Elm St, Orlando FL', preco: 150, motorista: 'Jorge' });
  const id = 1;

  // VIN com dígito verificador errado: pede confirmação; certo: salva.
  const vinBad = await call('atualizar_servico', { numero: id, vin: '1HGCM82633A004353' });
  assert.equal(vinBad.error, true);
  assert.match(vinBad.text, /dígito verificador/);
  const vinOk = await call('atualizar_servico', { numero: id, vin: '1HGCM82633A004352', placa: 'ABC1234' });
  assert.equal(vinOk.error, false, vinOk.text);
  assert.equal(ctx.data.services.get(id).vin, '1HGCM82633A004352');
  assert.equal(ctx.data.services.get(id).plate, 'ABC1234');

  // Trocar motorista: passa para o dono (eu).
  await ctx.db.prepare('UPDATE users SET drives = 1 WHERE id = ?').run(owner.id);
  assert.match((await call('atribuir_motorista', { numero: id, motorista: 'Jorge' })).text, /na fila de Jorge/);

  assert.match((await call('atualizar_status', { numero: id, acao: 'comecar' })).text, /em andamento/);
  assert.match((await call('atualizar_status', { numero: id, acao: 'peguei_o_carro' })).text, /carro pego/);
  const done = await call('atualizar_status', { numero: id, acao: 'entregue' });
  assert.equal(done.error, false, done.text);
  assert.equal(ctx.data.services.get(id).status, 'concluido');

  const pago = await call('marcar_pago', { numero: id, forma: 'zelle', confirmado_por: 'eu' });
  assert.match(pago.text, /\$150\.00 \(Zelle\).*confirmado por eu.*pago/);
  assert.equal(ctx.db.prepare('SELECT received_by FROM payments').get().received_by, driver.id);
  assert.match((await call('marcar_pago', { numero: id, forma: 'dinheiro' })).text, /não tem nada faltando/);

  const ver = await call('ver_servico', { numero: id });
  assert.match(ver.text, /Mapa da retirada: https:\/\/www\.google\.com\/maps/);
  assert.match(ver.text, /Rota: https:\/\/www\.google\.com\/maps\/dir/);
  assert.match(ver.text, /VIN: 1HGCM82633A004352/);
  assert.match(ver.text, /Empresa: Towing J&J/);
  assert.match(ver.text, /pelo Claude/);

  assert.match((await call('listar_servicos', {})).text, /Serviços de .* \(1\):\n- #1 · entregue · Ana/);
  assert.match((await call('listar_servicos', { situacao: 'pago' })).text, /#1/);
  assert.match((await call('listar_servicos', { situacao: 'nao_pago' })).text, /nenhum/);
  assert.match((await call('listar_servicos', { data: '2020-01-01' })).text, /nenhum/);

  const actions = events(ctx, id).map((e) => e.action);
  assert.deepEqual(actions, ['criado_servico', 'vin_salvo', 'editado', 'motorista', 'iniciar_servico', 'peguei_o_carro', 'finalizar_servico', 'pagamento']);
  assert.ok(events(ctx, id).every((e) => e.source === 'claude'));

  // Cancelar outro, com motivo.
  await call('criar_servico', { cliente_nome: 'Bia', marca: 'Kia', modelo: 'Soul', retirada: '7 Oak St, Orlando FL', destino: '8 Oak St, Orlando FL', preco: 80, motorista: 'Jorge' });
  assert.match((await call('atualizar_status', { numero: 2, acao: 'cancelado', motivo: 'cliente desistiu' })).text, /cancelado/);
  assert.match(ctx.data.services.get(2).notes, /Cancelado: cliente desistiu/);
});

test('mcp ferramentas: buscar cliente por nome, telefone e apelido; vários com o mesmo nome', async (t) => {
  const { ctx, call } = await setup(t);
  await call('criar_servico', { cliente_nome: 'Luan Silva', cliente_telefone: '4075550001', marca: 'Honda', modelo: 'Fit', retirada: '1 First St, Orlando FL', destino: '2 Second St, Orlando FL', preco: 100, motorista: 'Jorge' });
  ctx.data.contacts.create({ name: 'Luan Souza', phone: '4075550002' });
  const both = await call('buscar_cliente', { busca: 'luan' });
  assert.match(both.text, /2 cliente\(s\)/);
  assert.match(both.text, /Luan Silva · \+1 \(407\) 555-0001 · 1 serviço\(s\) · último carro: Honda Fit · endereços: 1 First St, Orlando FL \| 2 Second St, Orlando FL/);
  const byPhone = await call('buscar_cliente', { busca: '407-555-0002' });
  assert.match(byPhone.text, /1 cliente\(s\).*\n.*Luan Souza/);
  const souza = ctx.data.contacts.byPhone('4075550002');
  assert.match((await call('apelido_cliente', { cliente_id: souza.id, apelido: 'Luan mecânico' })).text, /gravado/);
  const byNick = await call('buscar_cliente', { busca: 'mecanico' });
  assert.match(byNick.text, /Luan Souza \("Luan mecânico"\)/);
});
