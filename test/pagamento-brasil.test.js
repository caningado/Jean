import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, migrate } from '../src/db.js';
import core from '../src/core/index.js';
import pagamentos, { parseMethod, cashInHand } from '../src/modules/pagamentos/index.js';
import { makeContext, chat, DRIVER_PHONE } from './helpers.js';

test('pagamento no Brasil: robô aceita *pago 150 brasil* e não conta como dinheiro em mãos', async () => {
  assert.deepEqual(parseMethod('Brasil'), { method: 'brasil' });
  assert.deepEqual(parseMethod('pix'), { method: 'brasil' });
  const ctx = makeContext();
  const user = ctx.db.prepare('SELECT * FROM users WHERE phone = ?').get(DRIVER_PHONE);
  const service = ctx.data.services.create({ pickup: '12 Main St, Framingham', price_cents: 20000, driver_id: user.id });
  ctx.db.prepare('UPDATE users SET active_service_id = ? WHERE id = ?').run(service.id, user.id);
  const [paid] = await chat(ctx, DRIVER_PHONE, 'pago 150 brasil');
  assert.match(paid, /\$150\.00 recebido por Brasil/);
  const p = ctx.db.prepare('SELECT * FROM payments').get();
  assert.equal(p.method, 'brasil');
  assert.equal(p.status, 'recebido');
  assert.equal(cashInHand(ctx)[0]?.in_hand_cents || 0, 0);
});

test('banco antigo: a migração mantém os pagamentos e o link do Square', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guincho-mig-')), 'db.sqlite'));
  migrate(db, core.name, core.migrations);
  migrate(db, pagamentos.name, pagamentos.migrations.slice(0, 4));
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users (id, name, phone, role, pin_hash, created_at) VALUES (1, 'Jorge', '1', 'motorista', 'x', ?)").run(now);
  const sid = Number(db.prepare("INSERT INTO services (created_at) VALUES (?)").run(now).lastInsertRowid);
  db.prepare("INSERT INTO payments (id, service_id, amount_cents, method, status, received_by, created_at, received_at, checked_at) VALUES (7, ?, 5000, 'zelle', 'recebido', 1, ?, ?, ?)").run(sid, now, now, now);
  db.prepare("INSERT INTO square_links (service_id, amount_cents, url, payment_id, created_at) VALUES (?, 5000, 'https://x', 7, ?)").run(sid, now);
  assert.throws(() => db.prepare("INSERT INTO payments (service_id, amount_cents, method, created_at) VALUES (?, 1, 'brasil', ?)").run(sid, now));

  migrate(db, pagamentos.name, pagamentos.migrations);
  const p = db.prepare('SELECT * FROM payments WHERE id = 7').get();
  assert.equal(p.amount_cents, 5000);
  assert.equal(p.checked_at, now);
  db.prepare("INSERT INTO payments (service_id, amount_cents, method, created_at) VALUES (?, 1, 'brasil', ?)").run(sid, now);
  assert.equal(db.prepare('SELECT payment_id FROM square_links').get().payment_id, 7);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  for (const idx of ['payments_service', 'square_links_order']) assert.ok(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(idx));
});
