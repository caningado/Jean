import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';

test('número do dia: cada motorista conta 1, 2, 3... e recomeça no dia seguinte', async (t) => {
  const ctx = makeContext();
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const adm = (
    await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) })
  ).headers.get('set-cookie').split(';')[0];
  const jorge = ctx.db.prepare('SELECT * FROM users WHERE phone = ?').get(DRIVER_PHONE);
  let n = 0;
  const novo = async (body) =>
    (await fetch(`${base}/api/services`, { method: 'POST', headers: { Cookie: adm, 'Content-Type': 'application/json' }, body: JSON.stringify({ contact_name: `Cliente ${++n}`, pickup: `${n} Main St`, ...body }) })).json();

  // Na fila, sem motorista: ainda não tem número do dia.
  const fila = await novo({ driver_id: 'fila' });
  assert.equal(fila.driver_ref, null);
  // Passado para o Jorge: é o 1 dele hoje; o próximo é o 2.
  const a = ctx.data.services.update(fila.id, { driver_id: jorge.id });
  assert.equal(a.driver_ref, 1);
  const b = ctx.data.services.update((await novo({ driver_id: 'fila' })).id, { driver_id: jorge.id });
  assert.equal(b.driver_ref, 2);
  assert.equal(ctx.data.services.ref(b, jorge), 2);
  assert.equal(ctx.data.services.ref(b, { id: 1, role: 'dono' }), b.id);

  // Dia seguinte: recomeça no 1. "abrir 1" pelo WhatsApp acha o 1 mais recente dele.
  ctx.db.prepare("UPDATE services SET driver_ref_day = '2000-01-01'").run();
  const c = ctx.data.services.update((await novo({ driver_id: 'fila' })).id, { driver_id: jorge.id });
  assert.equal(c.driver_ref, 1);
  assert.equal(ctx.data.services.byRef(jorge, 1).id, c.id);
  assert.match(ctx.data.services.describe(c, jorge), new RegExp(`Serviço #1\\b`));
});
