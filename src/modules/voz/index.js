// Comandos de voz: o microfone de todas as telas (assistente) e o da tela do serviço, o motorista aperta o microfone e fala ("peguei o carro",
// "tô indo entregar", "finaliza"...). O Gemini (Google) diz qual comando foi e o servidor muda a
// situação do serviço, guardando quem fez e a hora. Precisa de GEMINI_API_KEY.
import express from 'express';
import { HttpError, nowIso, simplify } from '../../lib/util.js';

// Ação do Gemini -> o que muda no serviço. "stage" é a etapa dentro de "em andamento".
export const ACTIONS = {
  iniciar_servico: { label: 'Serviço começado' },
  peguei_o_carro: { label: 'Peguei o carro', stage: 'coletado' },
  indo_entregar: { label: 'Indo entregar', stage: 'entregando' },
  finalizar_servico: { label: 'Serviço entregue' },
  cancelar_servico: { label: 'Cancelar serviço' },
  nao_entendi: { label: 'Não entendi' },
};

const PROMPT = `Você ouve um motorista de guincho falando um comando para o app, em português do Brasil, muitas vezes de forma informal ("bora", "tô indo", "peguei a máquina", "fechou", "acabei"). Pode ter barulho de rua ou de motor.
Escolha a ação que ele pediu:
- iniciar_servico: começar / iniciar o serviço, "vou lá buscar", "bora começar".
- peguei_o_carro: o veículo já foi coletado / está no guincho / "peguei o carro", "carro carregado".
- indo_entregar: está a caminho da entrega / "indo entregar", "tô levando", "saindo pro destino".
- finalizar_servico: serviço concluído / entregue / "finaliza", "entreguei", "acabou".
- cancelar_servico: cancelar o serviço / "cancela", "cliente desistiu".
- nao_entendi: silêncio, fala sem relação com isso, ou se tiver dúvida.
Responda só com o JSON pedido. Em "transcricao", escreva o que ele falou (curto).`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    acao: { type: 'STRING', enum: Object.keys(ACTIONS) },
    transcricao: { type: 'STRING' },
  },
  required: ['acao'],
};

// Manda o áudio para o Gemini com um pedido e um formato de JSON; devolve o JSON da resposta.
async function askGemini(ctx, audio, mimeType, prompt, schema, fetchImpl = fetch) {
  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${ctx.config.geminiVoiceModel}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.config.geminiApiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: mimeType, data: audio.toString('base64') } }, { text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Gemini respondeu ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  try {
    return JSON.parse(text) || {};
  } catch {
    return {};
  }
}

// Comando na tela do serviço: devolve { acao, transcricao }.
export async function classifyAudio(ctx, audio, mimeType, fetchImpl = fetch) {
  const answer = await askGemini(ctx, audio, mimeType, PROMPT, SCHEMA, fetchImpl);
  return {
    acao: ACTIONS[answer.acao] ? answer.acao : 'nao_entendi',
    transcricao: String(answer.transcricao || '').slice(0, 200),
  };
}

const NEW_PROMPT = `Você ouve alguém de uma empresa de guincho nos EUA (Flórida) ditando um serviço novo, em português do Brasil, às vezes informal e misturando inglês. Os endereços e nomes de rua são americanos (ex.: "1200 Alafaya Trail, Oviedo"). Tire da fala só o que foi dito, sem inventar:
- cliente: nome de quem pediu (pessoa ou empresa).
- telefone: só os números, como foram ditos.
- retirada: onde pegar o veículo (endereço, cruzamento, nome do lugar).
- destino: para onde levar.
- veiculo: marca, modelo, ano, cor (ex.: "Honda Civic 2015 prata").
- placa, vin: se foram ditos (VIN tem 17 caracteres).
- milhas: número, se disse a distância.
- valor: número em dólares, se disse o preço.
- motorista: nome do motorista, se disse quem vai fazer.
- observacoes: outras informações úteis (ex.: "carro não liga", "chave no dono").
Deixe vazio o que não foi dito. Se a fala não for sobre um serviço de guincho, deixe tudo vazio. Em "transcricao", escreva o que a pessoa falou.`;

const NEW_FIELDS = ['cliente', 'telefone', 'retirada', 'destino', 'veiculo', 'placa', 'vin', 'milhas', 'valor', 'motorista', 'observacoes', 'transcricao'];
const NEW_SCHEMA = {
  type: 'OBJECT',
  properties: Object.fromEntries(NEW_FIELDS.map((k) => [k, { type: ['milhas', 'valor'].includes(k) ? 'NUMBER' : 'STRING' }])),
};

// Serviço novo falado: devolve os campos para o app preencher o formulário (a pessoa confere e salva).
export async function readNewService(ctx, audio, mimeType, fetchImpl = fetch) {
  return newServiceFields(await askGemini(ctx, audio, mimeType, NEW_PROMPT, NEW_SCHEMA, fetchImpl));
}

function newServiceFields(a) {
  const text = (k, max = 300) => String(a[k] ?? '').trim().slice(0, max);
  const num = (k) => (Number.isFinite(Number(a[k])) && Number(a[k]) > 0 ? Number(a[k]) : null);
  return {
    contact_name: text('cliente', 120),
    contact_phone: text('telefone', 30).replace(/[^\d+]/g, ''),
    pickup: text('retirada'),
    dropoff: text('destino'),
    vehicle: text('veiculo', 120),
    plate: text('placa', 15).toUpperCase(),
    vin: text('vin', 17).toUpperCase().replace(/[^A-Z0-9]/g, ''),
    miles: num('milhas'),
    price: num('valor'),
    driver: text('motorista', 60),
    notes: text('observacoes', 500),
    transcricao: text('transcricao', 500),
  };
}

// Tipo do áudio sem o ";codecs=...". O Gemini não aceita o "audio/x-m4a" do iPhone com esse nome.
function audioType(header) {
  const type = String(header || '').split(';')[0].trim().toLowerCase();
  if (type === 'audio/x-m4a' || type === 'audio/m4a') return 'audio/mp4';
  return type.startsWith('audio/') ? type : 'audio/webm';
}

const logEvent = (ctx, serviceId, action, userId, source = 'voz') =>
  ctx.db
    .prepare('INSERT INTO service_events (service_id, action, user_id, source, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(serviceId, action, userId, source, nowIso());

// Aplica a ação no serviço. Cancelar só com confirm (o app pede "Confirmar cancelamento" antes).
export function applyAction(ctx, user, service, acao, { confirm = false, source = 'voz' } = {}) {
  const change = (body, motivo) => ctx.api.servicos.change(user, service, body, motivo);
  let result = { updated: service, notices: [] };
  if (acao === 'iniciar_servico') {
    if (service.status === 'aberto') throw new HttpError(409, 'Este serviço já está em andamento.');
    if (service.status !== 'pendente') throw new HttpError(409, 'Este serviço já foi entregue ou cancelado.');
    result = change({ status: 'aberto' });
  } else if (acao === 'peguei_o_carro' || acao === 'indo_entregar') {
    if (!['pendente', 'aberto'].includes(service.status)) throw new HttpError(409, 'Este serviço já foi entregue ou cancelado.');
    // Ainda na fila dele: falar "peguei o carro" já começa o serviço.
    if (service.status === 'pendente') result = change({ status: 'aberto' });
    ctx.db.prepare('UPDATE services SET stage = ? WHERE id = ?').run(ACTIONS[acao].stage, service.id);
    result.updated = ctx.data.services.get(service.id);
  } else if (acao === 'finalizar_servico') {
    if (service.status !== 'aberto') throw new HttpError(409, service.status === 'pendente' ? 'Comece o serviço antes de finalizar.' : 'Este serviço já foi entregue ou cancelado.');
    result = change({ status: 'concluido' });
  } else if (acao === 'cancelar_servico') {
    if (!['pendente', 'aberto'].includes(service.status)) throw new HttpError(409, 'Este serviço já foi entregue ou cancelado.');
    if (!confirm) return { pending: true, updated: service, notices: [] };
    result = change({ status: 'cancelado' }, source === 'voz' ? 'cancelado por comando de voz' : '');
  } else {
    return { updated: service, notices: [] };
  }
  logEvent(ctx, service.id, acao, user.id, source);
  return result;
}

// Motorista falado -> o da equipe com esse nome (só o ADM escolhe motorista).
function withDriver(ctx, user, fields) {
  let driver_id = null;
  if (user.role === 'dono' && fields.driver) {
    const name = simplify(fields.driver);
    const team = ctx.db.prepare("SELECT id, name FROM users WHERE active = 1 AND (role = 'motorista' OR drives = 1)").all();
    driver_id = team.find((u) => simplify(u.name) === name)?.id || team.find((u) => simplify(u.name).split(' ')[0] === name.split(' ')[0])?.id || null;
  }
  const understood = ['contact_name', 'contact_phone', 'pickup', 'dropoff', 'vehicle', 'plate', 'vin', 'miles', 'price', 'notes'].some((k) => fields[k]);
  return { ...fields, driver_id, entendeu: understood };
}

// ---------- assistente: o microfone que fica em todas as telas ----------
// Entende o que a pessoa quer (abrir uma tela, criar serviço, mudar a situação do serviço, lançar
// despesa, pagamento ou milhas do caminhão). O que mexe em dinheiro ou milhas só preenche a tela:
// a pessoa confere e confirma. Mudar a situação do serviço já é feito na hora (menos cancelar).

// Telas que dá para abrir falando. owner = só o ADM.
export const SCREENS = {
  servicos: { hash: '#/servicos', label: 'Serviços em andamento' },
  servicos_entregues: { hash: '#/servicos?status=concluido', label: 'Serviços entregues' },
  servicos_pendentes: { hash: '#/servicos?status=pendente', label: 'Serviços pendentes', owner: true },
  servico_atual: { hash: null, label: 'Serviço atual' },
  novo_servico: { hash: '#/novo', label: 'Novo serviço' },
  clientes: { hash: '#/contatos', label: 'Clientes' },
  resumo: { hash: '#/resumo', label: 'Resumo do dia' },
  resumo_mes: { hash: '#/resumo?p=mes', label: 'Resumo do mês' },
  pendencias: { hash: '#/pendentes', label: 'Pendências', module: 'pagamentos' },
  despesas: { hash: '#/despesas', label: 'Despesas', module: 'despesas' },
  caminhoes: { hash: '#/caminhoes', label: 'Caminhões e manutenção', module: 'manutencao' },
  ganhos: { hash: null, label: 'Ganhos', module: 'comissao' },
  enderecos: { hash: '#/enderecos', label: 'Endereços com apelido' },
  mais: { hash: '#/mais', label: 'Mais' },
  relatorio_dia: { hash: '#/relatorio', label: 'Relatório do dia', owner: true },
  equipe: { hash: '#/equipe', label: 'Equipe', owner: true },
  empresas: { hash: '#/empresas', label: 'Empresas e extrato', owner: true, module: 'empresas' },
  planilha: { hash: '#/planilha', label: 'Planilha do Excel', owner: true, module: 'planilha' },
  backup: { hash: '#/backup', label: 'Backup', owner: true, module: 'backup' },
};

const INTENTS = ['abrir_tela', 'servico_novo', 'status_servico', 'pagamento', 'despesa', 'milhas_caminhao', 'pular', 'nao_entendi'];

// Perguntas que o app faz para completar o serviço novo, numa conversa (campo do Gemini -> pergunta).
export const QUESTIONS = {
  telefone: 'Qual o telefone do cliente?',
  cliente: 'Qual o nome do cliente?',
  retirada: 'Onde pegar o carro?',
  destino: 'Para onde levar?',
  veiculo: 'Qual é o carro?',
  valor: 'Qual o valor do serviço?',
};
const PAY_METHODS = ['zelle', 'dinheiro', 'cartao', 'cheque', 'seguradora'];
const EXPENSE_TYPES = ['combustivel', 'pedagio', 'manutencao', 'alimentacao', 'outros'];

const ASSISTANT_PROMPT = `Você é o assistente de voz do app de uma empresa de guincho nos EUA (Flórida). Quem fala é {quem}, em português do Brasil, muitas vezes informal e misturando inglês. Pode ter barulho de rua ou de motor. {contexto}
Escolha a intenção:
- abrir_tela: quer ver/abrir uma parte do app ("abre as despesas", "mostra meus ganhos", "cadê os serviços de hoje", "procura o cliente João"). Ponha a tela em "tela" e, se pediu um cliente, o nome em "busca".
- servico_novo: está ditando um serviço novo (cliente, telefone, onde pegar, para onde levar, carro, preço). Preencha cliente, telefone (só números), retirada, destino, veiculo, placa, vin, distancia (milhas da viagem), valor (preço em dólares), motorista (quem vai fazer), observacoes.
- status_servico: muda a situação do serviço atual. Ponha em "acao": iniciar_servico ("bora começar", "vou lá buscar"), peguei_o_carro ("carro carregado", "peguei a máquina"), indo_entregar ("tô levando"), finalizar_servico ("entreguei", "acabou"), cancelar_servico ("cancela", "cliente desistiu").
- pagamento: recebeu dinheiro do serviço ("recebi 150 no zelle", "cliente pagou em cash"). valor em dólares; forma: zelle, dinheiro (cash), cartao, cheque ou seguradora (AAA, Agero, Honk, motor club, com o nome em "pagador").
- despesa: gastou dinheiro ("abasteci 80 dólares", "paguei 12 de pedágio", "troquei o pneu, 300"). valor em dólares; categoria: combustivel, pedagio, manutencao, alimentacao ou outros; descricao curta (ex.: "diesel"); se disse as milhas do painel do caminhão (odômetro), ponha em "odometro"; se disse qual caminhão, em "caminhao".
- milhas_caminhao: só informa as milhas do painel do caminhão ("o caminhão está com 123 mil e 400 milhas"). Número inteiro em "odometro"; caminhão em "caminhao" se disse.
- pular: não sabe ou quer deixar a pergunta em branco ("não sei", "pula", "depois eu vejo").
- nao_entendi: silêncio, conversa sem pedido, ou se tiver dúvida.
Não invente nada que não foi dito. Números: "123 mil e 400" = 123400; "80 e 50" dólares = 80.50. Em "transcricao", escreva o que a pessoa falou.`;

const ASSISTANT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    intencao: { type: 'STRING', enum: INTENTS },
    tela: { type: 'STRING', enum: Object.keys(SCREENS) },
    busca: { type: 'STRING' },
    acao: { type: 'STRING', enum: Object.keys(ACTIONS).filter((a) => a !== 'nao_entendi') },
    valor: { type: 'NUMBER' },
    forma: { type: 'STRING', enum: PAY_METHODS },
    pagador: { type: 'STRING' },
    categoria: { type: 'STRING', enum: EXPENSE_TYPES },
    descricao: { type: 'STRING' },
    odometro: { type: 'NUMBER' },
    caminhao: { type: 'STRING' },
    cliente: { type: 'STRING' },
    telefone: { type: 'STRING' },
    retirada: { type: 'STRING' },
    destino: { type: 'STRING' },
    veiculo: { type: 'STRING' },
    placa: { type: 'STRING' },
    vin: { type: 'STRING' },
    distancia: { type: 'NUMBER' },
    motorista: { type: 'STRING' },
    observacoes: { type: 'STRING' },
    transcricao: { type: 'STRING' },
  },
  required: ['intencao'],
};

const STATUS_WORDS = { pendente: 'pendente (ainda não começou)', aberto: 'em andamento', concluido: 'entregue', cancelado: 'cancelado' };

export async function askAssistant(ctx, user, service, audio, mimeType, { question = '' } = {}, fetchImpl = fetch) {
  let contexto = service
    ? `Serviço atual: #${service.id}, ${STATUS_WORDS[service.status] || service.status}${service.vehicle ? `, ${service.vehicle}` : ''}.`
    : 'Ele não está com nenhum serviço aberto agora.';
  // Conversa do serviço novo: a resposta curta ("na Ribas", "um Civic 2015") é o campo perguntado.
  if (QUESTIONS[question]) {
    contexto = `Ele está preenchendo um serviço novo e o app acabou de perguntar: "${QUESTIONS[question]}". A resposta vai no campo "${question}" com intenção servico_novo (junto com qualquer outro dado do serviço que ele falar), a não ser que peça claramente outra coisa ou queira pular.`;
  }
  const prompt = ASSISTANT_PROMPT.replace('{quem}', user.role === 'dono' ? `o dono/ADM (${user.name})` : `o motorista ${user.name}`).replace('{contexto}', contexto);
  return askGemini(ctx, audio, mimeType, prompt, ASSISTANT_SCHEMA, fetchImpl);
}

const positive = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

// Resposta do Gemini -> o que o app faz.
export function assistantResult(ctx, user, service, a) {
  const intencao = INTENTS.includes(a.intencao) ? a.intencao : 'nao_entendi';
  const transcricao = String(a.transcricao || '').slice(0, 500);
  const words = String(a.caminhao || '').split(/\s+/).filter(Boolean);
  const nope = (msg) => ({ intencao: 'nao_entendi', transcricao, mensagem: msg });
  const needService = () => {
    if (!service) throw new HttpError(409, 'Você não está com nenhum serviço aberto. Abra o serviço e fale de novo.');
  };

  if (intencao === 'abrir_tela') {
    const screen = SCREENS[a.tela];
    if (!screen) return nope();
    if (screen.module && !ctx.has(screen.module)) return nope(`${screen.label} não está ligado neste app.`);
    if (screen.owner && user.role !== 'dono') return nope(`${screen.label} é só para o ADM.`);
    let hash = screen.hash;
    if (a.tela === 'ganhos') hash = user.role === 'dono' ? '#/comissao' : `#/motorista/${user.id}`;
    if (a.tela === 'servico_atual') {
      needService();
      hash = `#/servico/${service.id}`;
    }
    const busca = String(a.busca || '').trim().slice(0, 60);
    if (a.tela === 'clientes' && busca) hash += `?q=${encodeURIComponent(busca)}`;
    return { intencao, transcricao, tela: a.tela, label: screen.label, hash };
  }

  if (intencao === 'servico_novo') {
    const fields = withDriver(ctx, user, newServiceFields({ ...a, milhas: a.distancia }));
    return fields.entendeu ? { intencao, transcricao, campos: fields } : nope();
  }

  if (intencao === 'status_servico') {
    if (!ACTIONS[a.acao] || a.acao === 'nao_entendi') return nope();
    needService();
    return { intencao, transcricao, acao: a.acao, label: ACTIONS[a.acao].label, service_id: service.id };
  }

  if (intencao === 'pagamento') {
    if (!ctx.has('pagamentos')) return nope('Os pagamentos não estão ligados neste app.');
    needService();
    const method = PAY_METHODS.includes(a.forma) ? a.forma : '';
    return {
      intencao,
      transcricao,
      service_id: service.id,
      campos: { amount: positive(a.valor), method, payer: String(a.pagador || '').trim().slice(0, 60) },
    };
  }

  if (intencao === 'despesa') {
    if (!ctx.has('despesas')) return nope('As despesas não estão ligadas neste app.');
    const named = words.length ? ctx.api.manutencao?.findTruck(words) : null;
    return {
      intencao,
      transcricao,
      campos: {
        amount: positive(a.valor),
        category: EXPENSE_TYPES.includes(a.categoria) ? a.categoria : '',
        description: String(a.descricao || '').trim().slice(0, 120),
        odometer: positive(a.odometro) && Math.round(a.odometro),
        truck_id: named?.id ?? null,
      },
    };
  }

  if (intencao === 'milhas_caminhao') {
    if (!ctx.has('manutencao')) return nope('Os caminhões não estão ligados neste app.');
    const odometer = positive(a.odometro) && Math.round(a.odometro);
    if (!odometer) return nope('Não ouvi as milhas. Fale o número do painel do caminhão.');
    const truck = (words.length && ctx.api.manutencao.findTruck(words)) || ctx.api.manutencao.truckFor(user.id);
    if (!truck) return { intencao, transcricao, odometer, truck_id: null, hash: '#/caminhoes' };
    return { intencao, transcricao, odometer, truck_id: truck.id, truck_name: truck.name, truck_odometer: truck.odometer };
  }

  if (intencao === 'pular') return { intencao, transcricao };

  return nope();
}

function findService(ctx, user, id) {
  const service = ctx.data.services.get(Number(id));
  if (!ctx.api.servicos.canSee(user, service)) throw new HttpError(404, 'Serviço não encontrado.');
  return service;
}

export default {
  name: 'voz',
  label: 'Comandos de voz',
  migrations: [
    `ALTER TABLE services ADD COLUMN stage TEXT;
     CREATE TABLE service_events (
       id INTEGER PRIMARY KEY,
       service_id INTEGER NOT NULL REFERENCES services(id),
       action TEXT NOT NULL,
       user_id INTEGER REFERENCES users(id),
       source TEXT NOT NULL,
       created_at TEXT NOT NULL
     );
     CREATE INDEX service_events_service ON service_events(service_id, created_at);`,
  ],

  // Na tela do serviço: a etapa atual e o histórico (quem fez e quando).
  serviceDetail({ ctx, service }) {
    const events = ctx.db
      .prepare('SELECT e.action, e.source, e.created_at, u.name AS user_name FROM service_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.service_id = ? ORDER BY e.id')
      .all(service.id);
    return { events };
  },

  routes(api, ctx) {
    // O app pergunta se o microfone está ligado (tem a chave).
    api.get('/voice-command', (req, res) => res.json({ enabled: Boolean(ctx.config.geminiApiKey) }));

    // Recebe o áudio (corpo é o áudio) e o serviço em ?servico=ID.
    api.post('/voice-command', express.raw({ type: 'audio/*', limit: '10mb' }), async (req, res) => {
      if (!ctx.config.geminiApiKey) throw new HttpError(503, 'Os comandos de voz precisam da GEMINI_API_KEY no servidor.');
      const service = findService(ctx, req.user, req.query.servico);
      if (!Buffer.isBuffer(req.body) || req.body.length < 500) throw new HttpError(400, 'Não ouvi nada. Aperte o microfone e fale o comando.');
      let heard;
      try {
        heard = await classifyAudio(ctx, req.body, audioType(req.headers['content-type']));
      } catch (err) {
        ctx.log('Comando de voz: falha no Gemini', err.message);
        throw new HttpError(502, 'Não consegui entender o áudio agora. Tente de novo ou use os botões.');
      }
      const result = applyAction(ctx, req.user, service, heard.acao);
      res.json({
        acao: heard.acao,
        label: ACTIONS[heard.acao].label,
        transcricao: heard.transcricao,
        confirmar: Boolean(result.pending),
        service: result.updated,
        notices: result.notices,
      });
    });

    // Serviço novo falado: devolve os campos; o app preenche o formulário e a pessoa toca em Criar.
    api.post('/voice-command/novo', express.raw({ type: 'audio/*', limit: '15mb' }), async (req, res) => {
      if (!ctx.config.geminiApiKey) throw new HttpError(503, 'Os comandos de voz precisam da GEMINI_API_KEY no servidor.');
      if (!Buffer.isBuffer(req.body) || req.body.length < 500) throw new HttpError(400, 'Não ouvi nada. Aperte o microfone e fale o serviço.');
      let fields;
      try {
        fields = await readNewService(ctx, req.body, audioType(req.headers['content-type']));
      } catch (err) {
        ctx.log('Serviço por voz: falha no Gemini', err.message);
        throw new HttpError(502, 'Não consegui entender o áudio agora. Tente de novo ou digite.');
      }
      res.json(withDriver(ctx, req.user, fields));
    });

    // Assistente (microfone de todas as telas). ?servico=ID quando a pessoa está na tela de um serviço.
    api.post('/voice-command/assistente', express.raw({ type: 'audio/*', limit: '15mb' }), async (req, res) => {
      if (!ctx.config.geminiApiKey) throw new HttpError(503, 'Os comandos de voz precisam da GEMINI_API_KEY no servidor.');
      if (!Buffer.isBuffer(req.body) || req.body.length < 500) throw new HttpError(400, 'Não ouvi nada. Segure o microfone e fale.');
      // Sem tela de serviço aberta: o serviço em andamento dele, ou o único que está na fila dele.
      let service = req.query.servico ? findService(ctx, req.user, req.query.servico) : ctx.data.services.active(req.user);
      if (!service) {
        const queue = ctx.db.prepare("SELECT id FROM services WHERE driver_id = ? AND status = 'pendente'").all(req.user.id);
        if (queue.length === 1) service = ctx.data.services.get(queue[0].id);
      }
      let answer;
      try {
        answer = await askAssistant(ctx, req.user, service, req.body, audioType(req.headers['content-type']), { question: String(req.query.pergunta || '') });
      } catch (err) {
        ctx.log('Assistente de voz: falha no Gemini', err.message);
        throw new HttpError(502, 'Não consegui entender o áudio agora. Tente de novo.');
      }
      const result = assistantResult(ctx, req.user, service, answer);
      // Situação do serviço: muda na hora, como o microfone da tela do serviço (cancelar pede confirmação).
      if (result.intencao === 'status_servico') {
        const done = applyAction(ctx, req.user, service, result.acao);
        Object.assign(result, { confirmar: Boolean(done.pending), service: done.updated, notices: done.notices });
      }
      res.json(result);
    });

    // Depois do "Confirmar cancelamento" na tela.
    api.post('/voice-command/confirmar', (req, res) => {
      const service = findService(ctx, req.user, req.body?.servico);
      if (req.body?.acao !== 'cancelar_servico') throw new HttpError(400, 'Nada para confirmar.');
      const result = applyAction(ctx, req.user, service, 'cancelar_servico', { confirm: true });
      res.json({ acao: 'cancelar_servico', label: 'Serviço cancelado', service: result.updated });
    });
  },
};
