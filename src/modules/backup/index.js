// Backup: um .zip com o banco de dados e todos os arquivos (fotos, logo...).
// O dono baixa no painel, e toda semana recebe no WhatsApp um link para salvar no Google Drive.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { createZip } from '../../lib/zip.js';
import { HttpError, nowIso } from '../../lib/util.js';
import { buildXlsx } from '../../lib/xlsx.js';
import { collectSheets } from '../planilha/index.js';

const DAY = 86400000;
// O link do WhatsApp vale por 8 dias; cada semana sai um novo.
const LINK_DAYS = 8;
// Domingo: dia do backup semanal (0 = domingo).
const BACKUP_WEEKDAY = 0;

const getSetting = (ctx, key) => ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
const setSetting = (ctx, key, value) =>
  ctx.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

// Todos os arquivos da pasta de dados, menos o próprio banco (que vai como cópia segura).
function dataFiles(ctx) {
  const base = ctx.config.dataDir;
  const db = path.resolve(ctx.config.dbFile);
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && !full.startsWith(db)) out.push({ full, name: path.relative(base, full).split(path.sep).join('/') });
    }
  };
  walk(base);
  return out;
}

export function backupInfo(ctx) {
  const files = dataFiles(ctx);
  let bytes = 0;
  for (const f of files) bytes += fs.statSync(f.full, { throwIfNoEntry: false })?.size || 0;
  bytes += fs.statSync(ctx.config.dbFile, { throwIfNoEntry: false })?.size || 0;
  return { files: files.length, bytes, last_download: getSetting(ctx, 'backup_last_download') };
}

const README = `BACKUP DO SISTEMA DO GUINCHO
=============================

planilha-completa.xlsx = tudo em planilha (abre no Excel ou no Google Planilhas)
guincho.db             = banco de dados do sistema (é o que volta o sistema; abre no
                         "DB Browser for SQLite", programa grátis, se quiser olhar)
uploads/               = fotos e arquivos

Guarde este arquivo no Google Drive (ou outro lugar fora do servidor).

Para voltar o backup: coloque guincho.db e a pasta uploads/ dentro da pasta de dados
do servidor (no Render: o disco montado em /data) e reinicie o serviço.
`;

// Escreve o .zip direto na resposta, aos pedaços.
async function sendBackup(ctx, res) {
  // Cópia consistente do banco, mesmo com o sistema funcionando.
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'backup-')), 'guincho.db');
  try {
    ctx.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: ctx.config.timeZone }).format(new Date());
    res.attachment(`backup-guincho-${day}.zip`);
    res.type('application/zip');
    res.set('Cache-Control', 'no-store');
    let pending = null;
    const zip = createZip((buf) => {
      if (!res.write(buf)) pending = once(res, 'drain');
    });
    zip.add('LEIA-ME.txt', README);
    zip.add('guincho.db', fs.readFileSync(tmp));
    // Planilha de todo o período, para abrir no Excel.
    if (ctx.has('planilha')) {
      try {
        zip.add('planilha-completa.xlsx', buildXlsx(collectSheets(ctx, { from: '0000', to: '9999', userId: null }), { timeZone: ctx.config.timeZone }), { compress: false });
      } catch (err) {
        ctx.log('Não consegui montar a planilha do backup', err);
      }
    }
    for (const f of dataFiles(ctx)) {
      let data;
      try {
        data = fs.readFileSync(f.full);
      } catch {
        continue;
      }
      // Fotos já são comprimidas; o resto comprime.
      zip.add(f.name, data, { compress: !/\.(jpe?g|png|webp|heic|mp4|pdf|zip)$/i.test(f.name) });
      if (pending) {
        await pending;
        pending = null;
      }
      if (res.destroyed) return;
    }
    zip.end();
    res.end();
    setSetting(ctx, 'backup_last_download', nowIso());
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

// Link sem login para o WhatsApp: muda toda semana e vence em LINK_DAYS dias.
function newLink(ctx) {
  const base = ctx.api.invoice?.publicBase();
  if (!base) return null;
  const token = crypto.randomBytes(24).toString('hex');
  setSetting(ctx, 'backup_link', JSON.stringify({ token, expires: new Date(Date.now() + LINK_DAYS * DAY).toISOString() }));
  return `${base}/backup/${token}.zip`;
}

function validToken(ctx, token) {
  let saved = null;
  try {
    saved = JSON.parse(getSetting(ctx, 'backup_link') || 'null');
  } catch {
    return false;
  }
  if (!saved?.token || saved.expires < nowIso()) return false;
  const a = Buffer.from(String(token));
  const b = Buffer.from(saved.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function routes(api, ctx) {
  const ownerOnly = (req) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o dono faz backup.');
  };
  api.get('/backup', (req, res) => {
    ownerOnly(req);
    res.json(backupInfo(ctx));
  });
  api.get('/backup.zip', async (req, res) => {
    ownerOnly(req);
    await sendBackup(ctx, res);
  });
}

function publicRoutes(app, ctx) {
  app.get('/backup/:token.zip', async (req, res, next) => {
    try {
      if (!validToken(ctx, req.params.token)) {
        res.status(404).send('Link vencido. Peça um backup novo no painel (Mais › Backup).');
        return;
      }
      await sendBackup(ctx, res);
    } catch (err) {
      next(err);
    }
  });
}

// Domingo (ou o primeiro dia depois, se o servidor estava parado): link do backup para o dono.
async function daily({ ctx, day }) {
  const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
  const sunday = new Date(Date.parse(`${day}T12:00:00Z`) - ((wd - BACKUP_WEEKDAY + 7) % 7) * DAY).toISOString().slice(0, 10);
  if (getSetting(ctx, 'backup_week') === sunday) return;
  if (getSetting(ctx, 'backup_week') == null && wd !== BACKUP_WEEKDAY) {
    // Sistema novo: espera o primeiro domingo.
    setSetting(ctx, 'backup_week', sunday);
    return;
  }
  setSetting(ctx, 'backup_week', sunday);
  const link = newLink(ctx);
  if (!link) return;
  const info = backupInfo(ctx);
  const mb = Math.max(1, Math.round(info.bytes / 1048576));
  const text = [
    '💾 *Backup semanal*',
    `Toque no link para baixar (cerca de ${mb} MB) e salve no Google Drive:`,
    link,
    `O link vale por ${LINK_DAYS} dias. Também dá para baixar a qualquer hora no painel, em Mais › Backup.`,
  ].join('\n');
  for (const owner of ctx.db.prepare("SELECT * FROM users WHERE role = 'dono' AND active = 1").all()) {
    try {
      await ctx.send(owner.phone, text);
    } catch (err) {
      ctx.log(`Não consegui mandar o link do backup para ${owner.name}`, err);
    }
  }
}

export default {
  name: 'backup',
  label: 'Backup',
  migrations: [],
  routes,
  publicRoutes,
  daily,
};
