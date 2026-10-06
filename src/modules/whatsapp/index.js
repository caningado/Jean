// Módulo WhatsApp: liga o robô à API oficial do WhatsApp Business (Meta Cloud API).
// Recebe as mensagens da equipe pelo webhook, passa para o robô e manda as respostas.
import crypto from 'node:crypto';
import express from 'express';
import { normalizePhone, nowIso, formatPhone } from '../../lib/util.js';

const migrations = [
  `CREATE TABLE whatsapp_messages (
     id TEXT PRIMARY KEY,
     phone TEXT,
     received_at TEXT NOT NULL
   );`,
];

export function createWhatsAppClient(config, fetchImpl = fetch) {
  const { token, phoneNumberId, apiVersion } = config.whatsapp;
  const base = `https://graph.facebook.com/${apiVersion}`;
  const headers = { Authorization: `Bearer ${token}` };

  return {
    configured: Boolean(token && phoneNumberId),

    async sendText(to, body) {
      const res = await fetchImpl(`${base}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: normalizePhone(to), type: 'text', text: { body: body.slice(0, 4096) } }),
      });
      if (!res.ok) throw new Error(`WhatsApp respondeu ${res.status}: ${await res.text()}`);
      return true;
    },

    async downloadMedia(mediaId) {
      const meta = await fetchImpl(`${base}/${mediaId}`, { headers });
      if (!meta.ok) throw new Error(`Falha ao buscar mídia ${mediaId}: ${meta.status}`);
      const { url, mime_type } = await meta.json();
      const file = await fetchImpl(url, { headers });
      if (!file.ok) throw new Error(`Falha ao baixar mídia ${mediaId}: ${file.status}`);
      return { buffer: Buffer.from(await file.arrayBuffer()), mime: mime_type };
    },
  };
}

// Confere se a mensagem veio mesmo da Meta (assinatura com o App Secret).
export function validSignature(rawBody, header, appSecret) {
  if (!appSecret) return true;
  if (!header?.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return expected.length === header.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}

// Tira do formato da Meta só o que interessa: quem mandou, texto e mídia.
export function extractMessages(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages || []) {
        const msg = { id: m.id, from: m.from, name: names[m.from] || null, type: m.type, text: '', mediaId: null };
        if (m.type === 'text') msg.text = m.text?.body || '';
        else if (m.type === 'image') {
          msg.mediaId = m.image?.id;
          msg.text = m.image?.caption || '';
        } else if (m.type === 'document' && m.document?.mime_type?.startsWith('image/')) {
          msg.mediaId = m.document.id;
          msg.text = m.document.caption || '';
        } else if (m.type === 'button') msg.text = m.button?.text || '';
        else if (m.type === 'interactive') msg.text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '';
        out.push(msg);
      }
    }
  }
  return out;
}

export async function processMessage(ctx, client, msg) {
  // A Meta às vezes entrega a mesma mensagem duas vezes.
  const seen = ctx.db.prepare('INSERT OR IGNORE INTO whatsapp_messages (id, phone, received_at) VALUES (?, ?, ?)').run(msg.id, msg.from, nowIso());
  if (!Number(seen.changes)) return;

  const user = ctx.bot.findUser(msg.from);
  if (!user) return handleOutsider(ctx, client, msg);

  let media = null;
  if (msg.mediaId) media = await client.downloadMedia(msg.mediaId);
  else if (!msg.text) {
    await client.sendText(msg.from, 'Por enquanto eu entendo texto e fotos. Mande *ajuda* para ver os comandos.');
    return;
  }

  const replies = await ctx.bot.handle({ phone: msg.from, text: msg.text, media });
  for (const reply of replies) await client.sendText(msg.from, reply);
}

// Alguém de fora da equipe (um cliente) mandou mensagem: guarda o contato e avisa os donos.
async function handleOutsider(ctx, client, msg) {
  const contact = ctx.data.contacts.findOrCreate({ phone: msg.from, name: msg.name, source: 'whatsapp' });
  const owners = ctx.db.prepare("SELECT * FROM users WHERE role = 'dono' AND active = 1").all();
  const text = msg.text || (msg.mediaId ? '[foto]' : `[${msg.type}]`);
  for (const owner of owners) {
    await client.sendText(owner.phone, `📩 Mensagem de ${contact.name} (${formatPhone(contact.phone)}):\n${text}`);
  }
  await client.sendText(
    msg.from,
    `Thanks for contacting ${ctx.config.companyName}! We'll get back to you shortly.\nObrigado pela mensagem! Já vamos te responder.`
  );
}

function publicRoutes(app, ctx) {
  const { verifyToken, appSecret } = ctx.config.whatsapp;
  const client = ctx.api.whatsapp.client;

  // A Meta chama isto uma vez para confirmar o webhook.
  app.get('/webhook/whatsapp', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && verifyToken && req.query['hub.verify_token'] === verifyToken) {
      return res.status(200).send(String(req.query['hub.challenge'] || ''));
    }
    res.sendStatus(403);
  });

  app.post('/webhook/whatsapp', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!validSignature(raw, req.headers['x-hub-signature-256'], appSecret)) return res.sendStatus(401);
    // Responde logo para a Meta não reenviar; o processamento continua em seguida.
    res.sendStatus(200);
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    for (const msg of extractMessages(payload)) {
      processMessage(ctx, client, msg).catch((err) => ctx.log('Erro ao processar mensagem do WhatsApp', err));
    }
  });
}

export default {
  name: 'whatsapp',
  label: 'WhatsApp',
  migrations,
  publicRoutes,
  setup(ctx) {
    const client = createWhatsAppClient(ctx.config);
    ctx.api.whatsapp = { client };
    if (client.configured) {
      ctx.send = (to, text) => client.sendText(to, text);
    } else {
      ctx.log('WhatsApp não configurado (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID). Use o simulador no painel.');
    }
  },
};
