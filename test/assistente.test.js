import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';

test('Assistente de voz: entende o pedido em qualquer tela e diz ao app o que fazer', async (t) => {
  const ctx = makeContext({ GEMINI_API_KEY: 'chave-teste' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  const answers = [];
  const prompts = [];
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('generativelanguage.googleapis.com')) return realFetch(url, opts);
    prompts.push(JSON.parse(opts.body).contents[0].parts[1].text);
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answers.shift()) }] } }] });
  };
  const login = async (phone, pin) =>
    (await realFetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers.get('set-cookie').split(';')[0];
  const adm = await login(OWNER_PHONE, '1234');
  const drv = await login(DRIVER_PHONE, '5678');
  const call = async (cookie, method, path, body) => {
    const res = await realFetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const json = async (...args) => (await call(...args)).body;
  const speak = async (cookie, answer, query = '') => {
    answers.push(answer);
    const res = await realFetch(`${base}/api/voice-command/assistente${query}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'audio/wav' }, body: Buffer.alloc(2000, 1) });
    return { status: res.status, body: await res.json() };
  };
  const jorge = ctx.db.prepare('SELECT id FROM users WHERE phone = ?').get(DRIVER_PHONE).id;

  // Abrir telas
  let r = await speak(drv, { intencao: 'abrir_tela', tela: 'despesas', transcricao: 'abre as despesas' });
  assert.equal(r.body.hash, '#/despesas');
  r = await speak(drv, { intencao: 'abrir_tela', tela: 'ganhos' });
  assert.equal(r.body.hash, `#/motorista/${jorge}`);
  r = await speak(adm, { intencao: 'abrir_tela', tela: 'clientes', busca: 'João Silva' });
  assert.equal(r.body.hash, '#/contatos?q=Jo%C3%A3o%20Silva');
  // Tela só do ADM: o motorista não abre
  r = await speak(drv, { intencao: 'abrir_tela', tela: 'equipe' });
  assert.equal(r.body.intencao, 'nao_entendi');
  assert.match(r.body.mensagem, /só para o ADM/);
  assert.match(prompts[0], /o motorista Jorge/);

  // Serviço novo: devolve os campos para preencher (não cria sozinho)
  r = await speak(adm, { intencao: 'servico_novo', cliente: 'Ana Lima', retirada: '1 Main St, Oviedo', distancia: 12, valor: 150, motorista: 'jorge' });
  assert.equal(r.body.campos.contact_name, 'Ana Lima');
  assert.equal(r.body.campos.miles, 12);
  assert.equal(r.body.campos.price, 150);
  assert.equal(r.body.campos.driver_id, jorge);
  assert.equal((await json(adm, 'GET', '/services?status=')).length, 0);
  // Conversa: a resposta é do campo que o app perguntou
  r = await speak(adm, { intencao: 'servico_novo', destino: 'Ribas Auto' }, '?pergunta=destino');
  assert.equal(r.body.campos.dropoff, 'Ribas Auto');
  assert.match(prompts.at(-1), /acabou de perguntar: "Para onde levar\?"/);
  r = await speak(adm, { intencao: 'pular' }, '?pergunta=valor');
  assert.equal(r.body.intencao, 'pular');

  // Situação do serviço: sem serviço, avisa; com serviço na fila dele, muda na hora
  r = await speak(drv, { intencao: 'status_servico', acao: 'peguei_o_carro' });
  assert.equal(r.status, 409);
  const s = await json(adm, 'POST', '/services', { contact_name: 'Ana Lima', pickup: '1 Main St, Oviedo FL', price: '150', driver_id: jorge });
  r = await speak(drv, { intencao: 'status_servico', acao: 'peguei_o_carro' });
  assert.equal(r.body.service_id, s.id);
  assert.equal(r.body.service.status, 'aberto');
  assert.equal(r.body.service.stage, 'coletado');
  assert.match(prompts.at(-1), new RegExp(`Serviço atual: #${s.id}`));
  r = await speak(drv, { intencao: 'status_servico', acao: 'cancelar_servico' });
  assert.equal(r.body.confirmar, true);
  assert.equal((await json(drv, 'GET', `/services/${s.id}`)).status, 'aberto');

  // Pagamento: devolve o serviço e os campos para conferir
  r = await speak(drv, { intencao: 'pagamento', valor: 150, forma: 'zelle' });
  assert.deepEqual(r.body.campos, { amount: 150, method: 'zelle', payer: '' });
  assert.equal(r.body.service_id, s.id);
  assert.equal((await json(drv, 'GET', `/services/${s.id}`)).payments.length, 0);

  // Despesa com as milhas do caminhão (depois de abastecer)
  const truck = await json(adm, 'POST', '/trucks', { name: 'F-550', odometer: 120000, driver_id: jorge });
  r = await speak(drv, { intencao: 'despesa', valor: 80.5, categoria: 'combustivel', descricao: 'diesel', odometro: 123400.4 });
  assert.deepEqual(r.body.campos, { amount: 80.5, category: 'combustivel', description: 'diesel', odometer: 123400, truck_id: null });
  // Diesel com caminhão cadastrado só entra pela tela Abastecer (foto do painel obrigatória).
  const fuel = await call(drv, 'POST', '/expenses', { amount: '80.50', category: 'combustivel', description: 'diesel', odometer: 123400 });
  assert.equal(fuel.status, 400);
  assert.match(fuel.body.error, /Abastecer/);
  // Outra despesa com as milhas: grava a despesa e as milhas
  const e = await call(drv, 'POST', '/expenses', { amount: '80.50', category: 'manutencao', description: 'filtro', odometer: 123400 });
  assert.equal(e.status, 201);
  assert.equal(e.body.truck_id, truck.id);
  assert.equal(ctx.api.manutencao.get(truck.id).odometer, 123400);
  // Milhas menores que as do painel: o motorista não pode, e a despesa não entra
  const bad = await call(drv, 'POST', '/expenses', { amount: '20', category: 'manutencao', odometer: 1000 });
  assert.equal(bad.status, 400);
  assert.equal((await json(drv, 'GET', '/expenses')).length, 1);

  // Só as milhas: devolve o caminhão para o app confirmar
  r = await speak(drv, { intencao: 'milhas_caminhao', odometro: 124000, caminhao: 'f550' });
  assert.equal(r.body.truck_id, truck.id);
  assert.equal(r.body.odometer, 124000);
  assert.equal(ctx.api.manutencao.get(truck.id).odometer, 123400);

  // Intenção desconhecida
  r = await speak(drv, { intencao: 'voar' });
  assert.equal(r.body.intencao, 'nao_entendi');
});
