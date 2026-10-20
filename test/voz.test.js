import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';

test('Comando de voz: o Gemini diz a ação e o serviço muda, com quem fez e a hora', async (t) => {
  const ctx = makeContext({ GEMINI_API_KEY: 'chave-teste' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  // O Gemini de mentira responde a próxima ação da fila; o resto da internet passa direto.
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  const answers = [];
  const geminiCalls = [];
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('generativelanguage.googleapis.com')) return realFetch(url, opts);
    geminiCalls.push({ url: String(url), body: JSON.parse(opts.body), key: opts.headers['x-goog-api-key'] });
    const next = answers.shift();
    if (next === 500) return new Response('erro', { status: 500 });
    return Response.json({ candidates: [{ content: { parts: [{ text: next }] } }] });
  };

  const login = async (phone, pin) =>
    (await realFetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers
      .get('set-cookie')
      .split(';')[0];
  const adm = await login(OWNER_PHONE, '1234');
  const drv = await login(DRIVER_PHONE, '5678');
  const json = async (cookie, method, path, body) =>
    (await realFetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })).json();
  const audio = Buffer.alloc(2000, 1);
  const speak = (cookie, id, acao, type = 'audio/webm;codecs=opus') => {
    answers.push(typeof acao === 'string' && !acao.startsWith('{') ? JSON.stringify({ acao, transcricao: `fala ${acao}` }) : acao);
    return realFetch(`${base}/api/voice-command?servico=${id}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': type }, body: audio });
  };
  const jorge = ctx.db.prepare('SELECT id FROM users WHERE phone = ?').get(DRIVER_PHONE).id;

  assert.deepEqual(await json(drv, 'GET', '/voice-command'), { enabled: true });
  const s = await json(adm, 'POST', '/services', { contact_name: 'Ana Lima', pickup: '1 Main St, Oviedo FL', driver_id: jorge });
  assert.equal(s.status, 'pendente');

  // Começar
  let r = await (await speak(drv, s.id, 'iniciar_servico')).json();
  assert.equal(r.acao, 'iniciar_servico');
  assert.equal(r.service.status, 'aberto');
  assert.equal(geminiCalls[0].key, 'chave-teste');
  assert.match(geminiCalls[0].url, /gemini-flash-lite-latest:generateContent$/);
  assert.equal(geminiCalls[0].body.contents[0].parts[0].inline_data.mime_type, 'audio/webm');
  assert.equal(geminiCalls[0].body.generationConfig.responseMimeType, 'application/json');

  // Peguei o carro / indo entregar: etapa, e o motorista continua em andamento
  r = await (await speak(drv, s.id, 'peguei_o_carro', 'audio/mp4')).json();
  assert.equal(r.service.stage, 'coletado');
  assert.equal(geminiCalls[1].body.contents[0].parts[0].inline_data.mime_type, 'audio/mp4');
  r = await (await speak(drv, s.id, 'indo_entregar')).json();
  assert.equal(r.service.stage, 'entregando');
  assert.equal(r.label, 'Indo entregar');

  // Não entendeu (ou o Gemini mandou algo fora da lista): nada muda
  r = await (await speak(drv, s.id, 'nao_entendi')).json();
  assert.equal(r.acao, 'nao_entendi');
  r = await (await speak(drv, s.id, '{"acao":"voar"}')).json();
  assert.equal(r.acao, 'nao_entendi');
  assert.equal(r.service.status, 'aberto');

  // Cancelar pede confirmação antes
  r = await (await speak(drv, s.id, 'cancelar_servico')).json();
  assert.equal(r.confirmar, true);
  assert.equal((await json(drv, 'GET', `/services/${s.id}`)).status, 'aberto');

  // Finalizar
  r = await (await speak(drv, s.id, 'finalizar_servico')).json();
  assert.equal(r.service.status, 'concluido');
  const detail = await json(drv, 'GET', `/services/${s.id}`);
  assert.deepEqual(detail.events.map((e) => [e.action, e.user_name, e.source]), [
    ['iniciar_servico', 'Jorge', 'voz'],
    ['peguei_o_carro', 'Jorge', 'voz'],
    ['indo_entregar', 'Jorge', 'voz'],
    ['finalizar_servico', 'Jorge', 'voz'],
  ]);
  assert.ok(detail.events.every((e) => e.created_at));

  // Serviço já entregue: avisa, não muda
  const late = await speak(drv, s.id, 'iniciar_servico');
  assert.equal(late.status, 409);

  // Cancelar com confirmação
  const s2 = await json(adm, 'POST', '/services', { contact_name: 'Bia Souza', pickup: '2 Main St, Oviedo FL', driver_id: jorge });
  r = await (await speak(drv, s2.id, 'cancelar_servico')).json();
  assert.equal(r.confirmar, true);
  r = await json(drv, 'POST', '/voice-command/confirmar', { servico: s2.id, acao: 'cancelar_servico' });
  assert.equal(r.service.status, 'cancelado');
  assert.match(r.service.notes, /comando de voz/);

  // Serviço de outro motorista: não acha. Gemini fora do ar: erro claro.
  const s3 = await json(adm, 'POST', '/services', { contact_name: 'Caio Reis', pickup: '3 Main St, Oviedo FL', driver_id: 'fila' });
  assert.equal((await speak(drv, s3.id, 'iniciar_servico')).status, 404);
  answers.length = 0;
  answers.push(500); // os dois modelos fora do ar (o principal e o reserva)
  const down = await speak(adm, s3.id, 500);
  assert.equal(down.status, 502);
});

test('Comando de voz sem GEMINI_API_KEY: o microfone fica desligado', async (t) => {
  const ctx = makeContext();
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: DRIVER_PHONE, pin: '5678' }) })).headers.get('set-cookie').split(';')[0];
  assert.deepEqual(await (await fetch(`${base}/api/voice-command`, { headers: { Cookie: cookie } })).json(), { enabled: false });
  const res = await fetch(`${base}/api/voice-command?servico=1`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'audio/webm' }, body: Buffer.alloc(2000) });
  assert.equal(res.status, 503);
});

test('Serviço novo por voz: o Gemini tira os campos e o app preenche o formulário', async (t) => {
  const ctx = makeContext({ GEMINI_API_KEY: 'chave-teste' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  const answers = [];
  let prompt = '';
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('generativelanguage.googleapis.com')) return realFetch(url, opts);
    const body = JSON.parse(opts.body);
    prompt = body.contents[0].parts[1].text;
    assert.equal(body.generationConfig.responseSchema.properties.valor.type, 'NUMBER');
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answers.shift()) }] } }] });
  };
  const login = async (phone, pin) =>
    (await realFetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers.get('set-cookie').split(';')[0];
  const adm = await login(OWNER_PHONE, '1234');
  const drv = await login(DRIVER_PHONE, '5678');
  const speak = async (cookie, answer) => {
    answers.push(answer);
    return (await realFetch(`${base}/api/voice-command/novo`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'audio/wav' }, body: Buffer.alloc(2000, 1) })).json();
  };
  const jorge = ctx.db.prepare('SELECT id FROM users WHERE phone = ?').get(DRIVER_PHONE).id;

  let r = await speak(adm, {
    cliente: 'João Silva', telefone: '(407) 555-1234', retirada: '1200 Alafaya Trail, Oviedo', destino: 'Ribas Auto', veiculo: 'Honda Civic 2015',
    placa: 'abc1234', valor: 150, motorista: 'jorge', observacoes: 'carro não liga', transcricao: 'serviço pro João...',
  });
  assert.match(prompt, /serviço novo/);
  assert.equal(r.entendeu, true);
  assert.equal(r.contact_name, 'João Silva');
  assert.equal(r.contact_phone, '4075551234');
  assert.equal(r.pickup, '1200 Alafaya Trail, Oviedo');
  assert.equal(r.plate, 'ABC1234');
  assert.equal(r.price, 150);
  assert.equal(r.miles, null);
  assert.equal(r.driver_id, jorge);
  assert.equal(r.notes, 'carro não liga');
  // Nada foi criado: a pessoa confere e salva.
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM services').get().n, 0);

  // Motorista não escolhe motorista; fala sem serviço: não entendeu.
  r = await speak(drv, { cliente: 'Ana', motorista: 'Jorge' });
  assert.equal(r.driver_id, null);
  r = await speak(drv, { transcricao: 'bom dia' });
  assert.equal(r.entendeu, false);
});
