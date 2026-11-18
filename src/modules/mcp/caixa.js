// Caixa de entrada do Jay: guarda uma CÓPIA do que o dono manda para o Jay no WhatsApp
// (textos, localizações, contatos, legendas de foto), para o Claude ler depois e organizar
// junto com o dono. O Jay continua respondendo igual; a caixa só observa.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { nowIso } from '../../lib/util.js';
import { askGemini } from '../../lib/gemini.js';
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
  // PDF que o dono mandou (pedido de serviço, gate pass): fica guardado para o Claude ler (pedido do Caningado 18/11).
  `ALTER TABLE jay_inbox ADD COLUMN doc_file TEXT;`,
  // Texto já tirado do PDF (para não ler de novo a cada vez).
  `ALTER TABLE jay_inbox ADD COLUMN doc_text TEXT;`,
];

const PHOTO_DIR = 'caixa';
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_IMAGE = 8 * 1024 * 1024;

// Áudio do dono: o Jay escreve o que foi falado (o Claude não ouve áudio). Pedido do Caningado 18/11.
const MAX_AUDIO = 15 * 1024 * 1024;
const VOICE_TAG = '[mensagem de voz]';
const TRANSCRIBE_PROMPT = `Transcreva este áudio de WhatsApp palavra por palavra. Quem fala é o dono de uma empresa de guincho nos EUA (Flórida), em português do Brasil, às vezes informal e misturando inglês. Pode ter barulho de rua ou de motor.
- Escreva exatamente o que foi falado, sem resumir, sem corrigir e sem inventar.
- Endereços, nomes de rua, cidades, nomes de lugar e de empresa em inglês: escreva em inglês do jeito americano (ex.: "1200 Alafaya Trail, Oviedo", "Home Depot").
- Números, telefones, valores, anos e milhas: escreva com algarismos (ex.: "407 555 0102", "$150", "2015").
- Placa e VIN soletrados: junte as letras e números (ex.: "ABC1234").
- Se não der para entender um trecho, escreva [inaudível]. Se o áudio estiver mudo, deixe vazio.`;
const TRANSCRIBE_SCHEMA = { type: 'OBJECT', properties: { transcricao: { type: 'STRING' } }, required: ['transcricao'] };

// O WhatsApp manda "audio/ogg; codecs=opus": o Gemini quer só "audio/ogg".
function audioMime(mime) {
  const type = String(mime || '').split(';')[0].trim().toLowerCase();
  if (type === 'audio/x-m4a' || type === 'audio/m4a') return 'audio/mp4';
  return type.startsWith('audio/') ? type : 'audio/ogg';
}

const DOC_DIR = 'caixa-pdf';
const MAX_PDF = 20 * 1024 * 1024;
const MAX_PDF_TEXT = 30000;
const MAX_LIST_PDF = 6000;
const indent = (t) => t.split('\n').map((l) => `      ${l}`).join('\n');
const PDF_PROMPT = `Este PDF chegou para uma empresa de guincho nos EUA (pedido de serviço, gate pass de leilão, ordem de reboque...). Escreva todo o texto que está nele, página por página, na ordem, sem resumir e sem inventar. Mantenha endereços, nomes, telefones, VIN, números e valores exatamente como estão. Tabelas: uma linha por item, "campo: valor".`;
const PDF_SCHEMA = { type: 'OBJECT', properties: { texto: { type: 'STRING' } }, required: ['texto'] };

// Tira o texto de um PDF (o que tem letra de verdade, não foto escaneada).
export async function pdfText(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
  const pdf = await task.promise;
  const pages = [];
  try {
    for (let i = 1; i <= Math.min(pdf.numPages, 30); i++) {
      const content = await (await pdf.getPage(i)).getTextContent();
      const text = content.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
      pages.push(text);
    }
    return { pages, numPages: pdf.numPages };
  } finally {
    await task.destroy();
  }
}

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
    // PDF do dono: guarda o arquivo na mensagem da caixa, para o Claude ler com ver_arquivo_caixa.
    attachDoc(user, msg, file) {
      if (user.role !== 'dono' || !msg.doc || !file?.buffer?.length || !msg.id) return false;
      const mime = String(file.mime || msg.doc.mime || '').split(';')[0].trim().toLowerCase();
      const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(msg.doc.name || '') || file.buffer.subarray(0, 5).toString() === '%PDF-';
      if (!isPdf || file.buffer.length > MAX_PDF) return false;
      const row = ctx.db.prepare('SELECT id FROM jay_inbox WHERE wa_id = ?').get(msg.id);
      if (!row) return false;
      fs.mkdirSync(path.join(ctx.config.uploadsDir, DOC_DIR), { recursive: true });
      const name = `${DOC_DIR}/${row.id}.pdf`;
      fs.writeFileSync(path.join(ctx.config.uploadsDir, name), file.buffer);
      ctx.db.prepare('UPDATE jay_inbox SET doc_file = ? WHERE id = ?').run(name, row.id);
      return true;
    },
    // Já tira o texto do PDF quando ele chega (o Claude por voz não abre arquivo: precisa do texto pronto).
    async readDoc(msg) {
      const row = msg.id && ctx.db.prepare('SELECT * FROM jay_inbox WHERE wa_id = ?').get(msg.id);
      const file = row && pdfFile(ctx, row);
      return file ? readPdf(ctx, row, file) : null;
    },
    // Áudio do dono: escreve o que foi falado e guarda o texto na mensagem da caixa.
    // Usa o Gemini que o sistema já tem (GEMINI_API_KEY). Se falhar, a mensagem fica marcada.
    async transcribe(user, msg, file, fetchImpl = globalThis.fetch) {
      if (user.role !== 'dono' || !msg.audio || !msg.id) return null;
      const row = ctx.db.prepare('SELECT id, text FROM jay_inbox WHERE wa_id = ?').get(msg.id);
      if (!row) return null;
      const put = (text) => ctx.db.prepare('UPDATE jay_inbox SET text = ? WHERE id = ?').run(text.slice(0, 4000), row.id);
      if (!ctx.config.geminiApiKey) return null;
      if (!file?.buffer?.length || file.buffer.length > MAX_AUDIO) {
        put(`${VOICE_TAG} (não consegui escrever: ${file?.buffer?.length ? 'áudio grande demais' : 'não baixou o áudio'}; peça ao dono para contar ou escrever)`);
        return null;
      }
      try {
        const a = await askGemini(
          ctx,
          { prompt: TRANSCRIBE_PROMPT, audio: file.buffer, mimeType: audioMime(file.mime), schema: TRANSCRIBE_SCHEMA, model: ctx.config.geminiModel, timeoutMs: 60000 },
          fetchImpl
        );
        const said = String(a.transcricao || '').trim();
        put(said ? `${VOICE_TAG} Transcrição do Jay: "${said}"` : `${VOICE_TAG} (áudio sem fala que deu para entender)`);
        return said;
      } catch (err) {
        ctx.log?.('Caixa de entrada: não consegui escrever o áudio', err.message);
        put(`${VOICE_TAG} (não consegui escrever o áudio agora; peça ao dono para contar ou escrever)`);
        return null;
      }
    },
    // Leva SÓ as fotos que o dono escolheu para o serviço (ex.: a do carro, não a print do
    // endereço). O motorista vê no serviço, no painel. Cada foto vai uma vez só.
    // O Jay não manda nada aos motoristas (decisão do dono 18/11).
    attachToService(ids, serviceId, user) {
      if (!ctx.api.fotos?.attachInboxPhoto) return [];
      const rows = ids.length
        ? ctx.db.prepare(`SELECT * FROM jay_inbox WHERE id IN (${ids.map(() => '?').join(',')}) AND file IS NOT NULL AND photo_id IS NULL ORDER BY id`).all(...ids)
        : [];
      const added = [];
      for (const r of rows) {
        const file = path.join(ctx.config.uploadsDir, r.file);
        if (!r.file.startsWith(`${PHOTO_DIR}/`) || !fs.existsSync(file)) continue;
        const photoId = ctx.api.fotos.attachInboxPhoto({ serviceId, file, mime: r.mime, userId: user.id });
        ctx.db.prepare('UPDATE jay_inbox SET photo_id = ?, service_id = COALESCE(service_id, ?) WHERE id = ?').run(photoId, serviceId, r.id);
        added.push(photoId);
      }
      return added;
    },
    // Só guarda o que vem do dono (ADM).
    save(user, msg) {
      if (user.role !== 'dono') return null;
      const extra = msg.audio ? VOICE_TAG : msg.doc ? `[arquivo${msg.doc.name ? ` ${msg.doc.name}` : ''}]` : msg.mediaId ? '[foto]' : '';
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

// Lê o PDF guardado de uma mensagem da caixa: texto do PDF (pdfjs) ou, se for escaneado, pelo Gemini.
// Guarda o resultado em doc_text para não ler de novo.
async function readPdf(ctx, row, file) {
  if (row.doc_text) {
    try {
      return JSON.parse(row.doc_text);
    } catch {}
  }
  const buffer = fs.readFileSync(file);
  let text = '';
  let pages = 0;
  try {
    const r = await pdfText(buffer);
    pages = r.numPages;
    text = r.pages.map((t, i) => (r.pages.length > 1 ? `--- Página ${i + 1} ---\n${t}` : t)).join('\n\n').trim();
  } catch (err) {
    ctx.log?.('Caixa de entrada: não consegui abrir o PDF', err.message);
  }
  let how = 'texto do PDF';
  // PDF escaneado (foto de papel) não tem letra: o Gemini, que o sistema já usa, lê a imagem.
  if (text.replace(/[^\p{L}\p{N}]/gu, '').length < 20 && ctx.config.geminiApiKey) {
    try {
      const a = await askGemini(ctx, { prompt: PDF_PROMPT, audio: buffer, mimeType: 'application/pdf', schema: PDF_SCHEMA, model: ctx.config.geminiModel, timeoutMs: 60000 });
      if (String(a.texto || '').trim()) {
        text = String(a.texto).trim();
        how = 'PDF escaneado, lido pelo Gemini (confira com o dono)';
      }
    } catch (err) {
      ctx.log?.('Caixa de entrada: o Gemini não leu o PDF', err.message);
    }
  }
  const out = { text, pages, how };
  if (text) ctx.db.prepare('UPDATE jay_inbox SET doc_text = ? WHERE id = ?').run(JSON.stringify(out), row.id);
  return out;
}

const pdfFile = (ctx, row) => {
  const file = row?.doc_file && path.join(ctx.config.uploadsDir, row.doc_file);
  return file && row.doc_file.startsWith(`${DOC_DIR}/`) && fs.existsSync(file) ? file : null;
};


export function registerCaixaTools(server, ctx, user) {
  server.registerTool(
    'caixa_de_entrada',
    {
      title: 'Caixa de entrada do Jay',
      description:
        'Lê o que o dono mandou para o Jay no WhatsApp (serviços encaminhados, localizações, contatos, recados, áudios, PDFs). O texto dos PDFs já vem aqui, logo abaixo da mensagem, do mais antigo para o mais novo. Áudios vêm escritos pelo Jay ("Transcrição do Jay"); endereço ou nome entendido errado é possível, então confira com o dono. Mensagens seguidas costumam ser do mesmo serviço. Atenção: o Jay pode já ter criado o serviço sozinho a partir dessas mensagens; antes de criar, confira com listar_servicos (hoje) e, se já existir, use atualizar_servico em vez de criar outro. Organize junto com o dono e só crie serviço quando ele mandar; depois use marcar_caixa_lida.',
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
        let pdf = '';
        const pdfPath = pdfFile(ctx, r);
        if (pdfPath) {
          const read = await readPdf(ctx, r, pdfPath).catch((err) => (ctx.log?.('Caixa de entrada: não li o PDF', err.message), { text: '' }));
          pdf = read.text
            ? `\n    Texto do PDF${read.pages ? ` (${read.pages} página(s))` : ''}, ${read.how}:\n${indent(read.text.length > MAX_LIST_PDF ? `${read.text.slice(0, MAX_LIST_PDF)}\n[... continua: use ver_arquivo_caixa com id ${r.id}]` : read.text)}`
            : `\n    PDF guardado, mas não consegui ler o texto (pode ser escaneado ou com senha). Peça ao dono para contar o que diz.`;
        } else if (r.type === 'document' && !r.file) pdf = '\n    (O arquivo não ficou guardado: chegou antes da atualização. Peça ao dono para mandar de novo.)';
        out.push(
          `- [${r.id}] ${r.created_at} · ${KIND[r.type] || r.type}${r.done_at ? ` · já tratada${r.service_id ? ` (serviço #${r.service_id})` : ''}` : ''}: ${r.text || ''}${coords ? `\n    Mapa: ${mapLink(coords)}` : ''}${photo}${pdf}`
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
    'ver_arquivo_caixa',
    {
      title: 'Ler PDF da caixa de entrada',
      description:
        'Lê o PDF que o dono mandou para o Jay (pelo id entre colchetes da caixa de entrada): pedido de serviço, gate pass, ordem de reboque. Devolve o texto do PDF para você tirar cliente, retirada, destino, carro, VIN, preço e o que mais o pedido disser. Leia para o dono o que entendeu e só crie o serviço quando ele mandar.',
      inputSchema: { id: z.number().int().describe('O número entre colchetes da caixa de entrada') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const row = ctx.db.prepare('SELECT * FROM jay_inbox WHERE id = ?').get(id);
      const file = row?.doc_file && path.join(ctx.config.uploadsDir, row.doc_file);
      if (!file || !row.doc_file.startsWith(`${DOC_DIR}/`) || !fs.existsSync(file)) {
        return { content: [{ type: 'text', text: row ? 'Essa mensagem não tem PDF guardado (PDFs de antes desta atualização não foram guardados; peça ao dono para mandar de novo).' : `Não achei a mensagem [${id}].` }], isError: true };
      }
      const r = await readPdf(ctx, row, file);
      logAction(ctx, user, null, 'ver_arquivo_caixa', { id });
      const text = r.text;
      if (!text) return { content: [{ type: 'text', text: `Não consegui ler o PDF [${row.id}] (pode ser escaneado ou estar com senha). Peça ao dono para contar o que diz, ou mandar uma foto dele.` }], isError: true };
      const cut = text.length > MAX_PDF_TEXT ? `${text.slice(0, MAX_PDF_TEXT)}\n[... cortado, o PDF é muito longo]` : text;
      return ok(`PDF [${row.id}] mandado em ${row.created_at}${row.text ? ` · ${row.text}` : ''}${r.pages ? ` · ${r.pages} página(s)` : ''} (${r.how}):\n\n${cut}`);
    }
  );

  server.registerTool(
    'marcar_caixa_lida',
    {
      title: 'Marcar mensagens como tratadas',
      description: 'Marca mensagens da caixa de entrada do Jay como tratadas (não apaga nada). Informe o serviço criado com elas, se houver. Não leva fotos para o serviço: para isso use anexar_foto_caixa com a foto que o dono escolher.',
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
      const withPhoto = ctx.db.prepare(`SELECT COUNT(*) AS n FROM jay_inbox WHERE id IN (${ids.map(() => '?').join(',')}) AND file IS NOT NULL AND photo_id IS NULL`).get(...ids).n;
      const tip = numero_servico && withPhoto ? ` Tem ${withPhoto} foto(s) nessas mensagens: pergunte ao dono se alguma (ex.: a do carro) vai para o serviço e use anexar_foto_caixa só com as que ele escolher.` : '';
      return ok(`${n} mensagem(ns) marcada(s) como tratada(s)${numero_servico ? ` no serviço #${numero_servico}` : ''}.${tip}`);
    }
  );

  server.registerTool(
    'anexar_foto_caixa',
    {
      title: 'Anexar foto escolhida ao serviço',
      description:
        'Coloca no serviço SÓ a(s) foto(s) da caixa de entrada que o dono escolheu (normalmente a foto do carro, para o motorista saber qual é). Não anexe print de endereço nem foto que o dono não pediu. Antes, olhe as fotos com ver_foto_caixa, diga ao dono o que cada uma mostra e pergunte quais vão. O motorista vê a foto no serviço, no painel (nada é mandado a ele no WhatsApp).',
      inputSchema: {
        ids: z.array(z.number().int()).min(1).describe('Os números entre colchetes das fotos escolhidas pelo dono'),
        numero_servico: z.number().int(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ ids, numero_servico }) => {
      const s = ctx.data.services.get(numero_servico);
      if (!s) return { content: [{ type: 'text', text: `Não achei o serviço #${numero_servico}.` }], isError: true };
      const found = ctx.db.prepare(`SELECT id, file, photo_id FROM jay_inbox WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
      const noPhoto = ids.filter((id) => !found.some((r) => r.id === id && r.file));
      const already = found.filter((r) => r.photo_id).map((r) => r.id);
      const photos = ctx.api.caixa.attachToService(ids, s.id, user);
      if (photos.length) logAction(ctx, user, s.id, 'anexar_foto_caixa', { ids, fotos: photos.length }, 'fotos_anexadas');
      const out = [];
      if (photos.length) out.push(`${photos.length} foto(s) colocada(s) no serviço #${s.id}. O motorista vê no serviço, no painel.`);
      if (already.length) out.push(`Já estava(m) num serviço: ${already.map((id) => `[${id}]`).join(', ')}.`);
      if (noPhoto.length) out.push(`Sem foto guardada: ${noPhoto.map((id) => `[${id}]`).join(', ')}.`);
      return { content: [{ type: 'text', text: out.join(' ') || 'Nenhuma foto anexada.' }], isError: !photos.length && !already.length };
    }
  );
}
