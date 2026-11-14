import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makeContext, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';
import { createLoginGuard, allowedRedirect, LIMITS } from '../src/modules/mcp/oauth.js';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function startServer(t, overrides = {}) {
  const ctx = makeContext(overrides);
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  ctx.config.publicUrl = base;
  return { ctx, base };
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// Faz o caminho que o Claude faz: registra, abre o login, digita a chave e troca o código pelo crachá.
async function register(base, redirect = REDIRECT) {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  return { status: res.status, body: await res.json() };
}

async function openLogin(base, clientId) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const url = new URL(`${base}/authorize`);
  url.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: `${base}/mcp` });
  const res = await fetch(url);
  const html = await res.text();
  const pedido = html.match(/name="pedido" value="([^"]+)"/)?.[1];
  return { res, html, pedido, verifier };
}

const typePin = (base, pedido, pin, ip = '1.1.1.1', telefone = OWNER_PHONE) =>
  fetch(`${base}/mcp/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': ip },
    body: new URLSearchParams({ pedido, telefone, pin }),
  });

async function connect(base) {
  const { body: client } = await register(base);
  const { pedido, verifier } = await openLogin(base, client.client_id);
  const login = await typePin(base, pedido, '1234');
  assert.equal(login.status, 302);
  const back = new URL(login.headers.get('location'));
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get('state'), 'xyz');
  const tokenRes = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code'), code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT }),
  });
  assert.equal(tokenRes.status, 200);
  return { client, tokens: await tokenRes.json(), code: back.searchParams.get('code'), verifier };
}

async function mcpClient(t, base, token) {
  const client = new Client({ name: 'teste', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  return client;
}

test('mcp: sem crachá o /mcp responde 401 e aponta para o login', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"/);
  const bad = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer inventado' } });
  assert.equal(bad.status, 401);

  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${base}/mcp`);
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.authorization_endpoint, `${base}/authorize`);
  assert.equal(as.registration_endpoint, `${base}/register`);
});

test('mcp: login com telefone e PIN do dono dá o crachá, e o Claude usa a ferramenta de teste', async (t) => {
  const { base } = await startServer(t);
  const { client, tokens, code, verifier } = await connect(base);
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.equal(tokens.expires_in, 3600);

  const mcp = await mcpClient(t, base, tokens.access_token);
  assert.equal(mcp.getServerVersion().name, 'towing-jj');
  const { tools } = await mcp.listTools();
  assert.ok(tools.map((x) => x.name).includes('teste'));
  const result = await mcp.callTool({ name: 'teste', arguments: {} });
  assert.match(result.content[0].text, /Conectado ao sistema Towing J&J como Caningado/);

  // O código só vale uma vez.
  const again = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT }),
  });
  assert.equal(again.status, 400);

  // Renovação: troca o crachá, e o de renovação antigo deixa de valer.
  const renew = (rt) =>
    fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: client.client_id }),
    });
  const r1 = await renew(tokens.refresh_token);
  assert.equal(r1.status, 200);
  const fresh = await r1.json();
  assert.notEqual(fresh.access_token, tokens.access_token);
  assert.equal((await renew(tokens.refresh_token)).status, 400);
  await mcpClient(t, base, fresh.access_token);
});

test('mcp: PIN errado não entra, motorista não conecta, e tem limite de tentativas', async (t) => {
  const { base, ctx } = await startServer(t);
  const sent = [];
  ctx.send = async (phone, text) => sent.push({ phone, text });
  const { body: client } = await register(base);
  const { html, pedido } = await openLogin(base, client.client_id);
  assert.match(html, /telefone e o PIN que você usa no painel/);

  const wrong = await typePin(base, pedido, '9999');
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /Telefone ou PIN errado/);
  assert.equal((await typePin(base, pedido, '1234', '1.1.1.1', '15085559999')).status, 401);
  // Motorista com o PIN certo: não pode conectar o Claude.
  const driver = await typePin(base, pedido, '5678', '3.3.3.3', DRIVER_PHONE);
  assert.equal(driver.status, 403);
  assert.match(await driver.text(), /Só o dono/);

  for (let i = 2; i < LIMITS.perIp.max; i++) await typePin(base, pedido, '9999');
  // Travado neste endereço, mesmo com o PIN certo.
  assert.equal((await typePin(base, pedido, '1234')).status, 429);
  // De outro endereço ainda consegue.
  assert.equal((await typePin(base, pedido, '1234', '2.2.2.2')).status, 302);
  assert.equal(sent.length, 0);
});

test('mcp: 10 PINs errados no mesmo telefone travam esse telefone e avisam o dono', async (t) => {
  const { base, ctx } = await startServer(t);
  const sent = [];
  ctx.send = async (phone, text) => sent.push({ phone, text });
  const { body: client } = await register(base);
  const { pedido } = await openLogin(base, client.client_id);
  for (let i = 0; i < LIMITS.perPhone.max; i++) await typePin(base, pedido, '0000', `5.5.5.${i}`);
  const locked = await typePin(base, pedido, '1234', '6.6.6.6');
  assert.equal(locked.status, 429);
  assert.match(await locked.text(), /24 horas/);
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].phone, OWNER_PHONE);
  assert.match(sent[0].text, /troque o seu PIN/);
});

test('mcp: trava geral depois de muitos erros', () => {
  let t = 0;
  const locks = [];
  const guard = createLoginGuard({ now: () => t, onLock: (k) => locks.push(k) });
  for (let i = 0; i < LIMITS.global.max; i++) guard.fail(`10.0.0.${i}`, `1508555${String(i).padStart(4, '0')}`);
  assert.deepEqual(locks, ['geral']);
  assert.match(guard.blocked('9.9.9.9', '15085550100'), /travado por 1 hora/);
  t += LIMITS.global.lockMs + 1;
  assert.equal(guard.blocked('9.9.9.9', '15085550100'), null);
});

test('mcp: só aceita voltar para o Claude ou para o próprio computador', async (t) => {
  assert.ok(allowedRedirect('https://claude.ai/api/mcp/auth_callback'));
  assert.ok(allowedRedirect('https://claude.com/api/mcp/auth_callback'));
  assert.ok(allowedRedirect('http://localhost:6274/oauth/callback'));
  assert.ok(!allowedRedirect('https://claude.ai.evil.com/cb'));
  assert.ok(!allowedRedirect('http://claude.ai/cb'));
  const { base } = await startServer(t);
  assert.equal((await register(base, 'https://evil.example.com/cb')).status, 400);
});

test('mcp: GET e DELETE em /mcp respondem 405, e o painel continua pedindo login', async (t) => {
  const { base } = await startServer(t);
  assert.equal((await fetch(`${base}/mcp`)).status, 405);
  assert.equal((await fetch(`${base}/mcp`, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(`${base}/api/services`)).status, 401);
});

test('mcp: vem ligado mesmo com MODULES antigo, e MCP=off desliga', () => {
  const old = loadConfig({ DATA_DIR: '/tmp/x', SESSION_SECRET: 's', MODULES: 'vin,fotos' });
  assert.deepEqual(old.modules, ['vin', 'fotos', 'mcp']);
  const off = loadConfig({ DATA_DIR: '/tmp/x', SESSION_SECRET: 's', MODULES: 'vin,mcp', MCP: 'off' });
  assert.deepEqual(off.modules, ['vin']);
  assert.ok(loadConfig({ DATA_DIR: '/tmp/x', SESSION_SECRET: 's' }).modules.includes('mcp'));
  assert.equal(loadConfig({ DATA_DIR: '/tmp/x', SESSION_SECRET: 's', RENDER_EXTERNAL_URL: 'https://jean.onrender.com/' }).publicUrl, 'https://jean.onrender.com');
});
