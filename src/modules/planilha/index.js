// Módulo planilha: baixa os dados em Excel (.xlsx) e oferece um link privado
// que o Google Planilhas ou o Excel leem sozinhos para ficar sempre atualizados.
// Cada módulo coloca suas abas (exportSheets) e colunas extras de serviço (exportColumns).
import crypto from 'node:crypto';
import { buildXlsx, excelDate } from '../../lib/xlsx.js';
import { HttpError, nowIso, simplify } from '../../lib/util.js';

const migrations = [
  `CREATE TABLE planilha_link (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     token TEXT NOT NULL,
     created_at TEXT NOT NULL
   );`,
];

// Meia-noite de um dia no fuso da empresa, em ISO (UTC). Acerta o horário de verão.
function zonedMidnight(year, month, day, timeZone) {
  const wanted = Date.UTC(year, month - 1, day);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(guess))
        .map((x) => [x.type, Number(x.value)])
    );
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += wanted - shown;
  }
  return new Date(guess).toISOString();
}

// "2026-10" -> início e fim do mês no fuso da empresa. Sem mês = tudo.
export function monthRange(month, timeZone) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!match) return { from: '0000', to: '9999', label: 'tudo' };
  const [y, m] = [Number(match[1]), Number(match[2])];
  if (m < 1 || m > 12) throw new HttpError(400, 'Mês inválido.');
  return {
    from: zonedMidnight(y, m, 1, timeZone),
    to: m === 12 ? zonedMidnight(y + 1, 1, 1, timeZone) : zonedMidnight(y, m + 1, 1, timeZone),
    label: `${match[1]}-${match[2]}`,
  };
}

export function collectSheets(ctx, { from, to, userId = null }) {
  return ctx.loaded.flatMap((m) => m.exportSheets?.({ ctx, from, to, userId }) || []);
}

const slug = (name) => simplify(name).replace(/[^a-z0-9]+/g, '-');

// Texto CSV (com BOM para o Excel entender os acentos). Datas no fuso da empresa.
export function toCsv(sheet, timeZone) {
  const quote = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const format = (value, type) => {
    if (value === null || value === undefined || value === '') return '';
    if (type === 'money') return Number(value).toFixed(2);
    if (type === 'date') {
      const serial = excelDate(value, timeZone);
      if (serial == null) return '';
      const d = new Date(Math.round((serial - 25569) * 86400000));
      return d.toISOString().slice(0, 16).replace('T', ' ');
    }
    return quote(String(value));
  };
  const lines = [sheet.columns.map((c) => quote(c.header)).join(',')];
  for (const row of sheet.rows) lines.push(sheet.columns.map((c, i) => format(row[i], c.type)).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

function getLink(ctx) {
  return ctx.db.prepare('SELECT * FROM planilha_link WHERE id = 1').get();
}

function linkInfo(req, link, ctx) {
  if (!link) return { active: false };
  // No Render o app fica atrás de um proxy https: usa o protocolo que o celular usou.
  const proto = req.get('x-forwarded-proto')?.split(',')[0].trim() || req.protocol;
  const base = `${proto}://${req.get('host')}/planilha/${link.token}`;
  const sheets = collectSheets(ctx, { from: '9999', to: '9999' }).map((s) => ({ name: s.name, url: `${base}/${slug(s.name)}.csv` }));
  return { active: true, created_at: link.created_at, sheets };
}

const onlyOwner = (req) => {
  if (req.user.role !== 'dono') throw new HttpError(403, 'Só o dono pode fazer isso.');
};

function routes(api, ctx) {
  // Baixar a planilha. Dono vê tudo; motorista só os próprios serviços e despesas.
  api.get('/planilha.xlsx', (req, res) => {
    const range = monthRange(req.query.mes, ctx.config.timeZone);
    const userId = req.user.role === 'dono' ? null : req.user.id;
    const file = buildXlsx(collectSheets(ctx, { ...range, userId }), { timeZone: ctx.config.timeZone });
    const company = simplify(ctx.config.companyName).replace(/[^a-z0-9]+/g, '-') || 'guincho';
    res.attachment(`${company}-${range.label}.xlsx`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(file);
  });

  api.get('/planilha/link', (req, res) => {
    onlyOwner(req);
    res.json(linkInfo(req, getLink(ctx), ctx));
  });

  // Cria (ou troca) o link privado. O link antigo para de funcionar.
  api.post('/planilha/link', (req, res) => {
    onlyOwner(req);
    const token = crypto.randomBytes(18).toString('base64url');
    ctx.db
      .prepare('INSERT INTO planilha_link (id, token, created_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at')
      .run(token, nowIso());
    res.json(linkInfo(req, getLink(ctx), ctx));
  });

  api.delete('/planilha/link', (req, res) => {
    onlyOwner(req);
    ctx.db.prepare('DELETE FROM planilha_link').run();
    res.json({ active: false });
  });
}

function publicRoutes(app, ctx) {
  // Link privado: o Google Planilhas (IMPORTDATA) ou o Excel (Dados > Da Web) leem isto.
  app.get('/planilha/:token/:sheet.csv', (req, res) => {
    const link = getLink(ctx);
    const given = Buffer.from(String(req.params.token));
    const ok = link && given.length === Buffer.byteLength(link.token) && crypto.timingSafeEqual(given, Buffer.from(link.token));
    if (!ok) return res.status(404).send('Link inválido ou desligado.');
    const sheet = collectSheets(ctx, { from: '0000', to: '9999' }).find((s) => slug(s.name) === req.params.sheet);
    if (!sheet) return res.status(404).send('Aba não encontrada.');
    res.set('Cache-Control', 'no-store');
    res.type('text/csv; charset=utf-8').send(toCsv(sheet, ctx.config.timeZone));
  });
}

export default {
  name: 'planilha',
  label: 'Planilha',
  migrations,
  routes,
  publicRoutes,
};
