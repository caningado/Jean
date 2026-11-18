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
  assert.deepEqual(names, ['agenda', 'agendar_servico', 'anexar_foto_caixa', 'apelido_cliente', 'atribuir_motorista', 'atualizar_servico', 'atualizar_status', 'buscar_cliente', 'caixa_de_entrada', 'calcular_preco', 'criar_servico', 'equipe', 'listar_servicos', 'marcar_caixa_lida', 'marcar_pago', 'teste', 'ver_foto_caixa', 'ver_fotos_servico', 'ver_servico']);
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

test('mcp caixa de entrada: guarda cópia do que o dono manda ao Jay, o Jay responde igual, e o Claude lê', async (t) => {
  const { processMessage, extractMessages } = await import('../src/modules/whatsapp/index.js');
  const { ctx, call } = await setup(t);
  const sent = [];
  const client = { sendText: async (to, text) => sent.push({ to, text }), downloadMedia: async () => null };
  const payload = (from, m) => ({ entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: 'X' } }], messages: [{ from, ...m }] } }] }] });
  const [texto] = extractMessages(payload(OWNER_PHONE, { id: 'w1', type: 'text', text: { body: 'Pickup 12 Main St, Orlando. Honda Civic $150' } }));
  const [local] = extractMessages(payload(OWNER_PHONE, { id: 'w2', type: 'location', location: { latitude: 28.5383, longitude: -81.3792, name: 'Shell' } }));
  const [motorista] = extractMessages(payload(DRIVER_PHONE, { id: 'w3', type: 'text', text: { body: 'ajuda' } }));
  await processMessage(ctx, client, texto);
  await processMessage(ctx, client, local);
  await processMessage(ctx, client, motorista);
  await processMessage(ctx, client, texto); // repetida pela Meta: não duplica
  // O Jay só guarda o que o dono manda (um "guardei" por rajada) e não cria serviço; o motorista continua sendo atendido.
  assert.equal(sent.filter((m) => m.to === OWNER_PHONE).length, 1);
  assert.match(sent.find((m) => m.to === OWNER_PHONE).text, /Guardei na caixa de entrada/);
  assert.ok(sent.some((m) => m.to === DRIVER_PHONE));
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM services').get().n, 0);
  // Comando do dono continua indo para o Jay (e também fica na caixa).
  const [cmd] = extractMessages(payload(OWNER_PHONE, { id: 'w4', type: 'text', text: { body: 'ajuda' } }));
  await processMessage(ctx, client, cmd);
  assert.ok(sent.filter((m) => m.to === OWNER_PHONE).length > 1);
  ctx.db.prepare("DELETE FROM jay_inbox WHERE wa_id = 'w4'").run();

  const rows = ctx.db.prepare('SELECT * FROM jay_inbox ORDER BY id').all();
  assert.equal(rows.length, 2, 'só o que veio do dono, sem repetir');
  const caixa = await call('caixa_de_entrada');
  assert.match(caixa.text, /2 mensagem\(ns\)/);
  assert.match(caixa.text, /\[1\] .* texto: Pickup 12 Main St/);
  assert.match(caixa.text, /\[2\] .* localização: Shell \(28\.5383, -81\.3792\)\n    Mapa: https:\/\/www\.google\.com\/maps\?q=28\.5383,-81\.3792/);

  const s = await call('criar_servico', { cliente_nome: 'Caio', marca: 'Honda', modelo: 'Civic', retirada: '12 Main St, Orlando FL', destino: '28.5383, -81.3792', preco: 150, motorista: 'Jorge' });
  assert.equal(s.error, false, s.text);
  const id = ctx.db.prepare('SELECT MAX(id) AS id FROM services').get().id;
  assert.match((await call('marcar_caixa_lida', { ids: [1, 2], numero_servico: id })).text, /2 mensagem\(ns\) marcada/);
  assert.match((await call('caixa_de_entrada')).text, /Nada novo/);
  assert.match((await call('caixa_de_entrada', { incluir_lidas: true })).text, /já tratada \(serviço #/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM jay_inbox').get().n, 2, 'nada foi apagado');
});

test('mcp caixa de entrada: JAY_CAIXA=off deixa o Jay como antes', async () => {
  const { processMessage } = await import('../src/modules/whatsapp/index.js');
  const ctx = makeContext({ JAY_CAIXA: 'off' });
  const sent = [];
  const client = { sendText: async (to, text) => sent.push({ to, text }), downloadMedia: async () => null };
  await processMessage(ctx, client, { id: 'x1', from: OWNER_PHONE, type: 'text', text: 'oi Jay', mediaId: null });
  assert.ok(!sent.some((m) => /Guardei na caixa/.test(m.text)));
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM jay_inbox').get().n, 1, 'a cópia continua sendo guardada');
});

test('mcp caixa de entrada: foto do dono fica guardada e o Claude vê a imagem', async (t) => {
  const { processMessage } = await import('../src/modules/whatsapp/index.js');
  const { ctx, call, client: mcpClient } = await setup(t);
  const callRaw = (name, args) => mcpClient.callTool({ name, arguments: args });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const client = { sendText: async () => true, downloadMedia: async () => ({ buffer: png, mime: 'image/png' }) };
  await processMessage(ctx, client, { id: 'f1', from: OWNER_PHONE, type: 'image', text: 'carro do Luan', mediaId: 'm1' });
  const row = ctx.db.prepare("SELECT * FROM jay_inbox WHERE wa_id = 'f1'").get();
  assert.equal(row.mime, 'image/png');
  assert.match((await call('caixa_de_entrada')).text, new RegExp(`\\[${row.id}\\] .* foto: \\[foto\\] carro do Luan\\n    Foto guardada: use ver_foto_caixa com id ${row.id}`));
  const r = await call('ver_foto_caixa', { id: row.id });
  assert.equal(r.error, false);
  // O Claude recebe a imagem de verdade (não só o texto "[foto]").
  const res = await callRaw('ver_foto_caixa', { id: row.id });
  assert.deepEqual(res.content[0], { type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
  const raw = await (await import('node:fs')).promises.readFile(`${ctx.config.uploadsDir}/${row.file}`);
  assert.deepEqual(raw, png);
  assert.equal((await call('ver_foto_caixa', { id: 999 })).error, true);
});

test('mcp caixa de entrada: só a foto escolhida vai para o serviço e para o motorista', async (t) => {
  const { processMessage } = await import('../src/modules/whatsapp/index.js');
  const { ctx, call, client: mcpClient, driver } = await setup(t);
  const sentImages = [];
  ctx.sendImage = async (to, buffer, mime, caption) => sentImages.push({ to, buffer, mime, caption });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const wa = { sendText: async () => true, downloadMedia: async () => ({ buffer: png, mime: 'image/png' }) };
  await processMessage(ctx, wa, { id: 'f1', from: OWNER_PHONE, type: 'image', text: '', mediaId: 'm1' });
  await processMessage(ctx, wa, { id: 'f2', from: OWNER_PHONE, type: 'image', text: 'placa', mediaId: 'm2' });
  const ids = ctx.db.prepare('SELECT id FROM jay_inbox ORDER BY id').all().map((r) => r.id);
  const r = await call('criar_servico', { cliente_nome: 'Marcos', marca: 'Honda', modelo: 'Civic', retirada: '12 Main St, Orlando FL', destino: '40 Oak Ave, Kissimmee FL', preco: 150, motorista: 'Jorge' });
  assert.equal(r.error, false, r.text);
  const id = ctx.db.prepare('SELECT MAX(id) AS id FROM services').get().id;

  // Marcar como tratada NÃO leva foto nenhuma: só lembra o Claude de perguntar.
  const marked = await call('marcar_caixa_lida', { ids, numero_servico: id });
  assert.match(marked.text, /Tem 2 foto\(s\).*anexar_foto_caixa/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM photos').get().n, 0);

  // O dono escolhe só a foto do carro (a 2ª era a print do endereço).
  const chosen = await call('anexar_foto_caixa', { ids: [ids[0]], numero_servico: id });
  assert.match(chosen.text, /1 foto\(s\) colocada\(s\) no serviço #\d+ e mandada\(s\) para Jorge/);
  const photos = ctx.db.prepare('SELECT * FROM photos WHERE service_id = ?').all(id);
  assert.equal(photos.length, 1);
  assert.ok(photos.every((p) => p.origin === 'caixa' && p.kind === 'outro' && !p.stamped_file));
  await new Promise((r) => setImmediate(r));
  assert.equal(sentImages.length, 1);
  assert.equal(sentImages[0].to, DRIVER_PHONE);
  assert.match(sentImages[0].caption, /Foto do carro do serviço/);

  // Anexar de novo não duplica nem manda de novo.
  assert.match((await call('anexar_foto_caixa', { ids: [ids[0]], numero_servico: id })).text, /Já estava/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM photos WHERE service_id = ?').get(id).n, 1);
  assert.equal(sentImages.length, 1);

  // O motorista vê a foto no painel (detalhe do serviço).
  const detail = ctx.loaded.find((m) => m.name === 'fotos').serviceDetail({ ctx, service: ctx.data.services.get(id) });
  assert.equal(detail.photos.filter((p) => p.origin === 'caixa').length, 1);

  // O Claude vê as fotos do serviço.
  assert.match((await call('ver_servico', { numero: id })).text, /Fotos: 1 do ADM \(caixa do Jay\)/);
  const res = await mcpClient.callTool({ name: 'ver_fotos_servico', arguments: { numero: id } });
  assert.equal(res.content.filter((c) => c.type === 'image').length, 1);
  assert.match(res.content.at(-1).text, /mostrando 1 de 1/);
  assert.match((await call('ver_fotos_servico', { numero: id, tipo: 'antes' })).text, /não tem fotos desse tipo/);
  assert.ok(driver);
});

test('mcp caixa de entrada: serviço passado depois ao motorista leva as fotos junto', async (t) => {
  const { processMessage } = await import('../src/modules/whatsapp/index.js');
  const { ctx, call } = await setup(t);
  const sentImages = [];
  ctx.sendImage = async (to) => sentImages.push(to);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const wa = { sendText: async () => true, downloadMedia: async () => ({ buffer: png, mime: 'image/png' }) };
  await processMessage(ctx, wa, { id: 'f1', from: OWNER_PHONE, type: 'image', text: '', mediaId: 'm1' });
  const [row] = ctx.db.prepare('SELECT id FROM jay_inbox').all();
  const r = await call('criar_servico', { cliente_nome: 'Ana', marca: 'Kia', modelo: 'Soul', retirada: '12 Main St, Orlando FL', destino: '40 Oak Ave, Kissimmee FL', preco: 150, motorista: 'nenhum' });
  assert.equal(r.error, false, r.text);
  const id = ctx.db.prepare('SELECT MAX(id) AS id FROM services').get().id;
  assert.match((await call('anexar_foto_caixa', { ids: [row.id], numero_servico: id })).text, /quando o serviço for passado para ele/);
  assert.equal(sentImages.length, 0, 'sem motorista ainda');
  await call('atribuir_motorista', { numero: id, motorista: 'Jorge' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sentImages, [DRIVER_PHONE]);
});

test('mcp agenda: agendar ao criar, agendar depois, ver a agenda e tirar', async (t) => {
  const { ctx, call } = await setup(t);
  const r = await call('criar_servico', { cliente_nome: 'Rui', marca: 'Nissan', modelo: 'Altima', retirada: '9 Lake St, Orlando FL', destino: '10 Lake St, Orlando FL', preco: 120, motorista: 'Jorge', agendar_para: 'amanhã 9h' });
  assert.equal(r.error, false, r.text);
  assert.ok(ctx.data.services.get(1).scheduled_at);
  assert.match((await call('agenda')).text, /Agenda:\n- .*Rui/);
  assert.match((await call('agendar_servico', { numero: 1, quando: 'qualquer coisa' })).text, /Não entendi o dia\/hora/);
  assert.match((await call('agendar_servico', { numero: 1, quando: 'tirar' })).text, /tirado/);
  assert.equal(ctx.data.services.get(1).scheduled_at, null);
  assert.match((await call('agendar_servico', { numero: 1, quando: 'sexta 8am' })).text, /agendado para/);
  assert.match((await call('ver_servico', { numero: 1 })).text, /Agendado para: /);
  assert.deepEqual(events(ctx, 1).map((e) => e.action), ['criado_servico', 'agendado', 'agendado']);
});
