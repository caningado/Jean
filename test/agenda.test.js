import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, chat, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';
import agenda, { parseWhen, localToIso } from '../src/modules/agenda/index.js';

const TZ = 'America/New_York';

test('agenda: entende "amanhã 9h", "24/10 14:30", "sexta 8am"', () => {
  const now = new Date('2026-10-22T15:00:00Z'); // quinta 11h em NY
  assert.equal(parseWhen('amanhã 9h', TZ, now), localToIso(TZ, 2026, 10, 23, 9, 0));
  assert.equal(parseWhen('24/10 14:30', TZ, now), localToIso(TZ, 2026, 10, 24, 14, 30));
  assert.equal(parseWhen('sexta 8am', TZ, now), localToIso(TZ, 2026, 10, 23, 8, 0));
  assert.equal(parseWhen('hoje 3pm', TZ, now), localToIso(TZ, 2026, 10, 22, 15, 0));
  assert.equal(parseWhen('2026-10-25T07:15', TZ, now), localToIso(TZ, 2026, 10, 25, 7, 15));
  assert.equal(localToIso(TZ, 2026, 10, 23, 9, 0), '2026-10-23T13:00:00.000Z');
  assert.equal(parseWhen('qualquer coisa', TZ, now), null);
});

test('agenda: agendar pelo WhatsApp e pelo painel, lista e lembrete 1 hora antes', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const sent = [];
  ctx.send = async (phone, text) => sent.push({ phone, text });
  const driver = ctx.bot.findUser(DRIVER_PHONE);
  const s = ctx.data.services.create({ pickup: '12 Main St', vehicle: 'Honda Civic', driver_id: driver.id });
  ctx.data.services.setActive(driver.id, s.id);

  const [ok] = await chat(ctx, DRIVER_PHONE, 'agendar amanhã 9h');
  assert.match(ok, /agendado para/);
  assert.ok(ctx.data.services.get(s.id).scheduled_at);
  const [bad] = await chat(ctx, DRIVER_PHONE, 'agendar xyz');
  assert.match(bad, /Não entendi/);
  const [list] = await chat(ctx, OWNER_PHONE, 'agenda');
  assert.match(list, /Honda Civic|Serviço/);

  // Painel: marca para daqui a 30 min.
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) })).headers.get('set-cookie').split(';')[0];
  const soon = new Date(Date.now() + 30 * 60000).toISOString();
  const put = (v) => fetch(`${base}/api/services/${s.id}/agenda`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ scheduled_at: v }) });
  assert.equal((await put('xyz')).status, 400);
  assert.equal((await (await put('2026-12-01T10:30')).json()).scheduled_at, localToIso(TZ, 2026, 12, 1, 10, 30));
  ctx.db.prepare('UPDATE services SET scheduled_at = ? WHERE id = ?').run(soon, s.id);
  const detail = await (await fetch(`${base}/api/services/${s.id}`, { headers: { Cookie: cookie } })).json();
  assert.equal(detail.scheduled_at, soon);

  await agenda.minuteTick({ ctx });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].phone, DRIVER_PHONE);
  assert.match(sent[0].text, /Serviço agendado/);
  await agenda.minuteTick({ ctx });
  assert.equal(sent.length, 1); // só uma vez

  const [off] = await chat(ctx, DRIVER_PHONE, 'agendar cancelar');
  assert.match(off, /tirado/);
  assert.equal(ctx.data.services.get(s.id).scheduled_at, null);
});
