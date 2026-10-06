// Monta o sistema: abre o banco, carrega o núcleo e os módulos ligados, e cria o servidor web.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import express from 'express';
import { openDb, migrate } from './db.js';
import { createBot } from './core/bot.js';
import { createCoreData } from './core/data.js';
import core from './core/index.js';
import { verifyToken, readCookie } from './lib/auth.js';
import { HttpError } from './lib/util.js';
import { createGeocoder } from './lib/geo.js';

import vin from './modules/vin/index.js';
import fotos from './modules/fotos/index.js';
import pagamentos from './modules/pagamentos/index.js';
import despesas from './modules/despesas/index.js';
import whatsapp from './modules/whatsapp/index.js';

// Para criar um módulo novo: faça uma pasta em src/modules, exporte o objeto
// do módulo (veja src/modules/README.md) e acrescente ele aqui.
export const AVAILABLE_MODULES = { vin, fotos, pagamentos, despesas, whatsapp };

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Leitor de código de barras para celulares sem leitor próprio (iPhone).
// O .wasm tem que ser da mesma versão que o barcode-detector usa.
const barcodeDetectorFile = createRequire(import.meta.url).resolve('barcode-detector/ponyfill');
const VENDOR = {
  '/vendor/barcode-detector.js': path.join(path.dirname(barcodeDetectorFile), '..', 'iife', 'ponyfill.js'),
  '/vendor/zxing_reader.wasm': createRequire(barcodeDetectorFile).resolve('zxing-wasm/reader/zxing_reader.wasm'),
};

export function createContext(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const db = openDb(config.dbFile);

  const enabled = config.modules.map((name) => {
    const mod = AVAILABLE_MODULES[name];
    if (!mod) throw new Error(`Módulo desconhecido em MODULES: ${name}`);
    return mod;
  });
  const loaded = [core, ...enabled];

  const ctx = {
    config,
    db,
    data: null,
    loaded,
    api: {}, // funções que um módulo oferece para os outros, ex.: ctx.api.vin.decode()
    commands: [],
    flows: {},
    mediaHandlers: [],
    serviceHints: [],
    // Mandar mensagem para alguém. O módulo whatsapp troca esta função pela de verdade.
    send: async () => false,
    log: (...args) => console.log(new Date().toISOString(), ...args),
    has: (name) => loaded.some((m) => m.name === name),
    // Procura endereços no mapa (null = desligado).
    geo: config.geocoder ? createGeocoder() : null,
  };

  for (const mod of loaded) migrate(db, mod.name, mod.migrations);
  ctx.data = createCoreData(db);

  for (const mod of loaded) {
    if (mod.commands) ctx.commands.push(...mod.commands);
    if (mod.flows) Object.assign(ctx.flows, mod.flows);
    if (mod.onMedia) ctx.mediaHandlers.push(mod.onMedia);
    if (mod.serviceHint) ctx.serviceHints.push(mod.serviceHint);
  }
  for (const mod of loaded) mod.setup?.(ctx);

  ctx.bot = createBot(ctx);
  return ctx;
}

export function createApp(ctx) {
  const app = express();
  app.disable('x-powered-by');

  app.use('/api', express.json({ limit: '1mb' }));

  // Rotas sem login (webhook do WhatsApp, primeiro acesso, login).
  for (const mod of ctx.loaded) mod.publicRoutes?.(app, ctx);

  const api = express.Router();
  api.use((req, res, next) => {
    const userId = verifyToken(readCookie(req, 'sess'), ctx.config.secret);
    const user = userId && ctx.db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(userId);
    if (!user) return next(new HttpError(401, 'Faça login.'));
    req.user = user;
    next();
  });
  for (const mod of ctx.loaded) mod.routes?.(api, ctx);
  app.use('/api', api);

  for (const [url, file] of Object.entries(VENDOR)) app.get(url, (req, res) => res.sendFile(file, { maxAge: '30d' }));
  app.use(express.static(publicDir, { index: 'index.html' }));

  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) ctx.log('Erro', err);
    res.status(status).json(status >= 500 ? { error: 'Erro no servidor. Tente de novo.' } : { error: err.message, code: err.code, options: err.options });
  });

  return app;
}
