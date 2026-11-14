// Login do conector do Claude (OAuth 2.1, o que os conectores do Claude usam).
//
// Como funciona, em palavras simples:
// 1. O Claude se apresenta (/register) e pede para entrar (/authorize).
// 2. Abre uma página do sistema pedindo o TELEFONE e o PIN do painel (só o dono/ADM pode conectar).
// 3. Com telefone e PIN certos, o sistema dá ao Claude um "crachá" (token) que vale 1 hora e um de renovação
//    (60 dias). O Claude usa o crachá em cada pedido ao /mcp. Sem crachá válido, o /mcp responde 401.
//    O Claude nunca recebe o PIN, só o crachá, que vence sozinho.
// 4. Errar o PIN tem limite: 5 erros em 15 min trava aquele endereço; 10 erros no mesmo telefone em
//    24 horas trava esse telefone por 24 horas; 20 erros em 1 hora (de qualquer lugar) trava o login
//    do conector para todo mundo por 1 hora. Quando trava, o dono recebe um aviso no WhatsApp.
//
// Os crachás e códigos ficam no banco só como "impressão digital" (hash), nunca o valor de verdade.
import crypto from 'node:crypto';
import express from 'express';
import { verifyPin } from '../../lib/auth.js';
import { normalizePhone } from '../../lib/util.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError, InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

export const ACCESS_TTL_S = 60 * 60; // 1 hora
export const REFRESH_TTL_S = 60 * 24 * 60 * 60; // 60 dias
const CODE_TTL_S = 5 * 60;
const PENDING_TTL_MS = 15 * 60 * 1000;

export const LIMITS = {
  perIp: { max: 5, windowMs: 15 * 60 * 1000 },
  perPhone: { max: 10, windowMs: 24 * 60 * 60 * 1000 },
  global: { max: 20, windowMs: 60 * 60 * 1000, lockMs: 60 * 60 * 1000 },
};

export const migrations = [
  `CREATE TABLE mcp_clients (
     client_id TEXT PRIMARY KEY,
     info TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE mcp_codes (
     code_hash TEXT PRIMARY KEY,
     client_id TEXT NOT NULL,
     user_id INTEGER NOT NULL REFERENCES users(id),
     challenge TEXT NOT NULL,
     redirect_uri TEXT NOT NULL,
     resource TEXT,
     scopes TEXT,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE mcp_tokens (
     token_hash TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
     client_id TEXT NOT NULL,
     user_id INTEGER NOT NULL REFERENCES users(id),
     resource TEXT,
     scopes TEXT,
     expires_at INTEGER NOT NULL,
     revoked INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   );`,
  // Registro de tudo que o Claude fez no sistema (quem, o quê, quando).
  `CREATE TABLE mcp_actions (
     id INTEGER PRIMARY KEY,
     service_id INTEGER,
     tool TEXT NOT NULL,
     details TEXT,
     user_id INTEGER REFERENCES users(id),
     created_at TEXT NOT NULL
   );
   CREATE INDEX mcp_actions_service ON mcp_actions(service_id, id);`,
];

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const nowS = () => Math.floor(Date.now() / 1000);

// Só aceita voltar para o Claude (claude.ai / claude.com) ou para o próprio computador (MCP Inspector).
export function allowedRedirect(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === 'http:') return ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:') return false;
  return ['claude.ai', 'claude.com'].some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`)) || ['localhost', '127.0.0.1'].includes(u.hostname);
}

// Endereço de quem está pedindo (o Render passa no X-Forwarded-For).
export function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || 'desconhecido';
}

// Os donos (ADM) ativos: só eles podem conectar o Claude, e são eles que recebem o aviso de trava.
export function owners(ctx) {
  return ctx.db.prepare("SELECT * FROM users WHERE role = 'dono' AND active = 1 ORDER BY id").all();
}

export function createLoginGuard({ now = () => Date.now(), onLock = () => {} } = {}) {
  const perIp = new Map();
  const perPhone = new Map();
  let globalFails = [];
  let lockedUntil = 0;
  const recent = (list, windowMs) => list.filter((t) => now() - t < windowMs);
  const add = (map, key, windowMs) => {
    const list = [...recent(map.get(key) || [], windowMs), now()];
    map.set(key, list);
    return list.length;
  };
  return {
    // null = pode tentar; texto = motivo do bloqueio
    blocked(ip, phone) {
      if (lockedUntil > now()) return 'Muitas tentativas erradas. O login do conector está travado por 1 hora.';
      if (recent(perIp.get(ip) || [], LIMITS.perIp.windowMs).length >= LIMITS.perIp.max) return 'Muitas tentativas erradas. Espere 15 minutos.';
      if (phone && recent(perPhone.get(phone) || [], LIMITS.perPhone.windowMs).length >= LIMITS.perPhone.max) return 'Muitas tentativas erradas com este telefone. O login do conector para ele está travado por 24 horas.';
      return null;
    },
    fail(ip, phone) {
      add(perIp, ip, LIMITS.perIp.windowMs);
      if (phone && add(perPhone, phone, LIMITS.perPhone.windowMs) === LIMITS.perPhone.max) onLock('telefone');
      globalFails = [...recent(globalFails, LIMITS.global.windowMs), now()];
      if (globalFails.length >= LIMITS.global.max && lockedUntil <= now()) {
        lockedUntil = now() + LIMITS.global.lockMs;
        onLock('geral');
      }
    },
    success(ip, phone) {
      perIp.delete(ip);
      perPhone.delete(phone);
    },
  };
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function loginPage({ pendingId, clientName, error = '', disabled = '', phone = '' }) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Conectar o Claude · Towing J&amp;J</title>
<style>
  body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#f4f4f5;color:#18181b;display:flex;min-height:100vh;align-items:center;justify-content:center}
  main{background:#fff;max-width:380px;width:calc(100% - 32px);padding:24px;border-radius:14px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
  h1{font-size:20px;margin:0 0 8px}p{margin:0 0 16px;line-height:1.4;color:#3f3f46}
  label{font-weight:600;display:block;margin-bottom:6px}
  input{width:100%;box-sizing:border-box;font-size:16px;padding:12px;border:1px solid #d4d4d8;border-radius:10px}
  button{margin-top:16px;width:100%;font-size:16px;padding:12px;border:0;border-radius:10px;background:#1d4ed8;color:#fff;font-weight:600}
  .erro{background:#fee2e2;color:#991b1b;padding:10px 12px;border-radius:10px;margin-bottom:16px}
</style></head><body><main>
<h1>Conectar o Claude ao sistema</h1>
<p>${escapeHtml(clientName || 'O Claude')} quer acessar o sistema da Towing J&amp;J. Entre com o telefone e o PIN que você usa no painel. O Claude não fica sabendo o seu PIN.</p>
${error ? `<div class="erro">${escapeHtml(error)}</div>` : ''}
${disabled
    ? `<div class="erro">${escapeHtml(disabled)}</div>`
    : `<form method="post" action="/mcp/login" autocomplete="off">
<input type="hidden" name="pedido" value="${escapeHtml(pendingId)}">
<label for="telefone">Telefone</label>
<input id="telefone" name="telefone" type="tel" inputmode="tel" autocomplete="username" value="${escapeHtml(phone)}" required autofocus>
<label for="pin" style="margin-top:12px">PIN</label>
<input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" required>
<button type="submit">Conectar</button>
</form>`}
</main></body></html>`;
}

function sendPage(res, status, html) {
  res.status(status).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" }).send(html);
}

// O "provedor" que o SDK do MCP usa para o login.
export function createOAuthProvider(ctx, guard) {
  const { db } = ctx;
  const pending = new Map(); // pedido de login em andamento: id -> { client, params, at }

  const clientsStore = {
    getClient(clientId) {
      const row = db.prepare('SELECT info FROM mcp_clients WHERE client_id = ?').get(String(clientId));
      return row ? JSON.parse(row.info) : undefined;
    },
    registerClient(client) {
      const uris = client.redirect_uris || [];
      if (!uris.length || !uris.every((u) => allowedRedirect(String(u)))) {
        throw new InvalidClientMetadataError('Endereço de retorno não permitido.');
      }
      db.prepare('INSERT INTO mcp_clients (client_id, info, created_at) VALUES (?, ?, ?)').run(client.client_id, JSON.stringify(client), new Date().toISOString());
      ctx.log(`MCP: novo aplicativo registrado (${client.client_name || 'sem nome'}).`);
      return client;
    },
  };

  function issueTokens(clientId, userId, resource, scopes) {
    const access = randomToken();
    const refresh = randomToken();
    const insert = db.prepare('INSERT INTO mcp_tokens (token_hash, kind, client_id, user_id, resource, scopes, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const created = new Date().toISOString();
    const sc = (scopes || []).join(' ');
    insert.run(sha256(access), 'access', clientId, userId, resource || null, sc, nowS() + ACCESS_TTL_S, created);
    insert.run(sha256(refresh), 'refresh', clientId, userId, resource || null, sc, nowS() + REFRESH_TTL_S, created);
    // Limpa o que já venceu.
    db.prepare('DELETE FROM mcp_tokens WHERE expires_at < ?').run(nowS() - 86400);
    db.prepare('DELETE FROM mcp_codes WHERE expires_at < ?').run(nowS());
    return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, ...(sc ? { scope: sc } : {}) };
  }

  const provider = {
    clientsStore,

    async authorize(client, params, res) {
      for (const [id, p] of pending) if (Date.now() - p.at > PENDING_TTL_MS) pending.delete(id);
      const id = randomToken();
      pending.set(id, { clientId: client.client_id, params, at: Date.now() });
      sendPage(res, 200, loginPage({ pendingId: id, clientName: client.client_name }));
    },

    // Recebe o telefone e o PIN digitados na página de login.
    loginHandler(req, res) {
      const ip = clientIp(req);
      const id = String(req.body?.pedido || '');
      const p = pending.get(id);
      if (!p || Date.now() - p.at > PENDING_TTL_MS) {
        pending.delete(id);
        return sendPage(res, 400, loginPage({ pendingId: '', disabled: 'Este pedido de login expirou. Volte ao Claude e tente conectar de novo.' }));
      }
      const client = clientsStore.getClient(p.clientId);
      const phone = normalizePhone(req.body?.telefone);
      const pin = String(req.body?.pin || '').trim();
      const page = (status, extra) => sendPage(res, status, loginPage({ pendingId: id, clientName: client?.client_name, phone: req.body?.telefone || '', ...extra }));
      const blocked = guard.blocked(ip, phone);
      if (blocked) return page(429, { disabled: blocked });
      const user = phone ? ctx.db.prepare('SELECT * FROM users WHERE phone = ? AND active = 1').get(phone) : null;
      if (!user || !verifyPin(pin, user.pin_hash)) {
        guard.fail(ip, phone);
        ctx.log(`MCP: telefone ou PIN errado no login do conector (endereço ${ip}).`);
        return page(401, { error: 'Telefone ou PIN errado.' });
      }
      if (user.role !== 'dono') return page(403, { error: 'Só o dono (ADM) pode conectar o Claude ao sistema.' });
      if (!client) return sendPage(res, 400, loginPage({ pendingId: '', disabled: 'Não achei o aplicativo. Volte ao Claude e tente conectar de novo.' }));
      guard.success(ip, phone);
      pending.delete(id);
      const code = randomToken();
      db.prepare('INSERT INTO mcp_codes (code_hash, client_id, user_id, challenge, redirect_uri, resource, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        sha256(code),
        client.client_id,
        user.id,
        p.params.codeChallenge,
        p.params.redirectUri,
        p.params.resource ? p.params.resource.href : null,
        (p.params.scopes || []).join(' '),
        nowS() + CODE_TTL_S
      );
      ctx.log(`MCP: Claude conectado ao sistema por ${user.name} (${client.client_name || client.client_id}).`);
      const target = new URL(p.params.redirectUri);
      target.searchParams.set('code', code);
      if (p.params.state !== undefined) target.searchParams.set('state', p.params.state);
      res.set('Cache-Control', 'no-store').redirect(302, target.href);
    },

    async challengeForAuthorizationCode(client, code) {
      const row = db.prepare('SELECT * FROM mcp_codes WHERE code_hash = ?').get(sha256(code));
      if (!row || row.client_id !== client.client_id || row.expires_at < nowS()) throw new InvalidGrantError('Código inválido ou vencido.');
      return row.challenge;
    },

    async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
      const row = db.prepare('SELECT * FROM mcp_codes WHERE code_hash = ?').get(sha256(code));
      // O código só vale uma vez.
      db.prepare('DELETE FROM mcp_codes WHERE code_hash = ?').run(sha256(code));
      if (!row || row.client_id !== client.client_id || row.expires_at < nowS()) throw new InvalidGrantError('Código inválido ou vencido.');
      if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError('Endereço de retorno diferente.');
      return issueTokens(client.client_id, row.user_id, row.resource, row.scopes ? row.scopes.split(' ') : []);
    },

    async exchangeRefreshToken(client, refreshToken) {
      const hash = sha256(refreshToken);
      const row = db.prepare("SELECT * FROM mcp_tokens WHERE token_hash = ? AND kind = 'refresh'").get(hash);
      if (!row || row.revoked || row.client_id !== client.client_id || row.expires_at < nowS()) throw new InvalidGrantError('Renovação inválida ou vencida.');
      // Cada renovação troca o crachá de renovação (o antigo deixa de valer).
      db.prepare('UPDATE mcp_tokens SET revoked = 1 WHERE token_hash = ?').run(hash);
      return issueTokens(client.client_id, row.user_id, row.resource, row.scopes ? row.scopes.split(' ') : []);
    },

    async verifyAccessToken(token) {
      const row = db.prepare("SELECT * FROM mcp_tokens WHERE token_hash = ? AND kind = 'access'").get(sha256(token));
      if (!row || row.revoked || row.expires_at < nowS()) throw new InvalidTokenError('Crachá inválido ou vencido.');
      const user = db.prepare("SELECT * FROM users WHERE id = ? AND active = 1 AND role = 'dono'").get(row.user_id);
      if (!user) throw new InvalidTokenError('Usuário desativado.');
      return {
        token,
        clientId: row.client_id,
        scopes: row.scopes ? row.scopes.split(' ') : [],
        expiresAt: row.expires_at,
        resource: row.resource ? new URL(row.resource) : undefined,
        extra: { userId: user.id },
      };
    },

    async revokeToken(client, { token }) {
      if (!token) throw new InvalidRequestError('Falta o token.');
      db.prepare('UPDATE mcp_tokens SET revoked = 1 WHERE token_hash = ? AND client_id = ?').run(sha256(token), client.client_id);
    },
  };

  return provider;
}

export const loginBodyParser = express.urlencoded({ extended: false, limit: '10kb' });
