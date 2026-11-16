// Caixa de entrada do Jay: guarda uma CÓPIA do que o dono manda para o Jay no WhatsApp
// (textos, localizações, contatos, legendas de foto), para o Claude ler depois e organizar
// junto com o dono. O Jay continua respondendo igual; a caixa só observa.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { nowIso } from '../../lib/util.js';
import { mapLink } from '../../lib/validate.js';
import { logAction } from './tools.js';
import { describePhoto } from '../../lib/foto-descricao.js';

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
  // Descrição em texto da foto (carro, placa, VIN, danos, textos), para o modo de voz do Claude.
  `ALTER TABLE jay_inbox ADD COLUMN description TEXT;`,
];

const PHOTO_DIR = 'caixa';
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_IMAGE = 8 * 1024 * 1024;

const KIND = { image: 'foto', document: 'arquivo', audio: 'áudio', location: 'localização', contacts: 'contato', text: 'texto' };

// Só guardar (sem o Jay criar serviço) vale para texto, localização e cartão de contato do dono,
// fora de uma conversa com o Jay e sem ser comando. JAY_CAIXA=off volta ao jeito antigo.
const HOLD_TYPES = ['text', 'location', 'contacts'];
const RECEIPT_MS = 60 * 1000;

// Lê a foto guardada e grava a descrição. Devolve o texto (ou null sem chave/erro).
export async function describeRow(ctx, row) {
  if (!row?.file || row.description) return row?.description || null;
  const describe = ctx.describePhoto || describePhoto;
  try {
    const buffer = fs.readFileSync(path.join(ctx.config.uploadsDir, row.file));
    const text = await describe(ctx, buffer, row.mime);
    if (text) ctx.db.prepare('UPDATE jay_inbox SET description = ? WHERE id = ?').run(text, row.id);
    return text || null;
  } catch (err) {
    ctx.log('Caixa de entrada: não consegui descrever a foto', err.message);
    return null;
  }
}

// O VIN que a descrição achou confere com o dígito verificador?
function vinNote(ctx, description) {
  const found = String(description || '').toUpperCase().match(/\b[A-HJ-NPR-Z0-9]{17}\b/);
  if (!found || !ctx.api.vin) return '';
  const check = ctx.api.vin.validate(found[0]);
  return check.valid ? `\n(VIN ${check.vin}: o dígito verificador confere.)` : `\n(VIN ${check.vin}: o dígito verificador NÃO confere; confira com o dono.)`;
}

export function describedText(ctx, row) {
  if (!row.file) return '';
  if (row.description) return `Descrição da foto:\n${row.description}${vinNote(ctx, row.description)}`;
  return ctx.config.anthropicApiKey ? 'Descrição da foto: ainda não ficou pronta.' : 'Descrição da foto: indisponível (falta a chave ANTHROPIC_API_KEY no Render).';
}

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
      // Descreve em segundo plano: o Jay não espera por isso.
      this.pending = describeRow(ctx, { id: row.id, file: name, mime });
      return true;
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
        const photo = r.file
          ? `\n    ${describedText(ctx, r).replace(/\n/g, '\n    ')}\n    (Imagem guardada: ver_foto_caixa com id ${r.id}.)`
          : '';
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
        'Mostra a foto que o dono mandou para o Jay (pelo id entre colchetes da caixa de entrada), com uma descrição em texto (veículo, placa, VIN, danos, textos) feita quando a foto chegou; no modo de voz use a descrição. Olhe a imagem para saber o carro (marca, modelo, cor, placa), ler o VIN da etiqueta, ou o que mais o dono pediu. Confirme com o dono o que você leu antes de salvar.',
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
      if (!row.description) row.description = await describeRow(ctx, row);
      // O texto vem primeiro: no modo de voz do Claude só o texto chega até o modelo.
      return {
        content: [
          { type: 'text', text: `Foto [${row.id}] mandada em ${row.created_at}${row.text ? ` · ${row.text}` : ''}.\n${describedText(ctx, row)}` },
          { type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: row.mime },
        ],
      };
    }
  );

  server.registerTool(
    'marcar_caixa_lida',
    {
      title: 'Marcar mensagens como tratadas',
      description: 'Marca mensagens da caixa de entrada do Jay como tratadas (não apaga nada). Informe o serviço criado com elas, se houver.',
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
      logAction(ctx, user, numero_servico ?? null, 'marcar_caixa_lida', { ids, numero_servico: numero_servico ?? null });
      return ok(`${n} mensagem(ns) marcada(s) como tratada(s)${numero_servico ? ` no serviço #${numero_servico}` : ''}.`);
    }
  );
}
