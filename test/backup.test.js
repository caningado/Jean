import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import { runDaily } from '../src/lib/daily.js';
import { makeContext, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';

async function start(t, env = {}) {
  const ctx = makeContext({ TIME_ZONE: 'America/New_York', ...env });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone, pin) =>
    (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers.get('set-cookie').split(';')[0];
  return { ctx, base, login };
}

function unzip(buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unzip-'));
  fs.writeFileSync(path.join(dir, 'b.zip'), buf);
  execFileSync('unzip', ['-q', 'b.zip', '-d', 'out'], { cwd: dir });
  return path.join(dir, 'out');
}

test('backup: zip com o banco e as fotos, só para o dono', async (t) => {
  const { ctx, base, login } = await start(t);
  ctx.data.services.create({ pickup: '12 Main St, Oviedo', price_cents: 15000 });
  fs.mkdirSync(path.join(ctx.config.uploadsDir, '1'), { recursive: true });
  fs.writeFileSync(path.join(ctx.config.uploadsDir, '1', 'foto.jpg'), Buffer.from('jpegdata'));

  const owner = await login(OWNER_PHONE, '1234');
  const info = await (await fetch(`${base}/api/backup`, { headers: { Cookie: owner } })).json();
  assert.ok(info.files >= 1);
  assert.equal(info.last_download, null);

  const res = await fetch(`${base}/api/backup.zip`, { headers: { Cookie: owner } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /backup-guincho-\d{4}-\d{2}-\d{2}\.zip/);
  const out = unzip(Buffer.from(await res.arrayBuffer()));
  assert.equal(fs.readFileSync(path.join(out, 'uploads/1/foto.jpg'), 'utf8'), 'jpegdata');
  assert.ok(fs.existsSync(path.join(out, 'LEIA-ME.txt')));
  assert.ok(fs.statSync(path.join(out, 'planilha-completa.xlsx')).size > 1000);
  const db = new DatabaseSync(path.join(out, 'guincho.db'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM services').get().n, 1);
  db.close();
  assert.ok((await (await fetch(`${base}/api/backup`, { headers: { Cookie: owner } })).json()).last_download);

  const drv = await login(DRIVER_PHONE, '5678');
  assert.equal((await fetch(`${base}/api/backup.zip`, { headers: { Cookie: drv } })).status, 403);
  assert.equal((await fetch(`${base}/backup/qualquer.zip`)).status, 404);
});

test('backup semanal: link no WhatsApp do dono no domingo, que vence', async (t) => {
  const { ctx, base } = await start(t, { AVISO_HORA: '8' });
  ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('public_url', 'https://guincho.test')").run();
  const sent = [];
  ctx.send = async (phone, text) => {
    sent.push({ phone, text });
    return true;
  };
  const backups = () => sent.filter((m) => /Backup semanal/.test(m.text));
  // Sistema novo numa quarta: espera o domingo.
  await runDaily(ctx, new Date('2026-10-07T13:00:00Z'));
  assert.equal(backups().length, 0);
  // Domingo 11/10, 9h em Nova York.
  await runDaily(ctx, new Date('2026-10-11T13:00:00Z'));
  assert.equal(backups().length, 1);
  assert.equal(backups()[0].phone, OWNER_PHONE);
  // Segunda: não repete.
  await runDaily(ctx, new Date('2026-10-12T13:00:00Z'));
  assert.equal(backups().length, 1);

  const link = backups()[0].text.match(/https:\/\/guincho\.test(\S+)/)[1];
  const res = await fetch(`${base}${link}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  await res.arrayBuffer();
  // Vencido: não abre mais.
  const saved = JSON.parse(ctx.db.prepare("SELECT value FROM settings WHERE key = 'backup_link'").get().value);
  ctx.db.prepare("UPDATE settings SET value = ? WHERE key = 'backup_link'").run(JSON.stringify({ ...saved, expires: '2000-01-01T00:00:00Z' }));
  assert.equal((await fetch(`${base}${link}`)).status, 404);
});
