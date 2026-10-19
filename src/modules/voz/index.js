// Comandos de voz: na tela do serviço, o motorista aperta o microfone e fala ("peguei o carro",
// "tô indo entregar", "finaliza"...). O Gemini (Google) diz qual comando foi e o servidor muda a
// situação do serviço, guardando quem fez e a hora. Precisa de GEMINI_API_KEY.
import express from 'express';
import { HttpError, nowIso } from '../../lib/util.js';

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

// Manda o áudio para o Gemini e devolve { acao, transcricao }.
export async function classifyAudio(ctx, audio, mimeType, fetchImpl = fetch) {
  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${ctx.config.geminiVoiceModel}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.config.geminiApiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: mimeType, data: audio.toString('base64') } }, { text: PROMPT }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Gemini respondeu ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  let answer = {};
  try {
    answer = JSON.parse(text);
  } catch {}
  return {
    acao: ACTIONS[answer.acao] ? answer.acao : 'nao_entendi',
    transcricao: String(answer.transcricao || '').slice(0, 200),
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

    // Depois do "Confirmar cancelamento" na tela.
    api.post('/voice-command/confirmar', (req, res) => {
      const service = findService(ctx, req.user, req.body?.servico);
      if (req.body?.acao !== 'cancelar_servico') throw new HttpError(400, 'Nada para confirmar.');
      const result = applyAction(ctx, req.user, service, 'cancelar_servico', { confirm: true });
      res.json({ acao: 'cancelar_servico', label: 'Serviço cancelado', service: result.updated });
    });
  },
};
