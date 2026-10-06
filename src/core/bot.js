// O "cérebro" do robô. Não sabe nada de WhatsApp: recebe uma mensagem
// (telefone + texto ou foto) e devolve as respostas. O módulo whatsapp é só
// o meio de transporte, e o simulador do painel usa este mesmo código.
import { normalizePhone, simplify, nowIso } from '../lib/util.js';
import { ValidationError } from '../lib/validate.js';

// Resposta inválida numa conversa: o robô mostra a mensagem e repete a pergunta.
export class FlowError extends ValidationError {}

export function createBot(ctx) {
  const { db } = ctx;

  function findUser(phone) {
    return db.prepare('SELECT * FROM users WHERE phone = ? AND active = 1').get(normalizePhone(phone));
  }

  function getConversation(userId) {
    const row = db.prepare('SELECT * FROM conversations WHERE user_id = ?').get(userId);
    return row ? { ...row, data: JSON.parse(row.data || '{}') } : null;
  }

  function saveConversation(userId, flow, step, data) {
    db.prepare(
      `INSERT INTO conversations (user_id, flow, step, data, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET flow = excluded.flow, step = excluded.step, data = excluded.data, updated_at = excluded.updated_at`
    ).run(userId, flow, step, JSON.stringify(data), nowIso());
  }

  function clearConversation(userId) {
    db.prepare('DELETE FROM conversations WHERE user_id = ?').run(userId);
  }

  // Pula etapas que não se aplicam (ex.: valor já calculado pelas milhas).
  function nextStep(flow, from, data) {
    let i = from;
    while (i < flow.steps.length && flow.steps[i].skip?.(data, ctx)) i++;
    return i;
  }

  async function finishFlow(user, flow, data) {
    clearConversation(user.id);
    return flow.finish({ ctx, user, data });
  }

  async function startFlow(user, name, data = {}) {
    const flow = ctx.flows[name];
    if (!flow) throw new Error(`Fluxo desconhecido: ${name}`);
    const step = nextStep(flow, 0, data);
    if (step >= flow.steps.length) return finishFlow(user, flow, data);
    saveConversation(user.id, name, step, data);
    return flow.steps[step].ask(data, ctx);
  }

  async function continueFlow(user, conversation, text) {
    const flow = ctx.flows[conversation.flow];
    if (!flow) {
      clearConversation(user.id);
      return null;
    }
    const data = conversation.data;
    const step = flow.steps[conversation.step];
    const answer = String(text || '').trim();

    if (simplify(answer) === 'pular' && step.optional) {
      data[step.key] = null;
    } else {
      try {
        data[step.key] = await step.parse(answer, { ctx, user, data });
      } catch (err) {
        if (err instanceof ValidationError) return [`⚠️ ${err.message}`, step.ask(data, ctx)];
        throw err;
      }
    }

    // Um passo pode deixar um aviso (data._notice) para mostrar antes da próxima pergunta,
    // e pode pedir para ser repetido (step.again) com os dados novos.
    const notice = data._notice;
    delete data._notice;
    const withNotice = (reply) => (notice ? [notice, ...[].concat(reply)] : reply);
    if (step.again?.(data)) {
      saveConversation(user.id, conversation.flow, conversation.step, data);
      return withNotice(step.ask(data, ctx));
    }
    const next = nextStep(flow, conversation.step + 1, data);
    if (next >= flow.steps.length) return withNotice(await finishFlow(user, flow, data));
    saveConversation(user.id, conversation.flow, next, data);
    return withNotice(flow.steps[next].ask(data, ctx));
  }

  function findCommand(word) {
    return ctx.commands.find((c) => c.names.includes(word));
  }

  // Ponto de entrada. Sempre devolve uma lista de textos para responder.
  async function handle({ phone, text = '', media = null }) {
    const user = findUser(phone);
    if (!user) {
      return ['Este número não está cadastrado na equipe. Peça ao responsável para te adicionar no painel.'];
    }

    const simple = simplify(text);
    const conversation = getConversation(user.id);

    if (['cancelar', 'sair', 'parar'].includes(simple)) {
      clearConversation(user.id);
      return ['Ok, cancelado. Mande *ajuda* para ver os comandos.'];
    }

    let reply = null;
    if (media) {
      for (const handler of ctx.mediaHandlers) {
        reply = await handler({ ctx, user, media, caption: text });
        if (reply) break;
      }
      reply ??= 'Recebi a imagem, mas não sei o que fazer com ela.';
    } else if (conversation) {
      reply = await continueFlow(user, conversation, text);
    }

    if (reply == null) {
      const [word, ...rest] = simple.split(/\s+/);
      const command = findCommand(word);
      if (command) {
        const original = String(text).trim().split(/\s+/).slice(1).join(' ');
        reply = await command.run({ ctx, user, args: rest, rawArgs: original, text });
      } else {
        reply = 'Não entendi. Mande *ajuda* para ver os comandos.';
      }
    }

    return (Array.isArray(reply) ? reply : [reply]).filter(Boolean);
  }

  return { handle, startFlow, findUser, clearConversation, getConversation };
}
