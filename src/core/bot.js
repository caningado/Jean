// O "cérebro" do robô. Não sabe nada de WhatsApp: recebe uma mensagem
// (telefone + texto ou foto) e devolve as respostas. O módulo whatsapp é só
// o meio de transporte, e o simulador do painel usa este mesmo código.
import { normalizePhone, simplify, nowIso } from '../lib/util.js';
import { ValidationError } from '../lib/validate.js';
import { servicesBlocked } from '../lib/daily.js';
import { createAi, CONFIRM_FIRST } from './ai.js';

// Resposta inválida numa conversa: o robô mostra a mensagem e repete a pergunta.
export class FlowError extends ValidationError {}

export function createBot(ctx) {
  const { db } = ctx;
  const ai = createAi(ctx);

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

  async function runCommand(user, text) {
    const [word, ...rest] = simplify(text).split(/\s+/);
    const command = findCommand(word);
    if (!command) return null;
    const original = String(text).trim().split(/\s+/).slice(1).join(' ');
    return (command.blockable && servicesBlocked(ctx, user)) || (await command.run({ ctx, user, args: rest, rawArgs: original, text }));
  }

  // Serviço novo ditado: começa o cadastro e já responde as perguntas com o que foi dito.
  // Para na primeira pergunta sem resposta (ou com resposta que não passou), como uma conversa.
  async function startNewService(user, novo) {
    const answers = {
      client: novo.telefone || novo.cliente || undefined,
      client_name: novo.telefone && novo.cliente ? novo.cliente : undefined,
      client_phone: !novo.telefone ? undefined : novo.telefone,
      pickup: novo.retirada || undefined,
      dropoff: novo.destino || undefined,
      vehicle: novo.veiculo || undefined,
      miles: novo.milhas != null ? String(novo.milhas) : undefined,
      price_cents: novo.valor != null ? String(novo.valor) : undefined,
    };
    const reply = await runCommand(user, 'novo');
    const conversation = getConversation(user.id);
    if (conversation?.flow !== 'novo') return [].concat(reply);
    conversation.data._prefill = Object.fromEntries(Object.entries(answers).filter(([, v]) => v !== undefined));
    saveConversation(user.id, 'novo', conversation.step, conversation.data);
    return autoAnswer(user, reply);
  }

  // Responde sozinho as perguntas do cadastro que já têm resposta guardada (data._prefill),
  // até chegar numa que falta. Devolve as respostas do robô da última pergunta.
  async function autoAnswer(user, reply) {
    const notices = [];
    for (let i = 0; i < 12; i++) {
      const conversation = getConversation(user.id);
      const prefill = conversation?.data._prefill;
      const key = conversation && ctx.flows[conversation.flow]?.steps[conversation.step]?.key;
      if (!prefill || prefill[key] === undefined) break;
      const answer = prefill[key];
      delete prefill[key];
      reply = await continueFlow(user, conversation, answer);
      const list = [].concat(reply);
      if (list.length > 1) notices.push(...list.slice(0, -1).filter((t) => !t.startsWith('⚠️')));
    }
    return [...notices, ...[].concat(reply)];
  }

  // Mensagem que não é comando (ou áudio): o Gemini diz qual comando a pessoa quis.
  async function askAi(user, { text = '', audio = null }) {
    let heard;
    try {
      heard = await ai.understand(user, { text, audio });
    } catch (err) {
      ctx.log('Robô: falha no Gemini', err.message);
      return audio ? 'Não consegui ouvir o áudio agora. Tente de novo ou escreva.' : 'Não entendi. Mande *ajuda* para ver os comandos.';
    }
    const said = audio && heard.transcricao ? `🎤 Ouvi: "${heard.transcricao}"` : null;
    const word = simplify(heard.comando).split(/\s+/)[0];
    const command = word && findCommand(word);
    if (!command) return [said, heard.resposta || 'Não entendi. Pode explicar de outro jeito? Ou mande *ajuda* para ver os comandos.'];
    if (command.names[0] === 'novo') return [said, ...(await startNewService(user, heard.novo))];
    // Escreveu o comando certinho (só que comprido): faz direto, sem pedir "sim".
    if (!audio && simplify(heard.comando) === simplify(text)) return runCommand(user, text);
    if (CONFIRM_FIRST.includes(command.names[0])) {
      saveConversation(user.id, 'ai_confirm', 0, { text: heard.comando });
      return [said, `🤖 Entendi: *${heard.comando}*\nMande *sim* para confirmar (ou outra coisa para deixar pra lá).`];
    }
    return [said, `🤖 *${heard.comando}*`, ...[].concat(await runCommand(user, heard.comando))];
  }

  // Ponto de entrada. Sempre devolve uma lista de textos para responder.
  // audio = { buffer, mime }: mensagem de voz (precisa do Gemini).
  async function handle({ phone, text = '', media = null, audio = null }) {
    const user = findUser(phone);
    if (!user) {
      return ['Este número não está cadastrado na equipe. Peça ao responsável para te adicionar no painel.'];
    }

    let conversation = getConversation(user.id);
    let prefix = [];
    if (audio) {
      if (!ai.enabled()) return ['Por enquanto eu entendo texto e fotos. Mande *ajuda* para ver os comandos.'];
      const step = conversation && ctx.flows[conversation.flow]?.steps[conversation.step];
      const question = conversation?.flow === 'ai_confirm' ? `Mande *sim* para confirmar: ${conversation.data.text}` : step && [].concat(step.ask(conversation.data, ctx)).join('\n');
      if (!question) return finish(await askAi(user, { audio }));
      // No meio de um cadastro (ou de um "sim?"): o áudio é a resposta da pergunta.
      try {
        text = await ai.transcribe(audio, question);
      } catch (err) {
        ctx.log('Robô: falha no Gemini', err.message);
        return ['Não consegui ouvir o áudio agora. Tente de novo ou escreva.'];
      }
      if (!text) return ['Não entendi o áudio. Pode repetir ou escrever?'];
      prefix = [`🎤 Ouvi: "${text}"`];
    }

    const simple = simplify(text);

    if (['cancelar', 'sair', 'parar'].includes(simple)) {
      clearConversation(user.id);
      return [...prefix, 'Ok, cancelado. Mande *ajuda* para ver os comandos.'];
    }

    // Comando que o Gemini entendeu esperando o "sim".
    if (conversation?.flow === 'ai_confirm') {
      clearConversation(user.id);
      if (['sim', 's', 'ok', 'confirmar', 'isso', 'pode', 'yes'].includes(simple)) return finish([...prefix, ...[].concat(await runCommand(user, conversation.data.text))]);
      conversation = null;
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
      if (reply != null) reply = await autoAnswer(user, reply);
    }

    if (reply == null) {
      // Com o Gemini, frase comprida vai para ele mesmo começando com palavra de comando
      // ("abasteci oitenta de diesel agora", "serviço pro João na Alafaya...").
      const typed = findCommand(simple.split(/\s+/)[0]);
      const natural = ai.enabled() && simple.split(/\s+/).length > 4;
      if (typed && !natural) reply = await runCommand(user, text);
      else if (ai.enabled() && simple) reply = await askAi(user, { text });
      else reply = 'Não entendi. Mande *ajuda* para ver os comandos.';
    }

    return finish([...prefix, ...[].concat(reply)]);
  }

  const finish = (reply) => (Array.isArray(reply) ? reply : [reply]).filter(Boolean);

  return { handle, startFlow, findUser, clearConversation, getConversation };
}
