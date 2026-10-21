// Módulo de ajuda: quando o Jay não consegue resolver (não entendeu, a inteligência falhou),
// manda o pedido para a pessoa de apoio (AJUDA_TELEFONE, pedido do Caningado em 20/10: Viviane)
// e cobra de tempos em tempos até ela mandar *resolvido*.
import { normalizePhone, formatPhone, nowIso, HttpError } from '../../lib/util.js';

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
  let h = helper(ctx);
  // A própria pessoa de apoio travou com o Jay: o pedido vai para o ADM.
  if (h && h.phone === user.phone) h = ctx.db.prepare("SELECT * FROM users WHERE role = 'dono' AND active = 1 AND id <> ? ORDER BY id").get(user.id);
  if (!h) return null;
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
    await send(ctx, h.phone, [`🆘 *O Jay precisa de ajuda* (pedido #${req.id})`, describe(ctx, req), '', `Resolva (no painel ou falando com ${firstName(user.name)}) e depois mande *resolvido ${req.id}* aqui.`].join('\n'));
  }
  return `🙋 Já chamei ${firstName(h.name)} para ajudar com isso. Você recebe um aviso quando for resolvido.`;
}

function openRequests(ctx) {
  return ctx.db.prepare('SELECT * FROM help_requests WHERE resolved_at IS NULL ORDER BY id').all();
}

const commands = [
  {
    names: ['resolvido', 'resolvida'],
    help: '*resolvido 3* – fechar um pedido de ajuda do Jay',
    async run({ ctx, user, args }) {
      const h = helper(ctx);
      if (user.role !== 'dono' && h?.phone !== user.phone) return 'Só quem dá apoio (ou o ADM) fecha pedidos de ajuda.';
      const open = openRequests(ctx);
      if (!open.length) return 'Nenhum pedido de ajuda aberto. 👍';
      const id = Number(String(args[0] || '').replace('#', ''));
      const req = id ? open.find((r) => r.id === id) : open.length === 1 ? open[0] : null;
      if (!req) return `Qual pedido? Abertos: ${open.map((r) => `*#${r.id}*`).join(', ')}. Mande *resolvido ${open[0].id}*.`;
      ctx.db.prepare('UPDATE help_requests SET resolved_at = ?, resolved_by = ? WHERE id = ?').run(nowIso(), user.id, req.id);
      const asker = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(req.user_id);
      if (asker && asker.id !== user.id) await send(ctx, asker.phone, `✅ ${firstName(user.name)} resolveu o seu pedido de ajuda (#${req.id}).`);
      const left = open.length - 1;
      return `✅ Pedido #${req.id} resolvido. Obrigado!${left ? `\nAinda ${left === 1 ? 'falta 1 pedido' : `faltam ${left} pedidos`}: mande *ajudas* para ver.` : ''}`;
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
    await send(ctx, to, [`⏰ *Pedido de ajuda #${req.id} ainda aberto* (há ${waited})`, describe(ctx, req), '', `Quando resolver, mande *resolvido ${req.id}*.`].join('\n'));
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
  routes,
  minuteTick,
  setup(ctx) {
    ctx.api.ajuda = { pedir: (user, text, reason) => askHelp(ctx, user, text, reason) };
  },
};
