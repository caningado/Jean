import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE } from './helpers.js';
import { startOfWeekIso, startOfDayIso } from '../src/lib/util.js';

test('Entregues: hoje, semana e mês pelo dia da entrega', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const json = (method, path, body) => fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await json('POST', '/services', { contact_name: `Cliente ${i}`, pickup: '12 Main St, Orlando FL', status: 'concluido' })).id);
  const day = 86400000;
  const now = Date.now();
  // um entregue hoje, um há 40 dias, um há 3 anos
  const set = ctx.db.prepare('UPDATE services SET status = ?, completed_at = ? WHERE id = ?');
  set.run('concluido', new Date(now).toISOString(), ids[0]);
  set.run('concluido', new Date(now - 40 * day).toISOString(), ids[1]);
  set.run('concluido', new Date(now - 1100 * day).toISOString(), ids[2]);
  const got = async (p) => (await json('GET', `/services?status=concluido${p ? `&periodo=${p}` : ''}`)).map((s) => s.id).sort();
  assert.deepEqual(await got('dia'), [ids[0]]);
  assert.deepEqual(await got('semana'), [ids[0]]);
  assert.deepEqual(await got('mes'), [ids[0]]);
  assert.deepEqual(await got(''), [...ids].sort());
  // segunda-feira desta semana, nunca depois de hoje
  const tz = ctx.config.timeZone;
  assert.ok(startOfWeekIso(tz) <= startOfDayIso(tz));
  assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(new Date(startOfWeekIso(tz)).getTime() + 3600000)), 'Mon');
});
