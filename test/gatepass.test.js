import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';

test('gate pass: PDF ou foto no serviço; motorista do serviço abre, outros tipos não entram', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone, pin) =>
    (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers.get('set-cookie').split(';')[0];
  const owner = await login(OWNER_PHONE, '1234');
  const drv = await login(DRIVER_PHONE, '5678');
  const driver = ctx.db.prepare('SELECT id FROM users WHERE phone = ?').get(DRIVER_PHONE);
  const json = (method, path, body, cookie = owner) =>
    fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());
  const upload = (id, type, data, name, cookie = owner) =>
    fetch(`${base}/api/services/${id}/docs?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': type }, body: data });

  const s = await json('POST', '/services', { contact_name: 'Leilão', pickup: '1 Auction Way, Orlando FL', driver_id: driver.id });
  const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
  const up = await upload(s.id, 'application/pdf', pdf, 'gate pass 123.pdf');
  assert.equal(up.status, 201);
  const doc = await up.json();
  assert.equal(doc.name, 'gate pass 123.pdf');
  assert.equal((await upload(s.id, 'text/plain', 'oi', 'x.txt')).status, 400);

  const detail = await json('GET', `/services/${s.id}`, undefined, drv);
  assert.deepEqual(detail.docs.map((d) => d.name), ['gate pass 123.pdf']);
  const file = await fetch(`${base}${doc.url}`, { headers: { Cookie: drv } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), pdf);

  // Motorista não apaga o que o dono anexou; o dono apaga.
  assert.equal((await fetch(`${base}/api/docs/${doc.id}`, { method: 'DELETE', headers: { Cookie: drv } })).status, 403);
  assert.equal((await fetch(`${base}/api/docs/${doc.id}`, { method: 'DELETE', headers: { Cookie: owner } })).status, 200);
  assert.equal((await json('GET', `/services/${s.id}`)).docs.length, 0);
});
