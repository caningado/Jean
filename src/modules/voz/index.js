// Comandos de voz: na tela do serviço, o motorista aperta o microfone e fala ("peguei o carro",
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
  const a = await askGemini(ctx, audio, mimeType, NEW_PROMPT, NEW_SCHEMA, fetchImpl);
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
      // Motorista falado -> o da equipe com esse nome (só o ADM escolhe motorista).
      let driver_id = null;
      if (req.user.role === 'dono' && fields.driver) {
        const name = simplify(fields.driver);
        const team = ctx.db.prepare("SELECT id, name FROM users WHERE active = 1 AND (role = 'motorista' OR drives = 1)").all();
        driver_id = team.find((u) => simplify(u.name) === name)?.id || team.find((u) => simplify(u.name).split(' ')[0] === name.split(' ')[0])?.id || null;
      }
      const understood = ['contact_name', 'contact_phone', 'pickup', 'dropoff', 'vehicle', 'plate', 'vin', 'miles', 'price', 'notes'].some((k) => fields[k]);
      res.json({ ...fields, driver_id, entendeu: understood });
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
