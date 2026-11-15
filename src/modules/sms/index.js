// Módulo SMS: o Jay também atende por mensagem de texto comum (SMS/MMS), pela Twilio.
// É para quem da equipe não usa WhatsApp. Usa os mesmos comandos, texto livre, fotos, áudio e PDF
// (o caminho é o mesmo do WhatsApp: processMessage). Como no WhatsApp, o Jay só conversa com a
// equipe (Menu › Equipe); cliente que mandar SMS não recebe resposta, só fica guardado nos contatos.
//
// Avisos do sistema (serviço na fila, cobrança, aviso da manhã) vão pelo canal que a pessoa usou
// por último: mandou SMS, recebe por SMS; voltou a mandar no WhatsApp, volta para o WhatsApp.
//
// Jay único (várias empresas, no futuro): a Twilio diz para qual número do Jay a mensagem foi (msg.to)
// e quem mandou (msg.from). Quem é a pessoa (e, no futuro, de qual empresa) sai de ctx.bot.findUser,
// o mesmo lugar que o WhatsApp usa, então os dois canais mudam juntos.
import crypto from 'node:crypto';
import express from 'express';
import { normalizePhone, formatPhone, nowIso } from '../../lib/util.js';
import { processMessage, FLOOD_MAX, FLOOD_MS } from '../whatsapp/index.js';

const migrations = [
  `CREATE TABLE sms_messages (
     id TEXT PRIMARY KEY,
     phone TEXT,
     received_at TEXT NOT NULL
   );
   CREATE TABLE user_channels (
     user_id INTEGER PRIMARY KEY,
     canal TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
];

// A Twilio aceita até 1600 letras por mensagem (ela mesma divide em partes de SMS).
export const SMS_MAX = 1600;

// SMS não tem negrito nem itálico: tira os *asteriscos* e _sublinhados_ que o WhatsApp usa.
export function paraSms(text) {
  return String(text || '')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/gm, '$1$2')
    .replace(/(^|[\s(])~([^~\n]+)~(?=$|[\s).,!?:;])/gm, '$1$2')
    .trim();
}

// Texto comprido vira várias mensagens, cortando de preferência numa quebra de linha.
export function partes(text, max = SMS_MAX) {
  const out = [];
  let rest = String(text || '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

export function createSmsClient(config, fetchImpl = fetch, { isTeam = () => false, log = () => {}, now = () => Date.now() } = {}) {
  const { sid, token, from, messagingServiceSid } = config.sms;
  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
  const recent = new Map();
  const warned = new Map();
  // Mesma trava do WhatsApp: no máximo FLOOD_MAX mensagens para o mesmo número em 10 minutos.
  const guard = (phone) => {
    const t = now();
    const list = (recent.get(phone) || []).filter((at) => t - at < FLOOD_MS);
    if (list.length >= FLOOD_MAX) {
      recent.set(phone, list);
      if (!warned.has(phone) || t - warned.get(phone) > FLOOD_MS) {
        warned.set(phone, t);
        log(`SMS: TRAVA – já mandei ${list.length} mensagens para ${formatPhone(phone)} em 10 min. Parei de mandar para esse número por um tempo.`);
      }
      throw new Error(`Trava: muitas mensagens seguidas para ${formatPhone(phone)}.`);
    }
    list.push(t);
    recent.set(phone, list);
  };

  return {
    canal: 'sms',
    configured: Boolean(sid && token && (from || messagingServiceSid)),

    async sendText(to, body) {
      // Trava: nunca fala com cliente nem com ninguém de fora da equipe.
      if (!isTeam(to)) throw new Error(`Bloqueado: ${formatPhone(to)} não é da equipe, o robô não manda mensagem para fora.`);
      const phone = normalizePhone(to);
      for (const part of partes(paraSms(body))) {
        guard(phone);
        const form = new URLSearchParams({ To: '+' + phone, Body: part });
        if (messagingServiceSid) form.set('MessagingServiceSid', messagingServiceSid);
        else form.set('From', from.startsWith('+') ? from : '+' + normalizePhone(from));
        const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        });
        if (!res.ok) throw new Error(`Twilio respondeu ${res.status}: ${await res.text()}`);
      }
      return true;
    },

    // Foto, áudio ou PDF mandado por MMS: a Twilio guarda e manda o link (precisa da senha da conta).
    async downloadMedia(url) {
      const res = await fetchImpl(url, { headers: { Authorization: auth } });
      if (!res.ok) throw new Error(`Falha ao baixar o arquivo do MMS: ${res.status}`);
      return { buffer: Buffer.from(await res.arrayBuffer()), mime: (res.headers.get('content-type') || '').split(';')[0].trim() };
    },
  };
}

// Confere se o pedido veio mesmo da Twilio (assinatura feita com o Auth Token).
export function validTwilioSignature(url, params, header, token) {
  if (!token || !header) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
  return expected.length === header.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}

// Cartão de contato (.vcf) mandado por MMS: vira texto igual ao do WhatsApp.
export function vcardParaTexto(vcf) {
  const cards = String(vcf || '').split(/BEGIN:VCARD/i).slice(1);
  return cards
    .map((card) => {
      const name = card.match(/^FN[^:\n]*:(.+)$/im)?.[1]?.trim() || 'sem nome';
      const phone = card.match(/^TEL[^:\n]*:(.+)$/im)?.[1]?.trim() || '';
      return `Contato do cliente: ${name}${phone ? ` ${phone}` : ''}`;
    })
    .join('\n');
}

// Tira do formato da Twilio só o que interessa. Cada foto/arquivo do MMS vira uma mensagem
// (o texto vai junto da primeira), igual ao WhatsApp, que manda uma de cada vez.
export function extractSms(body = {}) {
  const base = { from: normalizePhone(body.From), to: normalizePhone(body.To), name: null };
  const id = body.MessageSid || body.SmsSid || `sms-${Date.now()}`;
  const text = String(body.Body || '').trim();
  const count = Math.min(Number(body.NumMedia) || 0, 10);
  if (!count) return [{ ...base, id, type: 'text', text, mediaId: null }];
  const out = [];
  for (let i = 0; i < count; i++) {
    const url = body[`MediaUrl${i}`];
    const mime = String(body[`MediaContentType${i}`] || '').toLowerCase();
    if (!url) continue;
    const msg = { ...base, id: i ? `${id}-${i}` : id, type: 'image', text: i ? '' : text, mediaId: url };
    if (mime.startsWith('audio/')) Object.assign(msg, { type: 'audio', audio: true });
    else if (mime.includes('vcard')) Object.assign(msg, { type: 'contacts', vcard: true });
    else if (!mime.startsWith('image/')) Object.assign(msg, { type: 'document', doc: { name: mime === 'application/pdf' ? 'arquivo.pdf' : '', mime } });
    out.push(msg);
  }
  return out.length ? out : [{ ...base, id, type: 'text', text, mediaId: null }];
}

export async function processSms(ctx, client, msg) {
  if (msg.vcard) {
    // O cartão de contato vira texto antes (o Jay junta com o resto do serviço).
    const file = await client.downloadMedia(msg.mediaId);
    const contato = vcardParaTexto(file.buffer.toString('utf8'));
    msg = { ...msg, type: 'text', vcard: false, mediaId: null, text: [msg.text, contato].filter(Boolean).join('\n') };
  }
  return processMessage(ctx, client, msg);
}

function publicRoutes(app, ctx) {
  // Endereço que a Twilio chamou (é com ele que ela assina). Atrás do Render o pedido chega como http.
  const urls = (req) => {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim();
    return [...new Set([ctx.config.publicUrl && ctx.config.publicUrl + req.originalUrl, `https://${host}${req.originalUrl}`, `${proto}://${host}${req.originalUrl}`].filter(Boolean))];
  };

  app.post('/webhook/sms', express.urlencoded({ extended: false, limit: '1mb' }), (req, res) => {
    const client = ctx.api.sms.client;
    if (!client.configured) {
      ctx.log('SMS: chegou mensagem, mas a Twilio não está configurada (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN e TWILIO_NUMERO no Render).');
      return res.sendStatus(503);
    }
    const params = req.body && typeof req.body === 'object' ? req.body : {};
    const header = req.headers['x-twilio-signature'];
    if (!urls(req).some((url) => validTwilioSignature(url, params, header, ctx.config.sms.token))) {
      ctx.log('SMS: chegou mensagem com assinatura errada. Confira o TWILIO_AUTH_TOKEN no Render e o endereço do webhook na Twilio.');
      return res.sendStatus(403);
    }
    // Responde logo (sem texto: as respostas vão pela API, podem ser várias e demorar).
    res.type('text/xml').send('<Response></Response>');
    for (const msg of extractSms(params)) {
      processSms(ctx, client, msg).catch((err) => ctx.log('Erro ao processar SMS', err));
    }
  });
}

export default {
  name: 'sms',
  label: 'SMS',
  migrations,
  publicRoutes,
  setup(ctx) {
    const db = ctx.db;
    // Por qual canal mandar avisos para cada pessoa (o último que ela usou). Sem registro = WhatsApp.
    const canais = {
      mark(userId, canal) {
        db.prepare('INSERT INTO user_channels (user_id, canal, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET canal = excluded.canal, updated_at = excluded.updated_at').run(userId, canal, nowIso());
      },
      of(phone) {
        const user = ctx.bot?.findUser(phone);
        if (!user) return null;
        return db.prepare('SELECT canal FROM user_channels WHERE user_id = ?').get(user.id)?.canal || 'whatsapp';
      },
    };
    ctx.api.canais = canais;

    const client = createSmsClient(ctx.config, fetch, { isTeam: (phone) => Boolean(ctx.bot.findUser(phone)), log: (...a) => ctx.log(...a) });
    ctx.api.sms = { client };
    if (!client.configured) return;

    const whatsOn = Boolean(ctx.api.whatsapp?.client?.configured);
    const viaWhats = ctx.send;
    const fotoWhats = ctx.sendImage;
    const porSms = (to) => !whatsOn || canais.of(to) === 'sms';
    ctx.send = (to, text) => (porSms(to) ? client.sendText(to, text) : viaWhats(to, text));
    // Foto não vai por SMS (precisaria de um link público): manda só a legenda e avisa que está no painel.
    ctx.sendImage = (to, buffer, mime, caption) =>
      porSms(to) ? client.sendText(to, `📷 ${caption || 'Foto'}\n(A foto está no painel.)`) : fotoWhats ? fotoWhats(to, buffer, mime, caption) : false;
  },
};
