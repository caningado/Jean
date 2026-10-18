// Notificação no celular quando entra serviço, mesmo com o app fechado (Web Push).
// Cada aparelho ativa uma vez no painel ("Ativar notificações"). O motorista recebe quando um
// serviço é dado para ele; o ADM, quando entra qualquer serviço. Quem fez a ação não recebe.
// No iPhone, só funciona com o app instalado na tela inicial (iOS 16.4 ou mais novo).
import webpush from 'web-push';
import { HttpError, nowIso } from '../../lib/util.js';

const getSetting = (ctx, key) => ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
const setSetting = (ctx, key, value) =>
  ctx.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

// As chaves do servidor são criadas uma vez e ficam no banco: trocar invalidaria todos os aparelhos.
function vapidKeys(ctx) {
  const saved = getSetting(ctx, 'vapid_keys');
  if (saved) return JSON.parse(saved);
  const keys = webpush.generateVAPIDKeys();
  setSetting(ctx, 'vapid_keys', JSON.stringify(keys));
  return keys;
}

// Para quem vai o aviso: o motorista que recebeu o serviço e, se o serviço é novo, todos os ADM.
function recipients(ctx, { type, service, by }) {
  const ids = new Set();
  if (service.driver_id) ids.add(service.driver_id);
  if (type === 'novo') for (const u of ctx.db.prepare("SELECT id FROM users WHERE role = 'dono' AND active = 1").all()) ids.add(u.id);
  ids.delete(by);
  return [...ids];
}

function message(ctx, service, userId) {
  const user = ctx.data.users.get(userId);
  const ref = ctx.data.services.ref(service, user);
  const who = service.contact_name || service.vehicle || '';
  const where = service.pickup ? ` · ${service.pickup}` : '';
  return {
    title: '🔔 Serviço novo',
    body: `#${ref}${who ? ` ${who}` : ''}${where}`.slice(0, 180),
    url: `/#/servico/${service.id}`,
    tag: `servico-${service.id}`,
  };
}

async function send(ctx, event) {
  const users = recipients(ctx, event);
  if (!users.length) return;
  const subs = ctx.db.prepare(`SELECT * FROM push_subs WHERE user_id IN (${users.map(() => '?').join(',')})`).all(...users);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await ctx.push(
          { endpoint: sub.endpoint, keys: JSON.parse(sub.keys) },
          JSON.stringify(message(ctx, event.service, sub.user_id)),
          { TTL: 3600, urgency: 'high', topic: `servico-${event.service.id}`.slice(0, 32) }
        );
      } catch (err) {
        // Aparelho que desativou ou desinstalou: o endereço não vale mais.
        if (err.statusCode === 404 || err.statusCode === 410) ctx.db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(sub.endpoint);
        else console.error('Notificação não enviada:', err.statusCode || err.message);
      }
    })
  );
}

export default {
  name: 'notificacoes',
  label: 'Notificações',
  migrations: [
    `CREATE TABLE push_subs (
       endpoint TEXT PRIMARY KEY,
       user_id INTEGER NOT NULL REFERENCES users(id),
       keys TEXT NOT NULL,
       created_at TEXT NOT NULL
     );`,
  ],

  setup(ctx) {
    const keys = vapidKeys(ctx);
    ctx.vapidPublicKey = keys.publicKey;
    // Nos testes, ctx.push pode vir pronto (sem mandar nada para a internet).
    ctx.push ||= (sub, payload, opts) =>
      webpush.sendNotification(sub, payload, { ...opts, vapidDetails: { subject: 'mailto:towing.jj.llc@gmail.com', ...keys } });
    ctx.data.services.onEvent((event) => {
      send(ctx, event).catch((err) => console.error('Notificação:', err.message));
    });
  },

  routes(api, ctx) {
    api.get('/push/chave', (req, res) => res.json({ key: ctx.vapidPublicKey }));
    api.post('/push/assinar', (req, res) => {
      const { endpoint, keys } = req.body || {};
      if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || !keys?.p256dh || !keys?.auth) throw new HttpError(400, 'Aparelho inválido.');
      ctx.db
        .prepare(
          `INSERT INTO push_subs (endpoint, user_id, keys, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys`
        )
        .run(endpoint, req.user.id, JSON.stringify({ p256dh: keys.p256dh, auth: keys.auth }), nowIso());
      res.json({ ok: true });
    });
    api.post('/push/cancelar', (req, res) => {
      ctx.db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').run(String(req.body?.endpoint || ''), req.user.id);
      res.json({ ok: true });
    });
    // Manda um aviso de teste para os aparelhos da própria pessoa.
    api.post('/push/teste', async (req, res) => {
      const subs = ctx.db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(req.user.id);
      if (!subs.length) throw new HttpError(400, 'Este aparelho ainda não ativou as notificações.');
      let sent = 0;
      for (const sub of subs) {
        try {
          await ctx.push({ endpoint: sub.endpoint, keys: JSON.parse(sub.keys) }, JSON.stringify({ title: '🔔 Teste', body: 'As notificações estão funcionando.', url: '/#/servicos', tag: 'teste' }), { TTL: 600 });
          sent++;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) ctx.db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(sub.endpoint);
        }
      }
      res.json({ sent });
    });
  },
};
