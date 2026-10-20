import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsAppClient } from '../src/modules/whatsapp/index.js';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';

const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

test('foto do Jay: acha o app, sobe a imagem e grava no perfil do número', async () => {
  const calls = [];
  const client = createWhatsAppClient({ whatsapp: { token: 'tk', phoneNumberId: '999', apiVersion: 'v21.0' } }, async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.endsWith('/app')) return json({ id: '42' });
    if (url.includes('/42/uploads')) return json({ id: 'upload:abc' });
    if (url.endsWith('/upload:abc')) return json({ h: 'HANDLE' });
    return json({ success: true });
  });
  await client.setProfilePhoto(Buffer.from('png!'), 'image/png');
  assert.match(calls[1].url, /\/42\/uploads\?file_length=4&file_type=image%2Fpng/);
  assert.equal(calls[2].opts.headers.Authorization, 'OAuth tk');
  assert.equal(calls[2].opts.headers.file_offset, '0');
  assert.match(calls[3].url, /\/999\/whatsapp_business_profile$/);
  assert.deepEqual(JSON.parse(calls[3].opts.body), { messaging_product: 'whatsapp', profile_picture_handle: 'HANDLE' });
});

test('botão do painel: só o ADM, e usa a foto do Jay', async (t) => {
  const ctx = makeContext();
  let got = null;
  ctx.api.whatsapp.client = { configured: true, setProfilePhoto: async (buf, mime) => (got = { size: buf.length, mime }) };
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const login = async (phone, pin) =>
    (await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers.get('set-cookie').split(';')[0];
  const post = (cookie) => fetch(`${base}/whatsapp/foto-jay`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal((await post(await login(DRIVER_PHONE, '5678'))).status, 403);
  const r = await post(await login(OWNER_PHONE, '1234'));
  assert.equal(r.status, 200);
  assert.equal(got.mime, 'image/png');
  assert.ok(got.size > 1000);
});
