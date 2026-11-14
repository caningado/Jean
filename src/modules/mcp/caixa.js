// Caixa de entrada do Jay: guarda uma CÓPIA do que o dono manda para o Jay no WhatsApp
// (textos, localizações, contatos, legendas de foto), para o Claude ler depois e organizar
// junto com o dono. O Jay continua respondendo igual; a caixa só observa.
import { z } from 'zod';
import { nowIso } from '../../lib/util.js';
import { mapLink } from '../../lib/validate.js';
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
];

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
        out.push(
          `- [${r.id}] ${r.created_at} · ${KIND[r.type] || r.type}${r.done_at ? ` · já tratada${r.service_id ? ` (serviço #${r.service_id})` : ''}` : ''}: ${r.text || ''}${coords ? `\n    Mapa: ${mapLink(coords)}` : ''}`
        );
      }
      return ok(out.join('\n'));
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
