// O "cérebro" do robô. Não sabe nada de WhatsApp: recebe uma mensagem
// (telefone + texto ou foto) e devolve as respostas. O módulo whatsapp é só
// o meio de transporte, e o simulador do painel usa este mesmo código.
import fs from 'node:fs';
import path from 'node:path';
import { normalizePhone, simplify, nowIso, formatPhone } from '../lib/util.js';
import { ValidationError } from '../lib/validate.js';
import { servicesBlocked } from '../lib/daily.js';
import { guessService, looksLikeService } from '../lib/servico-texto.js';
import { createAi, CONFIRM_FIRST } from './ai.js';

const GREETING = /^(oi+|ola|opa|e ai|eai|fala|bom dia|boa tarde|boa noite|hello|hi|hey|good morning)( (pessoal|robo|robozinho|tudo bem|tudo bom|td bem))?[\s!.,?]*$/;

// Depois de tanto tempo parado, o cadastro pela metade é esquecido.
const CONVERSA_VALE_MS = 6 * 60 * 60 * 1000;

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
  async function startNewService(user, novo, extra = {}) {
    const reply = await runCommand(user, 'novo');
    const conversation = getConversation(user.id);
    if (conversation?.flow !== 'novo') return [].concat(reply);
    Object.assign(conversation.data, extra);
    conversation.data._prefill = novoAnswers(novo);
    saveConversation(user.id, 'novo', conversation.step, conversation.data);
    // Mostra o que entendeu, para a pessoa conferir antes das perguntas que faltam.
    const seen = [
      novo.cliente && `Cliente: ${novo.cliente}${novo.telefone ? ` (${formatPhone(novo.telefone)})` : ''}`,
      !novo.cliente && novo.telefone && `Telefone: ${formatPhone(novo.telefone)}`,
      novo.retirada && `Pegar: ${novo.retirada}`,
      novo.destino && `Levar: ${novo.destino}`,
      novo.veiculo && `Carro: ${novo.veiculo}`,
      novo.milhas != null && `Milhas: ${novo.milhas}`,
      novo.valor != null && `Valor: $${novo.valor}`,
    ].filter(Boolean);
    const intro = seen.length >= 2 ? [`📝 Novo serviço. Entendi:\n${seen.join('\n')}`] : [];
    return [...intro, ...(await autoAnswer(user, reply))];
  }

  // O que o Gemini tirou da fala -> respostas das perguntas do cadastro (pelas chaves das etapas).
  function novoAnswers(novo) {
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
    return Object.fromEntries(Object.entries(answers).filter(([, v]) => v !== undefined));
  }

  // No meio do cadastro de serviço a pessoa falou várias coisas de uma vez (fora de ordem):
  // guarda o resto para responder sozinho as próximas perguntas. Devolve a resposta da pergunta atual.
  async function answerWithExtras(user, conversation, { audio = null, text = '' }, question) {
    const heard = await ai.answer({ audio, text }, question, { service: conversation.flow === 'novo' });
    if (heard.novo) {
      const key = ctx.flows.novo.steps[conversation.step]?.key;
      const extras = novoAnswers(heard.novo);
      delete extras[key];
      if (key === 'client') {
        delete extras.client_name;
        delete extras.client_phone;
      }
      if (Object.keys(extras).length) {
        conversation.data._prefill = { ...(conversation.data._prefill || {}), ...extras };
        saveConversation(user.id, conversation.flow, conversation.step, conversation.data);
      }
    }
    return heard.texto;
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
  // O que a inteligência precisa saber para responder perguntas ("qual o VIN?", "pra onde levo?").
  function situation(user) {
    const lines = [];
    const service = ctx.data.services.active(user);
    lines.push(service ? `Serviço aberto dele:\n${ctx.data.services.describe(service, user)}` : 'Ele não tem serviço aberto agora.');
    const vin = ctx.api.vin?.pending(user.id);
    if (vin) lines.push(`Último VIN que ele mandou em foto (ainda sem serviço): ${vin.vin}${vin.vehicle ? ` (${vin.vehicle})` : ''}.`);
    return lines.join('\n');
  }

  // O Jay não conseguiu: passa para a pessoa de apoio (módulo ajuda) resolver. Quem estava falando
  // não precisa ajudar nem explicar de novo: só recebe a solução depois (pedido do Caningado 21/10).
  // Sem pessoa de apoio, fica a resposta normal (replies). "said" = o "🎤 Ouvi" do áudio.
  async function withHelp(user, text, reason, replies, said = null) {
    const note = await ctx.api.ajuda?.pedir(user, text, reason);
    return note ? [said, note].filter(Boolean) : [said, ...[].concat(replies)].filter(Boolean);
  }

  async function askAi(user, { text = '', audio = null }) {
    let heard;
    try {
      heard = await ai.understand(user, { text, audio, situacao: situation(user) });
    } catch (err) {
      ctx.log('Robô: falha no Gemini', err.message);
      // Plano B: mensagens encaminhadas com cara de serviço viram serviço novo mesmo sem a inteligência.
      const novo = !audio && !getConversation(user.id) ? guessService(text) : null;
      if (novo && looksLikeService(novo)) return startNewService(user, novo);
      return withHelp(
        user,
        audio ? '(mandou um áudio)' : text,
        'a inteligência (Gemini) não respondeu',
        audio ? 'Não consegui ouvir o áudio agora. Tente de novo ou escreva.' : 'A inteligência não respondeu agora. Tente de novo daqui a pouco, ou mande *ajuda* para ver os comandos.'
      );
    }
    const said = audio && heard.transcricao ? `🎤 Ouvi: "${heard.transcricao}"` : null;
    // Falou o próprio comando ("ajuda", "novo serviço") e o Gemini não preencheu: usa o que ele ouviu.
    if (!heard.comando && audio) {
      const spoken = simplify(heard.transcricao).replace(/[.!?,;:]+/g, ' ').trim();
      if (spoken && spoken.split(/\s+/).length <= 4 && findCommand(spoken.split(/\s+/)[0])) heard.comando = spoken;
    }
    const word = simplify(heard.comando).split(/\s+/)[0];
    const command = word && findCommand(word);
    if (!command && !heard.resposta) return withHelp(user, heard.transcricao || text || '(áudio)', 'o Jay não entendeu', 'Não entendi. Pode explicar de outro jeito? Ou mande *ajuda* para ver os comandos.', said);
    if (!command) return heard.duvida ? withHelp(user, heard.transcricao || text || '(áudio)', 'o Jay não soube resolver', heard.resposta, said) : [said, heard.resposta];
    if (command.names[0] === 'novo') return [said, ...(await startNewService(user, heard.novo))];
    // Escreveu o comando certinho (só que comprido): faz direto, sem pedir "sim".
    if (!audio && simplify(heard.comando) === simplify(text)) return runCommand(user, text);
    if (CONFIRM_FIRST.includes(command.names[0])) {
      saveConversation(user.id, 'ai_confirm', 0, { text: heard.comando });
      return [said, `🤖 Entendi: *${heard.comando}*\nMande *sim* para confirmar (ou outra coisa para deixar pra lá).`];
    }
    return [said, `🤖 *${heard.comando}*`, ...[].concat(await runCommand(user, heard.comando))];
  }

  // PDF (gate pass, pedido de serviço) mandado pelo WhatsApp.
  // Sem serviço aberto (ou de outro carro): lê o documento e começa um serviço novo com o que estava nele;
  // o PDF entra no serviço quando ele for criado. Com o serviço do mesmo carro aberto: guarda nele.
  async function handleDoc(user, conversation, doc) {
    const fotos = ctx.api.fotos;
    if (!fotos?.docTypes[doc.mime]) return 'Esse tipo de arquivo eu não abro. Mande PDF ou foto.';
    let read = null;
    if (ai.enabled()) {
      try {
        read = await ai.readDocument(doc);
      } catch (err) {
        ctx.log('Robô: falha ao ler o documento', err.message);
      }
    }
    const active = ctx.data.services.active(user);
    // Serviço aberto sem VIN ou com o mesmo VIN: o documento é dele. VIN diferente: é outro carro.
    const sameCar = active && conversation?.flow !== 'novo' && (!read?.vin || !active.vin || active.vin === read.vin);
    if (sameCar) {
      fotos.saveDoc({ serviceId: active.id, buffer: doc.buffer, mime: doc.mime, name: doc.name, userId: user.id });
      if (read?.vin && !active.vin && ctx.api.vin?.remember(user.id, read.vin)) await ctx.api.vin.attachPending(user, active);
      return `📄 Documento guardado no serviço #${ctx.data.services.ref(active, user)}.${read?.vin && !active.vin ? ` VIN ${read.vin} salvo.` : ''} Aparece no painel, no serviço.`;
    }
    if (!read) {
      return ai.enabled()
        ? 'Não consegui ler esse documento agora. Mande *novo* para abrir o serviço e depois mande o PDF de novo, que eu guardo nele.'
        : 'Não tem serviço aberto. Mande *novo* para abrir o serviço e depois mande o PDF, que eu guardo nele.';
    }
    // Guarda o arquivo até o serviço ser criado.
    const dir = path.join(ctx.config.uploadsDir, 'pendentes');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${user.id}-${Date.now()}${fotos.docTypes[doc.mime]}`);
    fs.writeFileSync(file, doc.buffer);
    if (read.vin) ctx.api.vin?.remember(user.id, read.vin);
    clearConversation(user.id);
    const extras = [
      read.vin && `VIN: ${read.vin}`,
      read.observacoes && `Obs.: ${read.observacoes}`,
    ].filter(Boolean);
    const reply = await startNewService(user, read.novo, { _doc: { file, mime: doc.mime, name: doc.name }, _notes: read.observacoes || null });
    if (extras.length && reply[0]?.startsWith('📝')) reply[0] += '\n' + extras.join('\n');
    return [`📄 Li o ${read.tipo || 'documento'}.`, ...reply];
  }

  // Ponto de entrada. Sempre devolve uma lista de textos para responder.
  // audio = { buffer, mime }: mensagem de voz (precisa do Gemini).
  async function handle({ phone, text = '', media = null, audio = null, doc = null }) {
    const user = findUser(phone);
    if (!user) {
      return ['Este número não está cadastrado na equipe. Peça ao responsável para te adicionar no painel.'];
    }

    let conversation = getConversation(user.id);
    // Cadastro largado pela metade há horas: começa do zero (senão "ajuda" vira resposta de pergunta velha).
    if (conversation && Date.now() - Date.parse(conversation.updated_at) > CONVERSA_VALE_MS) {
      clearConversation(user.id);
      conversation = null;
    }
    if (doc) return finish(await handleDoc(user, conversation, doc));
    let prefix = [];
    if (audio) {
      if (!ai.enabled()) return ['Por enquanto eu entendo texto e fotos. Mande *ajuda* para ver os comandos.'];
      const step = conversation && ctx.flows[conversation.flow]?.steps[conversation.step];
      const question = conversation?.flow === 'ai_confirm' ? `Mande *sim* para confirmar: ${conversation.data.text}` : step && [].concat(step.ask(conversation.data, ctx)).join('\n');
      if (!question) return finish(await askAi(user, { audio }));
      // No meio de um cadastro (ou de um "sim?"): o áudio é a resposta da pergunta.
      try {
        text = conversation?.flow === 'novo' ? await answerWithExtras(user, conversation, { audio }, question) : await ai.transcribe(audio, question);
      } catch (err) {
        ctx.log('Robô: falha no Gemini', err.message);
        return ['Não consegui ouvir o áudio agora. Tente de novo ou escreva.'];
      }
      if (!text) return ['Não entendi o áudio. Pode repetir ou escrever?'];
      prefix = [`🎤 Ouvi: "${text}"`];
    }

    // Texto comprido no meio do cadastro de serviço ("Civic prata, pegar na Alafaya, levar pra Ribas"):
    // o Gemini separa a resposta da pergunta e guarda o resto para as próximas.
    if (!audio && !media && conversation?.flow === 'novo' && ai.enabled() && simplify(text).split(/\s+/).length > 4 && !['cancelar', 'sair', 'parar'].includes(simplify(text))) {
      const step = ctx.flows.novo.steps[conversation.step];
      if (step) {
        try {
          const answer = await answerWithExtras(user, conversation, { text }, [].concat(step.ask(conversation.data, ctx)).join('\n'));
          if (answer) text = answer;
        } catch (err) {
          ctx.log('Robô: falha no Gemini', err.message);
        }
        conversation = getConversation(user.id);
      }
    }

    const simple = simplify(text);

    if (['cancelar', 'sair', 'parar'].includes(simple)) {
      clearConversation(user.id);
      return [...prefix, 'Ok, cancelado. Mande *ajuda* para ver os comandos.'];
    }

    // "oi", "bom dia": responde como gente, sem despejar a lista de comandos.
    if (GREETING.test(simple.replace(/[!.,?;]+/g, ' ').replace(/\s+/g, ' ').trim())) {
      const pending = conversation && conversation.flow !== 'ai_confirm' && ctx.flows[conversation.flow]?.steps[conversation.step];
      if (pending) return finish([...prefix, `${greeting(user)} Vamos continuar de onde paramos:`, ...[].concat(pending.ask(conversation.data, ctx))]);
      return finish([
        ...prefix,
        `${greeting(user)} Aqui é o ${ctx.config.roboNome}. Em que posso ajudar?${ai.enabled() ? ' Pode escrever ou mandar áudio do seu jeito, por exemplo: _serviço pro João, pegar na Alafaya, levar pra Ribas, 150_.' : ''}`,
      ]);
    }

    // "ajuda" no meio de um cadastro: mostra os comandos e repete a pergunta, sem perder o que já foi dito.
    if (conversation && conversation.flow !== 'ai_confirm' && ['ajuda', 'menu', 'help'].includes(simple)) {
      const step = ctx.flows[conversation.flow]?.steps[conversation.step];
      if (step) {
        return finish([...prefix, ...[].concat(await runCommand(user, 'ajuda')), 'Você está no meio do cadastro de um serviço. Responda a pergunta, ou mande *cancelar*:', ...[].concat(step.ask(conversation.data, ctx))]);
      }
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
      else if (looksLikeService(guessService(text))) reply = await startNewService(user, guessService(text));
      else reply = await withHelp(user, text, 'o Jay não entendeu', 'Não entendi. Mande *ajuda* para ver os comandos.');
    }

    return finish([...prefix, ...[].concat(reply)]);
  }

  // "Bom dia, Jean!" conforme a hora no fuso da empresa.
  function greeting(user) {
    const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: ctx.config.timeZone }).format(new Date()));
    const part = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
    return `${part}, ${String(user.name || '').split(' ')[0]}! 👋`;
  }

  const finish = (reply) => (Array.isArray(reply) ? reply : [reply]).filter(Boolean);

  // Texto com cara de serviço (ex.: a resposta da Viviane a um pedido de ajuda) vira serviço novo
  // para "user", no mesmo padrão do WhatsApp. Devolve as respostas, ou null se não é serviço.
  async function serviceFromText(user, text) {
    let novo = null;
    if (ai.enabled()) {
      try {
        const heard = await ai.understand(user, { text, situacao: situation(user) });
        if (simplify(heard.comando).split(/\s+/)[0] === 'novo') novo = heard.novo;
      } catch (err) {
        ctx.log('Robô: falha no Gemini', err.message);
      }
    }
    if (!novo) {
      const guess = guessService(text);
      if (looksLikeService(guess)) novo = guess;
    }
    if (!novo) return null;
    clearConversation(user.id);
    let reply = [].concat(await startNewService(user, novo)).filter(Boolean);
    // Quem mandou já conferiu (a Viviane): pula o que é opcional e salva sem perguntar de novo.
    // Só para se faltar algo obrigatório; aí a pergunta fica para quem vai fazer o serviço.
    for (let i = 0; i < 12; i++) {
      const conversation = getConversation(user.id);
      const step = conversation?.flow === 'novo' && ctx.flows.novo.steps[conversation.step];
      if (!step || (!step.optional && step.key !== 'confirmed')) break;
      reply = [].concat(await autoAnswer(user, await continueFlow(user, conversation, step.key === 'confirmed' ? 'sim' : 'pular'))).filter(Boolean);
    }
    return reply;
  }

  return { handle, startFlow, findUser, clearConversation, getConversation, serviceFromText };
}
