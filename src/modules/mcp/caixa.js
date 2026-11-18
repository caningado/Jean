// Caixa de entrada do Jay: guarda uma CÓPIA do que o dono manda para o Jay no WhatsApp
// (textos, localizações, contatos, legendas de foto), para o Claude ler depois e organizar
// junto com o dono. O Jay continua respondendo igual; a caixa só observa.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { nowIso } from '../../lib/util.js';
import { mapLink } from '../../lib/validate.js';
import { imageForClaude } from '../../lib/imagem.js';
import { logAction } from './tools.js';

export const caixaMigrations = [
  `CREATE TABLE jay_inbox (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id),
     wa_id TEXT UNIQUE,
     type TEXT NOT NULL,
     text TEXT,
     latitude REAL,
     longitude REAL,
     created_at TEXT NOT NULL,
     done_at TEXT,
     service_id INTEGER
   );
   CREATE INDEX jay_inbox_open ON jay_inbox(done_at, id);`,
  // Foto que o dono mandou: o arquivo fica guardado para o Claude ver.
  `ALTER TABLE jay_inbox ADD COLUMN file TEXT;
   ALTER TABLE jay_inbox ADD COLUMN mime TEXT;`,
  // A foto já foi anexada ao serviço (photos.id), para não anexar duas vezes.
  `ALTER TABLE jay_inbox ADD COLUMN photo_id INTEGER;`,
];

const PHOTO_DIR = 'caixa';
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_IMAGE = 8 * 1024 * 1024;

const KIND = { image: 'foto', document: 'arquivo', audio: 'áudio', location: 'localização', contacts: 'contato', text: 'texto' };

// Só guardar (sem o Jay criar serviço) vale para texto, localização e cartão de contato do dono,
// fora de uma conversa com o Jay e sem ser comando. JAY_CAIXA=off volta ao jeito antigo.
const HOLD_TYPES = ['text', 'location', 'contacts'];
const RECEIPT_MS = 60 * 1000;

export function createCaixa(ctx) {
  const lastReceipt = new Map();
  return {
    holds(user, msg) {
      if (ctx.config.mcp?.jayCaixa === false || user.role !== 'dono') return false;
      if (!HOLD_TYPES.includes(msg.type) || msg.mediaId || msg.audio || !msg.text) return false;
      if (ctx.bot.getConversation(user.id)) return false;
      if (ctx.bot.isCommand(msg.text)) return false;
      return true;
    },
    // "Guardei" uma vez por rajada de mensagens (encaminhar 5 mensagens não gera 5 respostas).
    receipt(user) {
      const now = Date.now();
      const last = lastReceipt.get(user.id) || 0;
      lastReceipt.set(user.id, now);
      if (now - last < RECEIPT_MS) return null;
      return '📥 Guardei na caixa de entrada. Quando quiser, peça ao Claude para organizar e criar o serviço.';
    },
    // Guarda o arquivo da foto na mensagem já salva (só imagem, só do dono).
    attachMedia(user, msg, file) {
      if (user.role !== 'dono' || !file?.buffer || !msg.id) return false;
      const mime = String(file.mime || '').split(';')[0].trim().toLowerCase();
      const ext = IMAGE_TYPES[mime];
      if (!ext || file.buffer.length > MAX_IMAGE) return false;
      const row = ctx.db.prepare('SELECT id FROM jay_inbox WHERE wa_id = ?').get(msg.id);
      if (!row) return false;
      const dir = path.join(ctx.config.uploadsDir, PHOTO_DIR);
      fs.mkdirSync(dir, { recursive: true });
      const name = `${PHOTO_DIR}/${row.id}.${ext}`;
      fs.writeFileSync(path.join(ctx.config.uploadsDir, name), file.buffer);
      ctx.db.prepare('UPDATE jay_inbox SET file = ?, mime = ? WHERE id = ?').run(name, mime, row.id);
      return true;
    },
    // Leva as fotos dessas mensagens para o serviço (o motorista vê no painel e recebe no
    // WhatsApp). Só as mensagens ligadas a esse serviço; cada foto vai uma vez só.
    attachToService(ids, serviceId, user, { notify = true } = {}) {
      if (!ctx.api.fotos?.attachInboxPhoto) return [];
      const rows = ids.length
        ? ctx.db.prepare(`SELECT * FROM jay_inbox WHERE id IN (${ids.map(() => '?').join(',')}) AND service_id = ? AND file IS NOT NULL AND photo_id IS NULL ORDER BY id`).all(...ids, serviceId)
        : [];
      const added = [];
      for (const r of rows) {
        const file = path.join(ctx.config.uploadsDir, r.file);
        if (!r.file.startsWith(`${PHOTO_DIR}/`) || !fs.existsSync(file)) continue;
        const photoId = ctx.api.fotos.attachInboxPhoto({ serviceId, file, mime: r.mime, userId: user.id });
        ctx.db.prepare('UPDATE jay_inbox SET photo_id = ? WHERE id = ?').run(photoId, r.id);
        added.push(photoId);
      }
      const service = added.length && ctx.data.services.get(serviceId);
      if (notify && service?.driver_id && service.driver_id !== user.id && ['pendente', 'aberto'].includes(service.status)) {
        const driver = ctx.data.users.get(service.driver_id);
        Promise.resolve(ctx.api.fotos.sendCarPhotos(service, driver, added)).catch((err) => ctx.log('Caixa: não consegui mandar as fotos ao motorista', err.message));
      }
      return added;
    },
    // Fotos de mensagens já tratadas antes desta atualização: vão para o serviço (sem avisar ninguém).
    backfill() {
      const rows = ctx.db.prepare('SELECT j.id, j.service_id, j.user_id FROM jay_inbox j JOIN services s ON s.id = j.service_id WHERE j.file IS NOT NULL AND j.photo_id IS NULL').all();
      for (const r of rows) {
        try {
          this.attachToService([r.id], r.service_id, { id: r.user_id }, { notify: false });
        } catch (err) {
          ctx.log(`Caixa: não consegui levar a foto [${r.id}] para o serviço #${r.service_id}`, err.message);
        }
      }
    },
    // Só guarda o que vem do dono (ADM).
    save(user, msg) {
      if (user.role !== 'dono') return null;
      const extra = msg.audio ? '[mensagem de voz]' : msg.doc ? `[arquivo${msg.doc.name ? ` ${msg.doc.name}` : ''}]` : msg.mediaId ? '[foto]' : '';
      const text = [extra, msg.text].filter(Boolean).join(' ').slice(0, 4000);
      if (!text && !msg.location) return null;
      ctx.db
        .prepare('INSERT OR IGNORE INTO jay_inbox (user_id, wa_id, type, text, latitude, longitude, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(user.id, msg.id || null, msg.type || 'text', text || null, msg.location?.latitude ?? null, msg.location?.longitude ?? null, nowIso());
      return true;
    },
  };
}

const ok = (text) => ({ content: [{ type: 'text', text }] });

export function registerCaixaTools(server, ctx, user) {
  server.registerTool(
    'caixa_de_entrada',
    {
      title: 'Caixa de entrada do Jay',
      description:
        'Lê o que o dono mandou para o Jay no WhatsApp (serviços encaminhados, localizações, contatos, recados), do mais antigo para o mais novo. Mensagens seguidas costumam ser do mesmo serviço. Atenção: o Jay pode já ter criado o serviço sozinho a partir dessas mensagens; antes de criar, confira com listar_servicos (hoje) e, se já existir, use atualizar_servico em vez de criar outro. Organize junto com o dono e só crie serviço quando ele mandar; depois use marcar_caixa_lida.',
      inputSchema: {
        incluir_lidas: z.boolean().optional().describe('true para ver também as já tratadas'),
        limite: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ incluir_lidas, limite } = {}) => {
      const rows = ctx.db
        .prepare(`SELECT * FROM (SELECT * FROM jay_inbox ${incluir_lidas ? '' : 'WHERE done_at IS NULL'} ORDER BY id DESC LIMIT ?) ORDER BY id`)
        .all(limite || 30);
      if (!rows.length) return ok(incluir_lidas ? 'A caixa de entrada está vazia.' : 'Nada novo na caixa de entrada do Jay.');
      const out = [`${rows.length} mensagem(ns) na caixa de entrada do Jay:`];
      for (const r of rows) {
        const coords = r.latitude != null ? `${r.latitude}, ${r.longitude}` : null;
        const photo = r.file ? `\n    Foto guardada: use ver_foto_caixa com id ${r.id} para ver a imagem.` : '';
        out.push(
          `- [${r.id}] ${r.created_at} · ${KIND[r.type] || r.type}${r.done_at ? ` · já tratada${r.service_id ? ` (serviço #${r.service_id})` : ''}` : ''}: ${r.text || ''}${coords ? `\n    Mapa: ${mapLink(coords)}` : ''}${photo}`
        );
      }
      return ok(out.join('\n'));
    }
  );

  server.registerTool(
    'ver_foto_caixa',
    {
      title: 'Ver foto da caixa de entrada',
      description:
        'Mostra a foto que o dono mandou para o Jay (pelo id entre colchetes da caixa de entrada). Olhe a imagem para saber o carro (marca, modelo, cor, placa), ler o VIN da etiqueta, ou o que mais o dono pediu. Confirme com o dono o que você leu antes de salvar.',
      inputSchema: { id: z.number().int().describe('O número entre colchetes da caixa de entrada') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const row = ctx.db.prepare('SELECT * FROM jay_inbox WHERE id = ?').get(id);
      const file = row?.file && path.join(ctx.config.uploadsDir, row.file);
      if (!file || !row.file.startsWith(`${PHOTO_DIR}/`) || !fs.existsSync(file)) {
        return { content: [{ type: 'text', text: row ? 'Essa mensagem não tem foto guardada (fotos de antes desta atualização não foram guardadas).' : `Não achei a mensagem [${id}].` }], isError: true };
      }
      logAction(ctx, user, null, 'ver_foto_caixa', { id });
      return {
        content: [
          { type: 'image', ...(await imageForClaude(fs.readFileSync(file), row.mime)) },
          { type: 'text', text: `Foto [${row.id}] mandada em ${row.created_at}${row.text ? ` · ${row.text}` : ''}.` },
        ],
      };
    }
  );

  server.registerTool(
    'marcar_caixa_lida',
    {
      title: 'Marcar mensagens como tratadas',
      description:
        'Marca mensagens da caixa de entrada do Jay como tratadas (não apaga nada). Informe o serviço criado com elas, se houver: as fotos dessas mensagens vão junto para o serviço (o motorista vê no painel e recebe no WhatsApp, para saber qual é o carro). Pode chamar de novo com mensagens já tratadas para levar as fotos ao serviço.',
      inputSchema: {
        ids: z.array(z.number().int()).min(1).describe('Os números entre colchetes da caixa de entrada'),
        numero_servico: z.number().int().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ ids, numero_servico }) => {
      if (numero_servico && !ctx.data.services.get(numero_servico)) return { content: [{ type: 'text', text: `Não achei o serviço #${numero_servico}.` }], isError: true };
      const mark = ctx.db.prepare('UPDATE jay_inbox SET done_at = COALESCE(done_at, ?), service_id = COALESCE(?, service_id) WHERE id = ?');
      let n = 0;
      for (const id of ids) n += Number(mark.run(nowIso(), numero_servico ?? null, id).changes);
      const photos = numero_servico ? ctx.api.caixa.attachToService(ids, numero_servico, user) : [];
      logAction(ctx, user, numero_servico ?? null, 'marcar_caixa_lida', { ids, numero_servico: numero_servico ?? null, fotos: photos.length }, photos.length ? 'fotos_anexadas' : null);
      const s = numero_servico && ctx.data.services.get(numero_servico);
      const toDriver = photos.length && s?.driver_id && s.driver_id !== user.id && ['pendente', 'aberto'].includes(s.status);
      const photoText = photos.length
        ? ` ${photos.length} foto(s) anexada(s) ao serviço${toDriver ? ` e mandada(s) para ${s.driver_name || 'o motorista'} no WhatsApp` : ''}.`
        : '';
      return ok(`${n} mensagem(ns) marcada(s) como tratada(s)${numero_servico ? ` no serviço #${numero_servico}` : ''}.${photoText}`);
    }
  );
}
