import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE } from './helpers.js';

test('Clientes: agenda grande vem aos poucos, com o total', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const names = Array.from({ length: 700 }, (_, i) => `${String.fromCharCode(65 + (i % 26))}nome ${String(i).padStart(3, '0')}`);
  const vcf = names.map((n, i) => `BEGIN:VCARD\nFN:${n}\nTEL:+1407555${String(i).padStart(4, '0')}\nEND:VCARD`).join('\n');
  const imp = await fetch(`${base}/api/contacts/import`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'text/vcard' }, body: vcf }).then((r) => r.json());
  assert.equal(imp.created, 700);

  const get = (qs) => fetch(`${base}/api/contacts?${qs}`, { headers: { Cookie: cookie } });
  const r1 = await get('limit=300');
  const page1 = await r1.json();
  assert.equal(r1.headers.get('x-total-count'), String(ctx.db.prepare('SELECT COUNT(*) n FROM contacts').get().n));
  assert.equal(page1.length, 300);
  const page3 = await (await get('limit=300&offset=600')).json();
  assert.equal(page3.length, 100);
  assert.ok(page3.at(-1).name.startsWith('Z'));
  const zs = await get('q=Znome&limit=300');
  assert.equal(zs.headers.get('x-total-count'), String(names.filter((n) => n.startsWith('Z')).length));
});
