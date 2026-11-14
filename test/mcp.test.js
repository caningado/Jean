import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makeContext } from './helpers.js';

async function startServer(t, ctx) {
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('mcp: o Claude conecta em /mcp e roda a ferramenta de teste', async (t) => {
  const ctx = makeContext();
  const base = await startServer(t, ctx);
  const client = new Client({ name: 'teste', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  t.after(() => client.close());

  assert.equal(client.getServerVersion().name, 'towing-jj');
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name), ['teste']);
  const result = await client.callTool({ name: 'teste', arguments: {} });
  assert.match(result.content[0].text, /Conectado ao sistema Towing J&J/);
});

test('mcp: GET e DELETE em /mcp respondem 405, e o resto do sistema continua igual', async (t) => {
  const ctx = makeContext();
  const base = await startServer(t, ctx);
  assert.equal((await fetch(`${base}/mcp`)).status, 405);
  assert.equal((await fetch(`${base}/mcp`, { method: 'DELETE' })).status, 405);
  // O painel continua pedindo login.
  assert.equal((await fetch(`${base}/api/services`)).status, 401);
});

test('mcp: vem ligado mesmo com MODULES antigo, e MCP=off desliga', () => {
  const old = loadConfig({ DATA_DIR: '/tmp/x', SESSION_SECRET: 's', MODULES: 'vin,fotos' });
  assert.deepEqual(old.modules, ['vin', 'fotos', 'mcp']);
  const off = loadConfig({ DATA_DIR: '/tmp/x', SESSION_SECRET: 's', MODULES: 'vin,mcp', MCP: 'off' });
  assert.deepEqual(off.modules, ['vin']);
  assert.ok(loadConfig({ DATA_DIR: '/tmp/x', SESSION_SECRET: 's' }).modules.includes('mcp'));
});
