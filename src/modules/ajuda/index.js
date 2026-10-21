// Módulo de ajuda: quando o Jay não consegue resolver (não entendeu, a inteligência falhou),
// manda o pedido para a pessoa de apoio (AJUDA_TELEFONE, pedido do Caningado em 20/10: Viviane)
// conversa com ela até entender a solução, confirma, e passa a resposta para quem perguntou.
// Quem perguntou (motorista ou ADM) não ajuda: só recebe a solução (pedido do Caningado 21/10).
import { normalizePhone, formatPhone, nowIso, HttpError, simplify } from '../../lib/util.js';
import { FlowError } from '../../core/bot.js';
import { guessService, looksLikeService } from '../../lib/servico-texto.js';

const migrations = [
  `CREATE TABLE help_requests (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id),
     text TEXT NOT NULL,
     reason TEXT,
     created_at TEXT NOT NULL,
     notified_at TEXT,
     reminders INTEGER NOT NULL DEFAULT 0,
     resolved_at TEXT,
     resolved_by INTEGER REFERENCES users(id)
   );`,
  // Para quem o pedido foi (a pessoa de apoio, ou o ADM quando foi ela que travou).
  `ALTER TABLE help_requests ADD COLUMN helper_phone TEXT;`,
  // O que a pessoa de apoio fez: o Jay manda para quem pediu.
  `ALTER TABLE help_requests ADD COLUMN solution TEXT;`,
];

// De quanto em quanto tempo cobra a pessoa de apoio enquanto o pedido está aberto (Caningado pediu 2 min).
const REMIND_MS = 2 * 60000;
// Mensagens seguidas da mesma pessoa entram no mesmo pedido.
const SAME_MS = 15 * 60000;

const getSetting = (ctx, key) => ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;

// Quem ajuda: a pessoa escolhida no painel (Equipe) ou, se ninguém foi escolhido, AJUDA_TELEFONE do Render.
function helper(ctx) {
  const phone = normalizePhone(getSetting(ctx, 'ajuda_telefone') || ctx.config.ajudaTelefone);
  if (!phone) return null;
  return ctx.db.prepare('SELECT * FROM users WHERE phone = ? AND active = 1').get(phone) || { phone, name: 'apoio', missing: true };
}

const firstName = (name) => String(name || '').split(' ')[0];

async function send(ctx, phone, text) {
  try {
    if (!ctx.send) throw new Error('WhatsApp não está ligado');
    await ctx.send(phone, text);
    return null;
  } catch (err) {
    ctx.log(`Ajuda: não consegui mandar mensagem para ${formatPhone(phone)}`, err.message);
    return err.message;
  }
}

function describe(ctx, req) {
  const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(req.user_id);
  const service = user?.active_service_id ? ctx.db.prepare('SELECT id, contact_name, pickup FROM services WHERE id = ?').get(user.active_service_id) : null;
  return [
    `${user?.name || 'Alguém da equipe'} (${formatPhone(user?.phone || '')}) mandou:`,
    `"${req.text.slice(0, 1500)}"`,
    req.reason ? `Problema: ${req.reason}` : '',
    service ? `Serviço aberto dele: #${service.id}${service.contact_name ? ` – ${service.contact_name}` : ''}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// Pede ajuda. Devolve o aviso para quem estava falando com o Jay (ou null se não tem apoio configurado).
export async function askHelp(ctx, user, text, reason) {
  const h = helper(ctx);
  // A própria pessoa de apoio travou com o Jay: não tem para quem passar (o ADM não ajuda, só recebe a solução).
  if (!h || h.phone === user.phone) return null;
  if (h.missing) ctx.log(`Ajuda: ${formatPhone(h.phone)} (AJUDA_TELEFONE) não está na Equipe, o robô não consegue mandar mensagem para ela.`);
  const now = nowIso();
  const open = ctx.db
    .prepare('SELECT * FROM help_requests WHERE user_id = ? AND resolved_at IS NULL AND created_at >= ? ORDER BY id DESC')
    .get(user.id, new Date(Date.now() - SAME_MS).toISOString());
  let req;
  if (open) {
    ctx.db.prepare('UPDATE help_requests SET text = text || ? WHERE id = ?').run(`\n${text}`, open.id);
    req = ctx.db.prepare('SELECT * FROM help_requests WHERE id = ?').get(open.id);
    await send(ctx, req.helper_phone || h.phone, `➕ Mais sobre o pedido de ajuda *#${req.id}*:\n${user.name}: "${text.slice(0, 1000)}"`);
  } else {
    const info = ctx.db
      .prepare('INSERT INTO help_requests (user_id, text, reason, created_at, notified_at, helper_phone) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, text || '(sem texto)', reason || null, now, now, h.phone);
    req = ctx.db.prepare('SELECT * FROM help_requests WHERE id = ?').get(Number(info.lastInsertRowid));
    await send(ctx, h.phone, await converse(ctx, h, req, `🆘 *O Jay precisa de ajuda* (pedido #${req.id})`));
  }
  return `🙋 Não consegui resolver isso sozinho. Passei para ${firstName(h.name)} resolver, e eu te mando a solução aqui. Não precisa fazer nada.`;
}

// Texto do pedido para a pessoa de apoio: o que foi pedido e como responder.
function pedidoTexto(ctx, req, title, talking) {
  const asker = ctx.db.prepare('SELECT name FROM users WHERE id = ?').get(req.user_id);
  const how = talking
    ? `Me responda aqui (escrevendo ou por áudio) a solução, do jeito que eu devo passar para ${firstName(asker?.name)}. Se precisar fazer algo no painel, faça e me diga o que foi feito.`
    : `Quando resolver, mande *resolvido ${req.id}* e a solução (ex.: *resolvido ${req.id} cadastrei o serviço do João*). Eu passo para ${firstName(asker?.name)}.`;
  return [title, describe(ctx, req), '', how].join('\n');
}

// Abre a conversa com a pessoa de apoio sobre este pedido (se ela não estiver no meio de outra coisa com o Jay).
// Devolve a mensagem para mandar a ela.
async function converse(ctx, h, req, title) {
  const busy = h.missing || !ctx.bot?.getConversation || ctx.bot.getConversation(h.id);
  if (busy) return pedidoTexto(ctx, req, title, false);
  return [].concat(await ctx.bot.startFlow(h, 'ajuda_resposta', { reqId: req.id, title })).join('\n');
}

// Fecha o pedido e manda a solução para quem perguntou. Devolve o aviso para quem resolveu.
// made: respostas do serviço que o Jay já abriu para quem pediu (vão no lugar do texto da solução).
async function resolve(ctx, req, by, solution, { made: service = null } = {}) {
  ctx.db.prepare('UPDATE help_requests SET resolved_at = ?, resolved_by = ?, solution = ? WHERE id = ?').run(nowIso(), by.id, solution, req.id);
  const asker = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(req.user_id);
  let made = false;
  if (asker && asker.id !== by.id) {
    const asked = req.text.split('\n')[0].slice(0, 120);
    const head = `✅ *Resolvido* (sobre "${asked}${req.text.length > asked.length ? '…' : ''}")`;
    made = Boolean(service?.length);
    const error = await send(ctx, asker.phone, made ? [`${head}:`, ...service].join('\n\n') : `${head}:\n${solution}`);
    if (error) return `⚠️ Fechei o pedido #${req.id}, mas não consegui avisar ${firstName(asker.name)} (${error}). Avise por outro meio.`;
  }
  if (made) {
    const left = openRequests(ctx).length;
    return `✅ Pedido #${req.id} resolvido. Abri o serviço novo para ${firstName(asker.name)} e já avisei no WhatsApp.${left ? `\nAinda ${left === 1 ? 'falta 1 pedido' : `faltam ${left} pedidos`}: mande *ajudas* para ver.` : ''}`;
  }
  const left = openRequests(ctx).length;
  return `✅ Pedido #${req.id} resolvido. Passei a solução para ${firstName(asker?.name) || 'quem pediu'}. Obrigado!${left ? `\nAinda ${left === 1 ? 'falta 1 pedido' : `faltam ${left} pedidos`}: mande *ajudas* para ver.` : ''}`;
}

const SIM = ['sim', 's', 'ok', 'isso', 'pode', 'pode mandar', 'manda', 'certo', 'confirmo', 'yes'];

// Conversa com a pessoa de apoio: ela explica a solução, o Jay confirma e passa para quem perguntou.
const flows = {
  ajuda_resposta: {
    steps: [
      {
        key: 'answer',
        ask: (data, ctx) => {
          const req = ctx.db.prepare('SELECT * FROM help_requests WHERE id = ?').get(data.reqId);
          return req ? pedidoTexto(ctx, req, data.title || `🆘 Pedido de ajuda #${req.id}`, true) : 'Esse pedido não existe mais. Mande *cancelar*.';
        },
        parse(text, { data }) {
          const answer = String(text).replace(/^\s*resolvid[oa]\s*#?\d*\s*/i, '').replace(/^[-–:,.\s]+/, '').trim();
          if (!answer) throw new FlowError('Me diga a solução em poucas palavras, para eu passar adiante.');
          data.servico = looksLikeService(guessService(answer));
          return answer;
        },
      },
      {
        key: 'ok',
        ask: (data, ctx) => {
          const req = ctx.db.prepare('SELECT user_id FROM help_requests WHERE id = ?').get(data.reqId);
          const asker = req && ctx.db.prepare('SELECT name FROM users WHERE id = ?').get(req.user_id);
          const who = firstName(asker?.name) || 'quem pediu';
          const what = data.servico ? `Vou abrir um *serviço novo* para ${who} com isto` : `Vou mandar para ${who}`;
          return `Entendi. ${what}:\n"${data.answer}"\n\nEstá certo? Mande *sim*, ou escreva a resposta de novo.`;
        },
        parse(text, { data }) {
          if (SIM.includes(simplify(text).replace(/[!.]+$/, ''))) return true;
          data.answer = String(text).trim();
          data.servico = looksLikeService(guessService(data.answer));
          return false;
        },
        again: (data) => !data.ok,
      },
    ],
    async finish({ ctx, user, data }) {
      const req = ctx.db.prepare('SELECT * FROM help_requests WHERE id = ?').get(data.reqId);
      if (!req || req.resolved_at) return 'Esse pedido já foi resolvido. 👍';
      // Resposta com cara de serviço: o Jay abre o serviço para quem pediu. Se ainda faltar algo,
      // não pergunta ao motorista: volta a perguntar para a pessoa de apoio.
      if (data.servico) {
        const asker = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(req.user_id);
        const made = await ctx.bot.serviceFromText(asker, data.answer);
        const pending = ctx.bot.getConversation(asker.id);
        const step = pending?.flow === 'novo' && ctx.flows.novo.steps[pending.step];
        if (!made || step) {
          if (pending?.flow === 'novo') ctx.bot.clearConversation(asker.id);
          const missing = step ? [].concat(step.ask(pending.data, ctx)).join(' ') : 'não consegui ler o serviço';
          return [
            `Não consegui abrir o serviço ainda. Falta isto: ${missing}`,
            ...[].concat(await ctx.bot.startFlow(user, 'ajuda_resposta', { reqId: req.id, title: `🆘 Pedido #${req.id}: me mande o serviço completo de novo (cliente, telefone, onde pegar, para onde levar, carro e valor).` })),
          ];
        }
        data.made = made;
      }
      const done = await resolve(ctx, req, user, data.answer, { made: data.made });
      // Tem outro pedido esperando: já puxa o próximo.
      const next = openRequests(ctx).find((r) => (r.helper_phone || '') === user.phone || !r.helper_phone);
      if (!next) return done;
      return [done, '', ...[].concat(await ctx.bot.startFlow(user, 'ajuda_resposta', { reqId: next.id, title: `🆘 Próximo pedido de ajuda (#${next.id})` }))];
    },
  },
};

function openRequests(ctx) {
  return ctx.db.prepare('SELECT * FROM help_requests WHERE resolved_at IS NULL ORDER BY id').all();
}

const commands = [
  {
    names: ['resolvido', 'resolvida'],
    help: '*resolvido 3 o que foi feito* – fechar um pedido de ajuda do Jay (a solução vai para quem pediu)',
    async run({ ctx, user, args, rawArgs = '' }) {
      const h = helper(ctx);
      if (user.role !== 'dono' && h?.phone !== user.phone) return 'Só quem dá apoio (ou o ADM) fecha pedidos de ajuda.';
      const open = openRequests(ctx);
      if (!open.length) return 'Nenhum pedido de ajuda aberto. 👍';
      const id = Number(String(args[0] || '').replace('#', ''));
      const req = /^#?\d+$/.test(args[0] || '') ? open.find((r) => r.id === id) : open.length === 1 ? open[0] : null;
      if (!req) return `Qual pedido? Abertos: ${open.map((r) => `*#${r.id}*`).join(', ')}. Mande *resolvido ${open[0].id}* e o que foi feito.`;
      const solution = String(rawArgs).replace(/^\s*#?\d+\s*/, '').replace(/^[-–:,.\s]+/, '').trim();
      // Sem dizer o que foi feito, o Jay não fecha: quem pediu precisa receber a solução.
      if (!solution) {
        const asker = ctx.db.prepare('SELECT name FROM users WHERE id = ?').get(req.user_id);
        return `Me diga em poucas palavras o que foi feito, para eu passar para ${firstName(asker?.name) || 'quem pediu'}. Ex.: *resolvido ${req.id} cadastrei o serviço do João*.`;
      }
      return resolve(ctx, req, user, solution);
    },
  },
  {
    names: ['ajudas', 'pedidos'],
    help: '*ajudas* – pedidos de ajuda do Jay ainda abertos',
    run({ ctx }) {
      const open = openRequests(ctx);
      if (!open.length) return 'Nenhum pedido de ajuda aberto. 👍';
      return ['🆘 *Pedidos de ajuda abertos*', ...open.map((r) => `\n*#${r.id}* · ${describe(ctx, r)}`)].join('\n');
    },
  },
  {
    names: ['socorro', 'apoio'],
    help: '*socorro* – chamar a pessoa de apoio (ex.: *socorro não consigo lançar o serviço*)',
    async run({ ctx, user, rawArgs }) {
      const note = await askHelp(ctx, user, rawArgs || '(pediu ajuda)', 'pediu ajuda');
      return note || 'Ninguém de apoio escolhido ainda (Painel › Equipe › Quem ajuda o Jay).';
    },
  },
];

// Cobra a pessoa de apoio enquanto tem pedido aberto (roda a cada minuto).
async function minuteTick({ ctx, now = new Date() }) {
  const h = helper(ctx);
  for (const req of openRequests(ctx)) {
    const to = req.helper_phone || h?.phone;
    if (!to) continue;
    if (now.getTime() - Date.parse(req.notified_at || req.created_at) < REMIND_MS - 15000) continue;
    const mins = Math.round((now.getTime() - Date.parse(req.created_at)) / 60000);
    const waited = mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}` : `${mins} min`;
    const title = `⏰ *Pedido de ajuda #${req.id} ainda aberto* (há ${waited})`;
    const person = ctx.db.prepare('SELECT * FROM users WHERE phone = ? AND active = 1').get(to);
    const talking = person && ctx.bot?.getConversation?.(person.id);
    // Já está conversando com o Jay sobre este pedido: só repete a pergunta. Livre: abre a conversa.
    const text =
      talking?.flow === 'ajuda_resposta' && talking.data.reqId === req.id
        ? [title, ...[].concat(ctx.flows.ajuda_resposta.steps[talking.step].ask(talking.data, ctx))].join('\n')
        : person
          ? await converse(ctx, person, req, title)
          : pedidoTexto(ctx, req, title, false);
    await send(ctx, to, text);
    ctx.db.prepare('UPDATE help_requests SET notified_at = ?, reminders = reminders + 1 WHERE id = ?').run(now.toISOString(), req.id);
  }
}

// Painel › Equipe: escolher quem ajuda o Jay e mandar uma mensagem de teste para ela.
function routes(api, ctx) {
  const ownerOnly = (req) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o ADM escolhe quem ajuda o Jay.');
  };
  const current = () => {
    const h = helper(ctx);
    const fail = h && ctx.whatsappFailures?.get(h.phone);
    const recent = fail && Date.now() - fail.at < 3600000 ? fail : null;
    return {
      phone: h?.phone || null,
      user_id: h && !h.missing ? h.id : null,
      name: h && !h.missing ? h.name : null,
      missing: Boolean(h?.missing),
      // 131047 = passou de 24 h desde a última mensagem dela para o Jay.
      falha: recent ? (recent.code === 131047 ? 'janela' : recent.why) : null,
    };
  };
  api.get('/ajuda/apoio', (req, res) => {
    ownerOnly(req);
    res.json(current());
  });
  api.put('/ajuda/apoio', (req, res) => {
    ownerOnly(req);
    const id = Number(req.body?.user_id) || null;
    const user = id ? ctx.db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(id) : null;
    if (id && !user) throw new HttpError(404, 'Pessoa não encontrada na equipe.');
    ctx.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('ajuda_telefone', user ? user.phone : '');
    res.json(current());
  });
  api.post('/ajuda/teste', async (req, res) => {
    ownerOnly(req);
    const h = helper(ctx);
    if (!h || h.missing) throw new HttpError(400, 'Escolha antes quem ajuda o Jay.');
    ctx.whatsappFailures?.delete(h.phone);
    const error = await send(ctx, h.phone, `🆘 *Teste do pedido de ajuda*\n${firstName(req.user.name)} está testando: quando o Jay não conseguir resolver algo, ele vai pedir ajuda aqui. Não precisa responder.`);
    res.json({ ok: !error, error, name: h.name });
  });
}

export default {
  name: 'ajuda',
  label: 'Ajuda (apoio)',
  migrations,
  commands,
  flows,
  routes,
  minuteTick,
  setup(ctx) {
    ctx.api.ajuda = { pedir: (user, text, reason) => askHelp(ctx, user, text, reason) };
  },
};
