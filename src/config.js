import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Lê o arquivo .env (se existir) sem precisar de biblioteca.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

export const ALL_MODULES = ['vin', 'fotos', 'pagamentos', 'despesas', 'whatsapp', 'planilha', 'manutencao', 'invoice', 'empresas', 'comissao'];

export function loadConfig(overrides = {}) {
  loadDotEnv(path.resolve('.env'));
  const env = { ...process.env, ...overrides };
  const dataDir = path.resolve(env.DATA_DIR || 'data');

  return {
    port: Number(env.PORT || 3000),
    dataDir,
    dbFile: env.DB_FILE || path.join(dataDir, 'guincho.db'),
    uploadsDir: path.join(dataDir, 'uploads'),
    secret: env.SESSION_SECRET || persistentSecret(dataDir),
    secureCookies: env.SECURE_COOKIES === '1' || env.NODE_ENV === 'production',
    timeZone: env.TIME_ZONE || 'America/New_York',
    companyName: env.COMPANY_NAME || 'Towing J&J',
    modules: (env.MODULES ? env.MODULES.split(',').map((m) => m.trim()).filter(Boolean) : ALL_MODULES),
    pricing: {
      baseCents: Math.round(Number(env.PRICE_BASE || 0) * 100),
      perMileCents: Math.round(Number(env.PRICE_PER_MILE || 0) * 100),
    },
    zelle: {
      name: env.ZELLE_NAME || '',
      contact: env.ZELLE_CONTACT || '',
    },
    whatsapp: {
      token: env.WHATSAPP_TOKEN || '',
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
      verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
      appSecret: env.WHATSAPP_APP_SECRET || '',
      apiVersion: env.WHATSAPP_API_VERSION || 'v21.0',
      // Resposta automática para quem não é da equipe: diaria (padrão), nunca ou sempre.
      outsiderReply: ['nunca', 'sempre'].includes(env.WHATSAPP_RESPOSTA_FORA) ? env.WHATSAPP_RESPOSTA_FORA : 'diaria',
    },
    // Cobrança atrasada: avisa quando passa desse número de dias sem receber.
    overdueDays: Number(env.COBRANCA_DIAS) > 0 ? Number(env.COBRANCA_DIAS) : 7,
    // Hora do aviso da manhã para o dono (pelo WhatsApp), no fuso da empresa. AVISO_HORA=off desliga.
    dailyHour: env.AVISO_HORA === 'off' ? null : Number.isInteger(Number(env.AVISO_HORA)) && env.AVISO_HORA !== '' && env.AVISO_HORA != null ? Number(env.AVISO_HORA) : 8,
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    // Conferir endereços no mapa (Census + OpenStreetMap, grátis). GEOCODER=off desliga.
    geocoder: env.GEOCODER !== 'off',
  };
}

// Sem SESSION_SECRET no .env, gera um e guarda junto dos dados, para os logins
// continuarem válidos depois de reiniciar.
function persistentSecret(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, '.session-secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}
