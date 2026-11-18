import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';

test('Link das fotos para o WhatsApp do cliente: só as fotos marcadas, sem login', async (t) => {
  const ctx = makeContext();
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone, pin) =>
    (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers.get('set-cookie').split(';')[0];
  const dono = await login(OWNER_PHONE, '1234');
  const jorge = await login(DRIVER_PHONE, '5678');
  const call = (c, method, path, body, type = 'application/json') =>
    fetch(`${base}/api${path}`, { method, headers: { Cookie: c, 'Content-Type': type }, body: body && (type === 'application/json' ? JSON.stringify(body) : body) });
  const jpg = Buffer.from([255, 216, 255, 217]);

  const s = await (await call(dono, 'POST', '/services', { contact_name: 'Ana', contact_phone: '4075551234', pickup: '12 Main St, Orlando FL', price: '150' })).json();
  const outro = await (await call(dono, 'POST', '/services', { contact_name: 'Bia', pickup: '1 Oak St, Orlando FL', price: '90' })).json();
  const foto = async (sid) => (await (await call(dono, 'POST', `/services/${sid}/photos?kind=antes&angle=frente`, jpg, 'image/jpeg')).json()).id;
  const a = await foto(s.id);
  const b = await foto(s.id);
  const deOutro = await foto(outro.id);

  // Foto de outro serviço não entra no link.
  const res = await call(dono, 'POST', `/services/${s.id}/photos/link`, { ids: [b, deOutro] });
  assert.equal(res.status, 200);
  const link = await res.json();
  assert.equal(link.count, 1);
  const path = new URL(link.url).pathname;
  assert.match(path, /^\/fotos\//);

  // O cliente abre sem login e vê só a foto marcada.
  const page = await fetch(base + path);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Vehicle photos \(1\)/);
  assert.match(html, /og:image/);
  const img = await fetch(`${base}${path}/1.jpg`);
  assert.equal(img.status, 200);
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), jpg);
  assert.equal((await fetch(`${base}${path}/2.jpg`)).status, 404);

  // Link mexido não abre.
  const bad = path.replace(/-[\w-]{22}$/, '-' + 'x'.repeat(22));
  assert.equal((await fetch(base + bad)).status, 404);

  // Sem foto marcada: erro; motorista de fora não gera link de serviço que não é dele.
  assert.equal((await call(dono, 'POST', `/services/${s.id}/photos/link`, { ids: [] })).status, 400);
  assert.equal((await call(jorge, 'POST', `/services/${s.id}/photos/link`, { ids: [a] })).status, 404);
});
