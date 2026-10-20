// Módulo WhatsApp: liga o robô à API oficial do WhatsApp Business (Meta Cloud API).
// Recebe as mensagens da equipe pelo webhook, passa para o robô e manda as respostas.
import crypto from 'node:crypto';
import express from 'express';
import { normalizePhone, nowIso, formatPhone } from '../../lib/util.js';
import { speak, toOgg, textoParaFala, MAX_FALA } from '../../lib/tts.js';

const migrations = [
  `CREATE TABLE whatsapp_messages (
     id TEXT PRIMARY KEY,
     phone TEXT,
     received_at TEXT NOT NULL
   );`,
];

// isTeam(telefone): o robô só manda mensagem para quem é da equipe (ADM ou motorista ativo).
export function createWhatsAppClient(config, fetchImpl = fetch, { isTeam = () => false } = {}) {
  const { token, phoneNumberId, apiVersion } = config.whatsapp;
  const base = `https://graph.facebook.com/${apiVersion}`;
  const headers = { Authorization: `Bearer ${token}` };

  return {
    configured: Boolean(token && phoneNumberId),

    async sendText(to, body) {
      // Trava: nunca fala com cliente nem com ninguém de fora da equipe.
      if (!isTeam(to)) throw new Error(`Bloqueado: ${formatPhone(to)} não é da equipe, o robô não manda mensagem para fora.`);
      const res = await fetchImpl(`${base}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: normalizePhone(to), type: 'text', text: { body: body.slice(0, 4096) } }),
      });
      if (!res.ok) throw new Error(`WhatsApp respondeu ${res.status}: ${await res.text()}`);
      return true;
    },

    // Mensagem de voz (.ogg Opus): sobe o arquivo na Meta e manda como áudio.
    async sendAudio(to, ogg) {
      if (!isTeam(to)) throw new Error(`Bloqueado: ${formatPhone(to)} não é da equipe, o robô não manda mensagem para fora.`);
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', 'audio/ogg');
      form.append('file', new Blob([ogg], { type: 'audio/ogg' }), 'voz.ogg');
      const up = await fetchImpl(`${base}/${phoneNumberId}/media`, { method: 'POST', headers, body: form });
      if (!up.ok) throw new Error(`WhatsApp (subir áudio) respondeu ${up.status}: ${await up.text()}`);
      const { id } = await up.json();
      const res = await fetchImpl(`${base}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: normalizePhone(to), type: 'audio', audio: { id } }),
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
        } else if (m.type === 'document' && m.document?.id) {
          // PDF (gate pass, pedido de serviço): o robô lê e abre o serviço.
          msg.mediaId = m.document.id;
          msg.doc = { name: m.document.filename || '', mime: m.document.mime_type || '' };
        } else if (m.type === 'audio' && m.audio?.id) {
          // Mensagem de voz: o robô entende com o Gemini.
          msg.mediaId = m.audio.id;
          msg.audio = true;
        } else if (m.type === 'location' && m.location) {
          // Localização 📍 mandada pelo WhatsApp: vira texto com nome, endereço e coordenadas.
          const { latitude, longitude, name, address } = m.location;
          const label = [name, address].filter(Boolean).join(', ');
          msg.text = `${label ? label + ' ' : ''}(${latitude}, ${longitude})`;
        } else if (m.type === 'contacts' && m.contacts?.length) {
          // Cartão de contato (o cliente que mandou o serviço): vira texto com nome e telefone.
          msg.text = m.contacts
            .map((c) => {
              const phone = c.phones?.find((p) => p.wa_id)?.wa_id || c.phones?.[0]?.phone || '';
              return `Contato do cliente: ${c.name?.formatted_name || [c.name?.first_name, c.name?.last_name].filter(Boolean).join(' ') || 'sem nome'}${phone ? ` ${phone}` : ''}`;
            })
            .join('\n');
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
  if (!user) {
    ctx.log(`WhatsApp: mensagem de ${formatPhone(msg.from)}, que não está em Mais › Equipe (o robô não responde).`);
    return handleOutsider(ctx, client, msg);
  }
  ctx.log(`WhatsApp: mensagem de ${user.name} (${formatPhone(msg.from)}), tipo ${msg.type}.`);

  if (!msg.audio && !msg.mediaId) {
    if (!msg.text) {
      await client.sendText(msg.from, 'Por enquanto eu entendo texto, áudio e fotos. Mande *ajuda* para ver os comandos.');
      return;
    }
    return queueText(ctx, client, user, msg);
  }
  // Foto ou áudio: antes, responde os textos que estavam esperando (a ordem importa).
  await flushTexts(ctx, client, msg.from);
  const file = await client.downloadMedia(msg.mediaId);
  if (msg.doc) {
    const mime = String(file?.mime || msg.doc.mime).split(';')[0].trim().toLowerCase();
    return answer(ctx, client, user, { phone: msg.from, doc: { buffer: file?.buffer, mime, name: msg.doc.name } });
  }
  await answer(ctx, client, user, { phone: msg.from, text: msg.text, media: msg.audio ? null : file, audio: msg.audio ? file : null });
}

async function answer(ctx, client, user, input) {
  const replies = await ctx.bot.handle(input);
  for (const reply of replies) await client.sendText(input.phone, reply);
  ctx.log(`WhatsApp: ${replies.length} resposta(s) enviada(s) para ${user.name}.`);
  // Quem mandou áudio recebe a resposta também em áudio (o texto continua indo, para quem prefere ler).
  if (input.audio) await replyByVoice(ctx, client, input.phone, replies);
}

// Textos que chegam em sequência (várias mensagens encaminhadas de uma vez, o cartão do contato,
// o valor digitado logo depois) esperam uns segundos e vão juntos para o robô, como uma mensagem só.
const waiting = new WeakMap();
function queueText(ctx, client, user, msg) {
  const wait = ctx.config.whatsapp.juntarMs;
  if (!(wait > 0)) return answer(ctx, client, user, { phone: msg.from, text: msg.text });
  if (!waiting.has(ctx)) waiting.set(ctx, new Map());
  const byPhone = waiting.get(ctx);
  let batch = byPhone.get(msg.from);
  if (!batch) {
    batch = { user, texts: [], done: [] };
    byPhone.set(msg.from, batch);
  }
  batch.texts.push(msg.text);
  clearTimeout(batch.timer);
  batch.timer = setTimeout(() => flushTexts(ctx, client, msg.from).catch((err) => ctx.log('Erro ao processar mensagem do WhatsApp', err)), wait);
  return new Promise((resolve) => batch.done.push(resolve));
}

async function flushTexts(ctx, client, phone) {
  const batch = waiting.get(ctx)?.get(phone);
  if (!batch) return;
  waiting.get(ctx).delete(phone);
  clearTimeout(batch.timer);
  try {
    if (batch.texts.length > 1) ctx.log(`WhatsApp: ${batch.texts.length} mensagens de ${batch.user.name} juntas numa só.`);
    await answer(ctx, client, batch.user, { phone, text: batch.texts.join('\n') });
  } finally {
    batch.done.forEach((resolve) => resolve());
  }
}

export async function replyByVoice(ctx, client, to, replies, voice = { speak, toOgg }) {
  if (!ctx.config.roboVoz || !ctx.config.geminiApiKey || !client.sendAudio) return;
  const fala = textoParaFala(replies.join('\n'));
  if (!fala || fala.length > MAX_FALA) return;
  try {
    await client.sendAudio(to, await voice.toOgg(await voice.speak(ctx, fala)));
  } catch (err) {
    ctx.log('WhatsApp: não consegui responder em áudio', err.message);
  }
}

// Alguém de fora da equipe (cliente, amigo) mandou mensagem: só guarda o contato.
// O robô nunca responde: quem fala com cliente é o dono, pelo app WhatsApp Business.
export async function handleOutsider(ctx, client, msg) {
  ctx.data.contacts.findOrCreate({ phone: msg.from, name: msg.name, source: 'whatsapp' });
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
    if (!validSignature(raw, req.headers['x-hub-signature-256'], appSecret)) {
      ctx.log('WhatsApp: chegou mensagem com assinatura errada. Confira o WHATSAPP_APP_SECRET no Render (App settings › Basic › App secret).');
      return res.sendStatus(401);
    }
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
    const client = createWhatsAppClient(ctx.config, fetch, { isTeam: (phone) => Boolean(ctx.bot.findUser(phone)) });
    ctx.api.whatsapp = { client };
    if (client.configured) {
      ctx.send = (to, text) => client.sendText(to, text);
    } else {
      ctx.log('WhatsApp não configurado (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID). Use o simulador no painel.');
    }
  },
};
