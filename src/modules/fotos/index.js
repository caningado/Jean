// Módulo de fotos: antes (retirada), depois (entrega) e VIN, todas opcionais,
// guardadas junto do serviço com data e hora.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { FlowError } from '../../core/bot.js';
import { simplify, nowIso, HttpError } from '../../lib/util.js';
import { readVinBarcode } from '../../lib/barcode.js';
import { coordsOf } from '../../lib/validate.js';
import { readPhotoMeta, takenToIso, stampPhoto, stampDate, coordsText } from '../../lib/carimbo.js';

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
  // Documentos do serviço (PDF ou foto), como o gate pass do leilão para retirar o carro.
  `CREATE TABLE service_docs (
     id INTEGER PRIMARY KEY,
     service_id INTEGER NOT NULL REFERENCES services(id),
     kind TEXT NOT NULL DEFAULT 'gatepass',
     name TEXT,
     file TEXT NOT NULL,
     mime TEXT NOT NULL,
     uploaded_by INTEGER REFERENCES users(id),
     created_at TEXT NOT NULL
   );
   CREATE INDEX service_docs_service ON service_docs(service_id);`,
  // Carimbo: onde e quando a foto foi tirada, e a cópia com isso escrito na foto.
  // place_source: foto (GPS da própria foto), celular (GPS do painel), whatsapp (localização 📍
  // que o motorista mandou), servico (endereço de retirada/entrega do serviço).
  `ALTER TABLE photos ADD COLUMN stamped_file TEXT;
   ALTER TABLE photos ADD COLUMN lat REAL;
   ALTER TABLE photos ADD COLUMN lng REAL;
   ALTER TABLE photos ADD COLUMN address TEXT;
   ALTER TABLE photos ADD COLUMN taken_at TEXT;
   ALTER TABLE photos ADD COLUMN place_source TEXT;
   CREATE TABLE user_locations (
     user_id INTEGER PRIMARY KEY REFERENCES users(id),
     lat REAL NOT NULL,
     lng REAL NOT NULL,
     at TEXT NOT NULL
   );`,
  // De onde veio a foto: 'caixa' = o dono mandou ao Jay e foi anexada ao serviço (para o
  // motorista saber qual é o carro). Essas não levam carimbo (não são a prova da retirada).
  `ALTER TABLE photos ADD COLUMN origin TEXT;`,
];

// Localização 📍 do WhatsApp vale para as fotos dos próximos 60 minutos.
const LOCATION_MINUTES = 60;

const DOC_TYPES = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heic', 'image/gif': '.gif' };

// Grava o gate pass (PDF ou foto) no serviço. Usado pelo painel e pelo robô do WhatsApp.
function saveDoc(ctx, { serviceId, buffer, mime, name, userId }) {
  const clean = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').trim().slice(0, 120) || `gate pass${DOC_TYPES[mime]}`;
  const dir = path.join(ctx.config.uploadsDir, `servico-${serviceId}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${Date.now()}-gatepass-${crypto.randomBytes(3).toString('hex')}${DOC_TYPES[mime]}`;
  fs.writeFileSync(path.join(dir, file), buffer);
  const info = ctx.db
    .prepare('INSERT INTO service_docs (service_id, kind, name, file, mime, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(serviceId, 'gatepass', clean, path.join(`servico-${serviceId}`, file), mime, userId, nowIso());
  return Number(info.lastInsertRowid);
}

// Link que abre o arquivo original sem login, por 1 hora: o leitor de PDF do celular
// (fora do app) não tem o login do app, principalmente no iPhone.
const LINK_HOURS = 1;
const docSig = (ctx, id, exp) => crypto.createHmac('sha256', ctx.config.secret).update(`doc:${id}:${exp}`).digest('base64url');
function docLink(ctx, doc) {
  const exp = Math.floor(Date.now() / 1000) + LINK_HOURS * 3600;
  const name = encodeURIComponent((doc.name || 'gatepass').replace(/[\\/]/g, ' '));
  return `/arquivo/${doc.id}/${exp}.${docSig(ctx, doc.id, exp)}/${name}`;
}

function listDocs(ctx, serviceId) {
  return ctx.db
    .prepare('SELECT id, kind, name, mime, uploaded_by, created_at FROM service_docs WHERE service_id = ? ORDER BY id')
    .all(serviceId)
    .map((d) => ({ ...d, url: `/api/docs/${d.id}/file`, open_url: docLink(ctx, d) }));
}

function publicRoutes(app, ctx) {
  app.get('/arquivo/:id/:token/:name', (req, res) => {
    const id = Number(req.params.id);
    const [exp, sig] = String(req.params.token).split('.');
    const expected = Buffer.from(docSig(ctx, id, exp));
    const given = Buffer.from(sig || '');
    const doc = ctx.db.prepare('SELECT * FROM service_docs WHERE id = ?').get(id);
    if (!doc || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return res.status(404).send('Arquivo não encontrado.');
    if (!(Number(exp) * 1000 > Date.now())) return res.status(410).send('Este link expirou. Abra o arquivo de novo pelo app.');
    res.type(doc.mime);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.name || 'gatepass')}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(path.join(ctx.config.uploadsDir, doc.file));
  });
}

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

// Nome das fotos dentro do .zip.
const KIND_FILE = { antes: 'antes', depois: 'depois', vin: 'VIN', outro: 'outra' };

const EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/gif': '.gif' };

// ---------- fotos que o dono mandou ao Jay (caixa de entrada) ----------

// Anexa ao serviço uma foto da caixa de entrada (uma cópia: a da caixa continua lá).
function attachInboxPhoto(ctx, { serviceId, file, mime, userId }) {
  const buffer = fs.readFileSync(file);
  return savePhoto(ctx, { serviceId, kind: 'outro', buffer, mime, userId, origin: 'caixa' });
}

function savePhoto(ctx, { serviceId, kind, angle = null, buffer, mime, userId, place = null, origin = null }) {
  const dir = path.join(ctx.config.uploadsDir, `servico-${serviceId}`);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${kind}-${crypto.randomBytes(3).toString('hex')}${EXTENSIONS[mime] || '.jpg'}`;
  fs.writeFileSync(path.join(dir, name), buffer);
  const info = ctx.db
    .prepare('INSERT INTO photos (service_id, kind, angle, file, mime, uploaded_by, created_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(serviceId, kind, angle, path.join(`servico-${serviceId}`, name), mime || 'image/jpeg', userId, nowIso(), origin);
  const id = Number(info.lastInsertRowid);
  // O carimbo demora 1 ou 2 segundos: é feito depois, sem segurar a resposta.
  if (ctx.config.fotoCarimbo && !origin) queueStamp(ctx, id, buffer, place);
  return id;
}

// ---------- carimbo (data, hora e endereço escritos na foto) ----------
const stampQueues = new WeakMap();
function queueStamp(ctx, id, buffer, place) {
  const next = (stampQueues.get(ctx) || Promise.resolve()).then(() =>
    stamp(ctx, id, buffer, place).catch((err) => ctx.log(`Fotos: não consegui carimbar a foto ${id}`, err.message))
  );
  stampQueues.set(ctx, next);
}

// Lugar da foto, do mais certo para o menos certo: GPS gravado na foto, GPS do celular no
// painel, localização 📍 que o motorista mandou no WhatsApp há pouco, endereço do serviço.
async function findPlace(ctx, photo, meta, given) {
  if (meta.lat != null) return { lat: meta.lat, lng: meta.lng, source: 'foto' };
  if (given?.lat != null) return { lat: given.lat, lng: given.lng, source: given.source || 'celular' };
  const recent = ctx.db.prepare('SELECT * FROM user_locations WHERE user_id = ?').get(photo.uploaded_by);
  if (recent && Date.parse(photo.created_at) - Date.parse(recent.at) < LOCATION_MINUTES * 60000) return { lat: recent.lat, lng: recent.lng, source: 'whatsapp' };
  const service = ctx.db.prepare('SELECT pickup, dropoff FROM services WHERE id = ?').get(photo.service_id);
  const where = photo.kind === 'depois' ? service?.dropoff || service?.pickup : service?.pickup || service?.dropoff;
  if (!where) return null;
  const coords = coordsOf(where);
  if (coords) {
    const [lat, lng] = coords.split(',').map(Number);
    return { lat, lng, source: 'servico' };
  }
  return /https?:\/\//i.test(where) ? null : { address: where, source: 'servico' };
}

async function stamp(ctx, id, buffer, given) {
  const photo = ctx.db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  if (!photo) return;
  const meta = await readPhotoMeta(buffer);
  const takenAt = takenToIso(meta.taken, ctx.config.timeZone) || given?.takenAt || photo.created_at;
  const place = await findPlace(ctx, photo, meta, given);
  let address = place?.address || null;
  if (!address && place && ctx.geo?.reverse) {
    address = await ctx.geo.reverse(place.lat, place.lng).catch(() => null);
  }
  // Coordenadas só quando não achou o endereço (ficam guardadas e aparecem no painel).
  const lines = [stampDate(takenAt, ctx.config.timeZone), address || (place?.lat != null ? coordsText(place.lat, place.lng) : null)];
  const out = await stampPhoto(buffer, lines);
  let stamped = null;
  if (out) {
    stamped = photo.file.replace(/\.[a-z]+$/i, '') + '-carimbo.jpg';
    fs.writeFileSync(path.join(ctx.config.uploadsDir, stamped), out);
  }
  // A foto pode ter sido apagada enquanto o carimbo era feito.
  const still = ctx.db
    .prepare('UPDATE photos SET stamped_file = ?, lat = ?, lng = ?, address = ?, taken_at = ?, place_source = ? WHERE id = ?')
    .run(stamped, place?.lat ?? null, place?.lng ?? null, address, takenAt, place?.source || null, id);
  if (!Number(still.changes) && stamped) fs.rmSync(path.join(ctx.config.uploadsDir, stamped), { force: true });
}

// Localização 📍 mandada no WhatsApp: guarda para carimbar as próximas fotos.
function noteLocation(ctx, userId, { latitude, longitude }) {
  if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) return;
  ctx.db
    .prepare('INSERT INTO user_locations (user_id, lat, lng, at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, at = excluded.at')
    .run(userId, Number(latitude), Number(longitude), nowIso());
}

// Lugar e hora mandados pelo painel: ?lat=..&lng=..&origem=foto|celular&tirada=2026:11:15 14:20:33-05:00
function placeFromQuery(ctx, q) {
  const lat = Number(q.lat);
  const lng = Number(q.lng);
  const out = {};
  if (q.lat != null && q.lng != null && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng)) {
    Object.assign(out, { lat, lng, source: q.origem === 'foto' ? 'foto' : 'celular' });
  }
  const m = String(q.tirada || '').match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})([+-]\d{2}:\d{2})?$/);
  if (m) out.takenAt = takenToIso({ y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6], offset: m[7] || null }, ctx.config.timeZone);
  return Object.keys(out).length ? out : null;
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
  if (!service) {
    // Sem serviço: pode ser só para ler o VIN ("lê esse VIN pra mim").
    const read = ctx.api.vin && (await ctx.api.vin.readLoose(user, media.buffer, media.mime));
    if (read) return read;
    // Com pessoa de apoio: o robô passa a foto para ela (devolve null e o robô pede ajuda).
    if (ctx.api.ajuda?.ativo?.()) return null;
    return ctx.api.vin
      ? 'Não achei um VIN nessa foto e não tem serviço aberto, então não guardei. Para ler um VIN, tire de perto, reto e sem reflexo. Para guardar fotos do carro, mande *novo* primeiro.'
      : 'Nenhum serviço em andamento, então não guardei a foto. Mande *novo* para começar um serviço.';
  }

  let kind = kindFromText(caption) || currentMode(ctx, user.id) || 'outro';
  // Foto sem legenda com código de barras de VIN: é a etiqueta do VIN, não precisa perguntar.
  if (kind === 'outro' && ctx.api.vin && (await readVinBarcode(media.buffer).catch(() => null))) kind = 'vin';
  if (kind !== 'outro') setMode(ctx, user.id, kind);
  const angle = kind === 'antes' || kind === 'depois' ? angleFromText(caption) || nextAngle(ctx, service.id, kind) : null;
  savePhoto(ctx, { serviceId: service.id, kind, angle, buffer: media.buffer, mime: media.mime, userId: user.id });

  if (kind === 'vin' && ctx.api.vin) {
    return ctx.api.vin.askConfirmation(user, service, media.buffer, media.mime);
  }
  if (kind === 'outro') {
    return ctx.bot.startFlow(user, 'foto_tipo', { serviceId: service.id, since: new Date(Date.now() - 60000).toISOString() });
  }
  return `📷 Foto de *${KIND_LABEL[kind]}* (${ANGLE_LABEL[angle]}) salva no serviço #${ctx.data.services.ref(service, user)} (${countPhotos(ctx, service.id, kind)} no total). ${angleTip(ctx, service.id, kind)}`;
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
        .prepare("SELECT id FROM photos WHERE service_id = ? AND uploaded_by = ? AND kind = 'outro' AND origin IS NULL AND created_at >= ? ORDER BY id")
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
      return `📷 ${what} no serviço #${ctx.data.services.ref(ctx.data.services.get(data.serviceId) || { id: data.serviceId }, user)}. As próximas fotos também vão entrar como ${KIND_LABEL[data.kind]}.${tip}`;
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
        `Ok, pode mandar as fotos de *${KIND_LABEL[kind]}* do serviço #${ctx.data.services.ref(service, user)}, dando a volta no carro:\n` +
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
    .prepare('SELECT p.id, p.kind, p.angle, p.origin, p.created_at, p.taken_at, p.address, p.lat, p.lng, p.place_source, p.stamped_file IS NOT NULL AS stamped, u.name AS uploaded_by_name FROM photos p LEFT JOIN users u ON u.id = p.uploaded_by WHERE service_id = ? ORDER BY p.id')
    .all(serviceId)
    // ?c=1 depois do carimbo: o celular não fica mostrando a foto sem carimbo guardada.
    .map(({ stamped, ...p }) => ({ ...p, url: `/api/photos/${p.id}/file${stamped ? '?c=1' : ''}` }));
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
    const place = placeFromQuery(ctx, req.query);
    const id = savePhoto(ctx, { serviceId: service.id, kind, angle, buffer: req.body, mime: req.headers['content-type'], userId: req.user.id, place });
    res.status(201).json({ id, kind, angle, url: `/api/photos/${id}/file` });
  });

  // Gate pass e outros documentos: PDF ou foto, até 20 MB.
  api.post('/services/:id/docs', express.raw({ type: ['application/pdf', 'image/*'], limit: '20mb' }), (req, res) => {
    const service = findServiceFor(ctx, req.user, req.params.id);
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!DOC_TYPES[mime]) throw new HttpError(400, 'Mande um PDF ou uma foto.');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'O arquivo está vazio.');
    const id = saveDoc(ctx, { serviceId: service.id, buffer: req.body, mime, name: req.query.name, userId: req.user.id });
    res.status(201).json(listDocs(ctx, service.id).find((d) => d.id === id));
  });

  api.get('/docs/:id/file', (req, res) => {
    const doc = ctx.db.prepare('SELECT * FROM service_docs WHERE id = ?').get(Number(req.params.id));
    if (!doc) throw new HttpError(404, 'Documento não encontrado.');
    findServiceFor(ctx, req.user, doc.service_id);
    res.type(doc.mime);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.name || 'gatepass')}`);
    res.sendFile(path.join(ctx.config.uploadsDir, doc.file));
  });

  api.delete('/docs/:id', (req, res) => {
    const doc = ctx.db.prepare('SELECT * FROM service_docs WHERE id = ?').get(Number(req.params.id));
    if (!doc) throw new HttpError(404, 'Documento não encontrado.');
    findServiceFor(ctx, req.user, doc.service_id);
    if (req.user.role !== 'dono' && doc.uploaded_by !== req.user.id) throw new HttpError(403, 'Só o ADM pode apagar este documento.');
    ctx.db.prepare('DELETE FROM service_docs WHERE id = ?').run(doc.id);
    fs.rmSync(path.join(ctx.config.uploadsDir, doc.file), { force: true });
    res.json({ ok: true });
  });

  api.get('/photos/:id/file', (req, res) => {
    const photo = ctx.db.prepare('SELECT * FROM photos WHERE id = ?').get(Number(req.params.id));
    if (!photo) throw new HttpError(404, 'Foto não encontrada.');
    findServiceFor(ctx, req.user, photo.service_id);
    // Mostra a foto carimbada; ?original=1 abre a foto como chegou.
    if (photo.stamped_file && req.query.original == null) {
      res.type('image/jpeg');
      return res.sendFile(path.join(ctx.config.uploadsDir, photo.stamped_file));
    }
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
    const photo = ctx.db.prepare('SELECT * FROM photos WHERE id = ?').get(Number(req.params.id));
    if (!photo) throw new HttpError(404, 'Foto não encontrada.');
    // O motorista apaga as fotos do serviço dele enquanto trabalha; depois de entregue, só o dono.
    const service = findServiceFor(ctx, req.user, photo.service_id);
    if (req.user.role !== 'dono' && (service.status === 'concluido' || service.status === 'cancelado')) {
      throw new HttpError(403, 'Serviço já entregue: só o ADM pode apagar fotos.');
    }
    ctx.db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
    fs.rmSync(path.join(ctx.config.uploadsDir, photo.file), { force: true });
    if (photo.stamped_file) fs.rmSync(path.join(ctx.config.uploadsDir, photo.stamped_file), { force: true });
    res.json({ ok: true });
  });
}

export default {
  name: 'fotos',
  // Fotos para o .zip da planilha: uma pasta por serviço.
  exportFiles({ ctx, from, to, userId }) {
    const rows = ctx.db
      .prepare(
        `SELECT p.*, c.name AS contact_name FROM photos p JOIN services s ON s.id = p.service_id LEFT JOIN contacts c ON c.id = s.contact_id
         WHERE s.created_at >= ? AND s.created_at < ? ${userId ? 'AND s.driver_id = ?' : ''} ORDER BY p.service_id, p.id`
      )
      .all(from, to, ...(userId ? [userId] : []));
    const clean = (text) => String(text).replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    const used = new Set();
    const docs = ctx.db
      .prepare(
        `SELECT d.*, c.name AS contact_name FROM service_docs d JOIN services s ON s.id = d.service_id LEFT JOIN contacts c ON c.id = s.contact_id
         WHERE s.created_at >= ? AND s.created_at < ? ${userId ? 'AND s.driver_id = ?' : ''} ORDER BY d.service_id, d.id`
      )
      .all(from, to, ...(userId ? [userId] : []));
    const docFiles = docs.map((d) => {
      const folder = clean(`Serviço ${d.service_id}${d.contact_name ? ' - ' + d.contact_name : ''}`);
      const ext = path.extname(d.file);
      let name = `fotos/${folder}/gate pass${ext}`;
      for (let n = 2; used.has(name); n++) name = `fotos/${folder}/gate pass ${n}${ext}`;
      used.add(name);
      return { name, path: path.join(ctx.config.uploadsDir, d.file) };
    });
    return [...docFiles, ...rows.map((p) => {
      const folder = clean(`Serviço ${p.service_id}${p.contact_name ? ' - ' + p.contact_name : ''}`);
      const label = clean([p.origin === 'caixa' ? 'do ADM' : KIND_FILE[p.kind] || p.kind, p.angle ? ANGLE_LABEL[p.angle] || p.angle : ''].filter(Boolean).join(' - '));
      const file = p.stamped_file || p.file; // no .zip vai a foto carimbada
      const ext = path.extname(file) || '.jpg';
      let name = `fotos/${folder}/${label}${ext}`;
      for (let n = 2; used.has(name); n++) name = `fotos/${folder}/${label} ${n}${ext}`;
      used.add(name);
      return { name, path: path.join(ctx.config.uploadsDir, file) };
    })];
  },
  exportColumns: (ctx) => {
    const count = ctx.db.prepare('SELECT COUNT(*) AS n FROM photos WHERE service_id = ?');
    return [{ header: 'Fotos', width: 7, type: 'number', value: (s) => count.get(s.id).n }];
  },
  label: 'Fotos',
  migrations,
  commands,
  flows,
  routes,
  publicRoutes,
  onMedia,
  setup(ctx) {
    ctx.api.fotos = {
      // "antes"/"depois" ligado: as próximas fotos são do carro, nem precisa olhar o que são.
      mode: (userId) => currentMode(ctx, userId),
      docTypes: DOC_TYPES,
      saveDoc: (doc) => saveDoc(ctx, doc),
      noteLocation: (userId, location) => noteLocation(ctx, userId, location),
      attachInboxPhoto: (photo) => attachInboxPhoto(ctx, photo),
      list: (serviceId) => ctx.db.prepare('SELECT * FROM photos WHERE service_id = ? ORDER BY id').all(serviceId),
      fileOf: (photo) => path.join(ctx.config.uploadsDir, photo.stamped_file || photo.file),
      kindLabel: KIND_LABEL,
      angleLabel: ANGLE_LABEL,
      // Para os testes: espera os carimbos que estão na fila.
      stamped: () => stampQueues.get(ctx) || Promise.resolve(),
    };
  },
  serviceHint: '📷 Fotos: mande *antes* ou *depois* e em seguida as fotos da volta no carro (frente, lateral esquerda, traseira, lateral direita).',
  serviceDetail: ({ ctx, service }) => ({ photos: listPhotos(ctx, service.id), docs: listDocs(ctx, service.id) }),
};
