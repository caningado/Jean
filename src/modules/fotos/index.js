// Módulo de fotos: antes (retirada), depois (entrega) e VIN, todas opcionais,
// guardadas junto do serviço com data e hora.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { FlowError } from '../../core/bot.js';
import { simplify, nowIso, HttpError } from '../../lib/util.js';

const KINDS = { antes: 'antes', depois: 'depois', vin: 'vin', outro: 'outro' };
const KIND_LABEL = { antes: 'antes', depois: 'depois', vin: 'VIN', outro: 'sem tipo' };
const MODE_MINUTES = 20;

// Ângulos da volta no carro, na ordem em que o motorista anda em volta dele.
export const ANGLES = ['frente', 'lateral_esquerda', 'traseira', 'lateral_direita'];
export const ANGLE_LABEL = {
  frente: 'frente',
  lateral_esquerda: 'lateral esquerda (motorista)',
  traseira: 'traseira',
  lateral_direita: 'lateral direita (passageiro)',
  detalhe: 'detalhe / dano',
};

const migrations = [
  `CREATE TABLE photos (
     id INTEGER PRIMARY KEY,
     service_id INTEGER NOT NULL REFERENCES services(id),
     kind TEXT NOT NULL CHECK (kind IN ('antes', 'depois', 'vin', 'outro')),
     file TEXT NOT NULL,
     mime TEXT,
     uploaded_by INTEGER REFERENCES users(id),
     created_at TEXT NOT NULL
   );
   CREATE INDEX photos_service ON photos(service_id);
   CREATE TABLE photo_modes (
     user_id INTEGER PRIMARY KEY REFERENCES users(id),
     kind TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  // Ângulo da foto de antes/depois: frente, laterais, traseira ou detalhe.
  `ALTER TABLE photos ADD COLUMN angle TEXT;`,
];

// Entende o ângulo escrito na legenda: "antes frente", "traseira", "lado direito"...
export function angleFromText(text) {
  const s = simplify(text);
  if (!s) return null;
  if (/\b(frente|frontal|dianteira)\b/.test(s)) return 'frente';
  if (/\b(traseira|tras|atras|fundo)\b/.test(s)) return 'traseira';
  if (/\b(esquerd[ao]|motorista)\b/.test(s)) return 'lateral_esquerda';
  if (/\b(direit[ao]|passageiro|carona)\b/.test(s)) return 'lateral_direita';
  if (/\b(detalhe|dano|amassado|risco|batida)\b/.test(s)) return 'detalhe';
  return null;
}

// Entende a legenda ou a palavra mandada pelo motorista.
export function kindFromText(text) {
  const s = simplify(text);
  if (!s) return null;
  if (/^(antes|retirada|pegando|coleta)\b/.test(s)) return 'antes';
  if (/^(depois|entrega|entregue|entregando)\b/.test(s)) return 'depois';
  if (/^(vin|chassi)\b/.test(s)) return 'vin';
  return null;
}

const EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic' };

function savePhoto(ctx, { serviceId, kind, angle = null, buffer, mime, userId }) {
  const dir = path.join(ctx.config.uploadsDir, `servico-${serviceId}`);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${kind}-${crypto.randomBytes(3).toString('hex')}${EXTENSIONS[mime] || '.jpg'}`;
  fs.writeFileSync(path.join(dir, name), buffer);
  const info = ctx.db
    .prepare('INSERT INTO photos (service_id, kind, angle, file, mime, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(serviceId, kind, angle, path.join(`servico-${serviceId}`, name), mime || 'image/jpeg', userId, nowIso());
  return Number(info.lastInsertRowid);
}

function countPhotos(ctx, serviceId, kind) {
  return ctx.db.prepare('SELECT COUNT(*) AS n FROM photos WHERE service_id = ? AND kind = ?').get(serviceId, kind).n;
}

// Próximo ângulo da volta no carro que ainda não tem foto (ou "detalhe" se já tem todos).
function nextAngle(ctx, serviceId, kind) {
  const done = new Set(ctx.db.prepare('SELECT angle FROM photos WHERE service_id = ? AND kind = ?').all(serviceId, kind).map((r) => r.angle));
  return ANGLES.find((a) => !done.has(a)) || 'detalhe';
}

function angleTip(ctx, serviceId, kind) {
  const next = nextAngle(ctx, serviceId, kind);
  return next === 'detalhe' ? '✅ Volta completa. Fotos a mais entram como detalhe.' : `Próxima: *${ANGLE_LABEL[next]}*.`;
}

function setMode(ctx, userId, kind) {
  ctx.db
    .prepare(
      `INSERT INTO photo_modes (user_id, kind, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET kind = excluded.kind, updated_at = excluded.updated_at`
    )
    .run(userId, kind, nowIso());
}

// Depois de mandar "antes", as próximas fotos sem legenda entram como "antes" por alguns minutos.
function currentMode(ctx, userId) {
  const row = ctx.db.prepare('SELECT * FROM photo_modes WHERE user_id = ?').get(userId);
  if (!row || Date.now() - Date.parse(row.updated_at) > MODE_MINUTES * 60000) return null;
  return row.kind;
}

async function onMedia({ ctx, user, media, caption }) {
  const service = ctx.data.services.active(user);
  if (!service) return 'Nenhum serviço em andamento, então não guardei a foto. Mande *novo* para começar um serviço.';

  const kind = kindFromText(caption) || currentMode(ctx, user.id) || 'outro';
  if (kind !== 'outro') setMode(ctx, user.id, kind);
  const angle = kind === 'antes' || kind === 'depois' ? angleFromText(caption) || nextAngle(ctx, service.id, kind) : null;
  savePhoto(ctx, { serviceId: service.id, kind, angle, buffer: media.buffer, mime: media.mime, userId: user.id });

  if (kind === 'vin' && ctx.api.vin) {
    return ctx.api.vin.askConfirmation(user, service, media.buffer, media.mime);
  }
  if (kind === 'outro') {
    return ctx.bot.startFlow(user, 'foto_tipo', { serviceId: service.id, since: new Date(Date.now() - 60000).toISOString() });
  }
  return `📷 Foto de *${KIND_LABEL[kind]}* (${ANGLE_LABEL[angle]}) salva no serviço #${service.id} (${countPhotos(ctx, service.id, kind)} no total). ${angleTip(ctx, service.id, kind)}`;
}

const flows = {
  foto_tipo: {
    steps: [
      {
        key: 'kind',
        ask: () => 'Foto salva. Ela é de quê?\n*1* antes (retirada)\n*2* depois (entrega)\n*3* VIN',
        parse(text) {
          const kind = { 1: 'antes', 2: 'depois', 3: 'vin' }[simplify(text)] || kindFromText(text);
          if (!kind) throw new FlowError('Responda 1, 2 ou 3.');
          return kind;
        },
      },
    ],
    finish({ ctx, user, data }) {
      // Ajusta todas as fotos sem tipo que acabaram de chegar (o motorista pode ter mandado várias de uma vez).
      const fresh = ctx.db
        .prepare("SELECT id FROM photos WHERE service_id = ? AND uploaded_by = ? AND kind = 'outro' AND created_at >= ? ORDER BY id")
        .all(data.serviceId, user.id, data.since);
      const update = ctx.db.prepare('UPDATE photos SET kind = ?, angle = ? WHERE id = ?');
      for (const photo of fresh) {
        const angle = data.kind === 'antes' || data.kind === 'depois' ? nextAngle(ctx, data.serviceId, data.kind) : null;
        update.run(data.kind, angle, photo.id);
      }
      const result = { changes: fresh.length };
      setMode(ctx, user.id, data.kind);
      const n = Number(result.changes);
      const what = `${n} foto${n === 1 ? '' : 's'} de *${KIND_LABEL[data.kind]}*`;
      const tip = data.kind === 'vin' ? '\nPara salvar o número, mande *vin* seguido dele.' : '';
      return `📷 ${what} no serviço #${data.serviceId}. As próximas fotos também vão entrar como ${KIND_LABEL[data.kind]}.${tip}`;
    },
  },
};

const commands = [
  {
    names: ['antes', 'depois'],
    help: '*antes* / *depois* – avisar que as próximas fotos são da retirada ou da entrega',
    run({ ctx, user, text }) {
      const service = ctx.data.services.active(user);
      if (!service) return 'Nenhum serviço em andamento. Mande *novo* primeiro.';
      const kind = kindFromText(text);
      setMode(ctx, user.id, kind);
      return (
        `Ok, pode mandar as fotos de *${KIND_LABEL[kind]}* do serviço #${service.id}, dando a volta no carro:\n` +
        ANGLES.map((a, i) => `${i + 1}. ${ANGLE_LABEL[a]}`).join('\n') +
        '\nFotos a mais entram como detalhe. Se quiser, escreva o lado na legenda (ex: *traseira*).'
      );
    },
  },
];

function findServiceFor(ctx, user, id) {
  const service = ctx.data.services.get(Number(id));
  if (!service || (user.role !== 'dono' && service.driver_id !== user.id)) throw new HttpError(404, 'Serviço não encontrado.');
  return service;
}

function listPhotos(ctx, serviceId) {
  return ctx.db
    .prepare('SELECT p.id, p.kind, p.angle, p.created_at, u.name AS uploaded_by_name FROM photos p LEFT JOIN users u ON u.id = p.uploaded_by WHERE service_id = ? ORDER BY p.id')
    .all(serviceId)
    .map((p) => ({ ...p, url: `/api/photos/${p.id}/file` }));
}

function routes(api, ctx) {
  api.get('/services/:id/photos', (req, res) => {
    const service = findServiceFor(ctx, req.user, req.params.id);
    res.json(listPhotos(ctx, service.id));
  });

  api.post('/services/:id/photos', express.raw({ type: 'image/*', limit: '15mb' }), (req, res) => {
    const service = findServiceFor(ctx, req.user, req.params.id);
    const kind = KINDS[req.query.kind] || 'outro';
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Mande uma foto.');
    let angle = null;
    if (kind === 'antes' || kind === 'depois') {
      angle = req.query.angle ? (ANGLE_LABEL[req.query.angle] ? req.query.angle : null) : nextAngle(ctx, service.id, kind);
      if (req.query.angle && !angle) throw new HttpError(400, 'Ângulo inválido.');
    }
    const id = savePhoto(ctx, { serviceId: service.id, kind, angle, buffer: req.body, mime: req.headers['content-type'], userId: req.user.id });
    res.status(201).json({ id, kind, angle, url: `/api/photos/${id}/file` });
  });

  api.get('/photos/:id/file', (req, res) => {
    const photo = ctx.db.prepare('SELECT * FROM photos WHERE id = ?').get(Number(req.params.id));
    if (!photo) throw new HttpError(404, 'Foto não encontrada.');
    findServiceFor(ctx, req.user, photo.service_id);
    res.type(photo.mime || 'image/jpeg');
    res.sendFile(path.join(ctx.config.uploadsDir, photo.file));
  });

  api.patch('/photos/:id', (req, res) => {
    const photo = ctx.db.prepare('SELECT * FROM photos WHERE id = ?').get(Number(req.params.id));
    if (!photo) throw new HttpError(404, 'Foto não encontrada.');
    findServiceFor(ctx, req.user, photo.service_id);
    const kind = KINDS[req.body?.kind];
    if (!kind) throw new HttpError(400, 'Tipo de foto inválido.');
    ctx.db.prepare('UPDATE photos SET kind = ? WHERE id = ?').run(kind, photo.id);
    res.json({ ok: true });
  });

  api.delete('/photos/:id', (req, res) => {
    if (req.user.role !== 'dono') throw new HttpError(403, 'Só o dono pode apagar fotos.');
    const photo = ctx.db.prepare('SELECT * FROM photos WHERE id = ?').get(Number(req.params.id));
    if (!photo) throw new HttpError(404, 'Foto não encontrada.');
    ctx.db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
    fs.rmSync(path.join(ctx.config.uploadsDir, photo.file), { force: true });
    res.json({ ok: true });
  });
}

export default {
  name: 'fotos',
  exportColumns: (ctx) => {
    const count = ctx.db.prepare('SELECT COUNT(*) AS n FROM photos WHERE service_id = ?');
    return [{ header: 'Fotos', width: 7, type: 'number', value: (s) => count.get(s.id).n }];
  },
  label: 'Fotos',
  migrations,
  commands,
  flows,
  routes,
  onMedia,
  serviceHint: '📷 Fotos: mande *antes* ou *depois* e em seguida as fotos da volta no carro (frente, lateral esquerda, traseira, lateral direita).',
  serviceDetail: ({ ctx, service }) => ({ photos: listPhotos(ctx, service.id) }),
};
