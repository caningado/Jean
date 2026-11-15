import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, chat, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';
import manutencao from '../src/modules/manutencao/index.js';

// Na J&J não existe rodízio de pneus, só troca (Caningado, 15/11/2026).
test('caminhão novo não tem rodízio; rodízio antigo sai dos itens e fica no histórico', async (t) => {
  const ctx = makeContext();
  const driver = ctx.db.prepare('SELECT id FROM users WHERE phone = ?').get(DRIVER_PHONE);
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone, pin) =>
    (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers.get('set-cookie').split(';')[0];
  const owner = await login(OWNER_PHONE, '1234');
  const call = (method, path, body) =>
    fetch(`${base}/api${path}`, { method, headers: { Cookie: owner, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());

  const f550 = await call('POST', '/trucks', { name: 'F-550', odometer: 100000, driver_id: driver.id });
  const items = () => ctx.db.prepare('SELECT name FROM maintenance_items WHERE truck_id = ?').all(f550.id).map((i) => i.name);
  assert.ok(!items().some((n) => /rod.zio/i.test(n)), items().join(', '));

  // Caminhão antigo com o item de rodízio e um registro feito: a migração tira o item, o registro fica.
  const now = new Date().toISOString();
  const rod = ctx.db
    .prepare("INSERT INTO maintenance_items (truck_id, name, every_miles, last_miles, created_at) VALUES (?, 'Rodízio dos pneus', 6000, 99000, ?)")
    .run(f550.id, now).lastInsertRowid;
  ctx.db.prepare("INSERT INTO maintenance_log (truck_id, item_id, item_name, miles, done_at) VALUES (?, ?, 'Rodízio dos pneus', 99000, ?)").run(f550.id, rod, now);
  ctx.db.exec(manutencao.migrations.at(-1));
  assert.ok(!items().includes('Rodízio dos pneus'));
  const log = await call('GET', `/trucks/${f550.id}/log`);
  assert.match(JSON.stringify(log), /Rodízio dos pneus/);

  // "fiz pneu" no WhatsApp registra uma troca de pneu.
  const [r] = await chat(ctx, DRIVER_PHONE, 'fiz pneu');
  assert.match(r, /Troca de pneu do F-550 registrada/);
  assert.ok(ctx.db.prepare("SELECT 1 FROM maintenance_log WHERE truck_id = ? AND item_name = 'Troca de pneu'").get(f550.id));

  // Apagar um item que já tem registro não dá erro e não apaga o histórico.
  const oleo = ctx.db.prepare("SELECT id FROM maintenance_items WHERE truck_id = ? AND name = 'Troca de óleo'").get(f550.id);
  await chat(ctx, DRIVER_PHONE, 'fiz oleo');
  assert.deepEqual(await call('DELETE', `/maintenance/${oleo.id}`), { ok: true });
  assert.ok(ctx.db.prepare("SELECT 1 FROM maintenance_log WHERE item_name = 'Troca de óleo'").get());
});
