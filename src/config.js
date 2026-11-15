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

export const ALL_MODULES = ['vin', 'fotos', 'pagamentos', 'despesas', 'whatsapp', 'planilha', 'manutencao', 'invoice', 'empresas', 'comissao', 'backup', 'notificacoes', 'voz', 'ajuda', 'agenda', 'sms', 'mcp'];

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
    // Endereço público do sistema (o Render preenche RENDER_EXTERNAL_URL sozinho). Usado no login do conector do Claude.
    publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
    mcp: {
      // Dono manda serviço para o Jay: só guarda na caixa (o Claude cria). JAY_CAIXA=off: o Jay cria como antes.
      jayCaixa: !['off', '0', 'nao', 'não', 'false'].includes(String(env.JAY_CAIXA || '').trim().toLowerCase()),
    },
    modules: withMcp(env.MODULES ? env.MODULES.split(',').map((m) => m.trim()).filter(Boolean) : ALL_MODULES, env),
    pricing: {
      // Valor médio do serviço ($100, Caningado 23/10): é a sugestão quando não há milhas.
      baseCents: Math.round(Number(env.PRICE_BASE ?? 100) * 100),
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
      // Só para trocar a foto do robô; sem ele, o sistema descobre pelo token.
      appId: env.WHATSAPP_APP_ID || '',
      // Mensagens de texto que chegam juntas (encaminhadas, cartão de contato) esperam este tempo
      // e viram uma só, para o robô entender o serviço inteiro.
      juntarMs: env.WHATSAPP_JUNTAR_MS != null && env.WHATSAPP_JUNTAR_MS !== '' ? Number(env.WHATSAPP_JUNTAR_MS) : 3000,
      // Resposta automática para quem não é da equipe: diaria (padrão), nunca ou sempre.
      // Padrão: o robô nunca responde clientes (só o dono responde, pelo WhatsApp Business).
    },
    // SMS pela Twilio: o Jay atende por mensagem de texto comum quem da equipe não usa WhatsApp.
    sms: {
      sid: (env.TWILIO_ACCOUNT_SID || '').trim(),
      token: (env.TWILIO_AUTH_TOKEN || '').trim(),
      // Número do Jay na Twilio (+1...). Ou o Messaging Service (MG...), que já tem o número dentro.
      from: (env.TWILIO_NUMERO || '').trim(),
      messagingServiceSid: (env.TWILIO_MESSAGING_SERVICE_SID || '').trim(),
    },
    // Cobrança atrasada: avisa quando passa desse número de dias sem receber.
    // Link de pagamento com cartão pelo Square. Sem token, a cobrança fica só com o Zelle.
    square: {
      token: env.SQUARE_ACCESS_TOKEN || '',
      locationId: env.SQUARE_LOCATION_ID || '',
      sandbox: env.SQUARE_AMBIENTE === 'teste',
      // Para marcar pago sozinho quando o cliente paga (Square › Webhooks › Signature key).
      webhookKey: env.SQUARE_WEBHOOK_KEY || '',
      // Taxa inicial do cartão (link de pagamento online). Depois o sistema aprende a real todo dia.
      feePct: Number(env.SQUARE_TAXA) > 0 ? Number(env.SQUARE_TAXA) : 3.3,
      feeFixedCents: env.SQUARE_TAXA_FIXA != null && env.SQUARE_TAXA_FIXA !== '' ? Math.round(Number(env.SQUARE_TAXA_FIXA) * 100) : 30,
    },
    overdueDays: Number(env.COBRANCA_DIAS) > 0 ? Number(env.COBRANCA_DIAS) : 7,
    // Quantos serviços um motorista pode ter em andamento ao mesmo tempo (o resto fica na fila dele).
    maxActive: Number(env.MAX_EM_ANDAMENTO) > 0 ? Number(env.MAX_EM_ANDAMENTO) : 2,
    // Hora do aviso da manhã para o dono (pelo WhatsApp), no fuso da empresa. AVISO_HORA=off desliga.
    dailyHour: env.AVISO_HORA === 'off' ? null : Number.isInteger(Number(env.AVISO_HORA)) && env.AVISO_HORA !== '' && env.AVISO_HORA != null ? Number(env.AVISO_HORA) : 8,
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    // Leitura do VIN por foto com o Gemini (Google), que tem uso grátis.
    geminiApiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_MODEL || 'gemini-flash-latest',
    // Comandos de voz na tela do serviço: modelo rápido e barato do Gemini.
    geminiVoiceModel: env.GEMINI_VOICE_MODEL || 'gemini-flash-lite-latest',
    // Modelos extras para quando os dois de cima estão lotados (separados por vírgula).
    geminiReservas: (env.GEMINI_RESERVAS || '').split(',').map((m) => m.trim()).filter(Boolean),
    // Robô responde com áudio quando a pessoa manda áudio. ROBO_VOZ=off desliga.
    roboVoz: env.ROBO_VOZ !== 'off',
    // Pessoa de apoio: quando o Jay não consegue resolver, pede ajuda para ela pelo WhatsApp e cobra até resolver.
    ajudaTelefone: env.AJUDA_TELEFONE || '',
    // Nome do robô (escolhido pelo Caningado em 20/10).
    roboNome: (env.ROBO_NOME || 'Jay').trim(),
    geminiTtsModel: env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts',
    geminiTtsVoice: env.GEMINI_TTS_VOICE || 'Puck', // voz masculina (Caningado pediu 21/10; antes Kore, feminina)
    // Leitura grátis das letras do VIN na foto (Tesseract). VIN_OCR=off desliga.
    vinOcr: env.VIN_OCR !== 'off',
    // Conferir endereços no mapa (Census + OpenStreetMap, grátis). GEOCODER=off desliga.
    geocoder: env.GEOCODER !== 'off',
    // Busca de endereço só neste estado (sigla). GEO_ESTADO=todos busca no país inteiro.
    geoEstado: (env.GEO_ESTADO || 'FL').toUpperCase() === 'TODOS' ? null : (env.GEO_ESTADO || 'FL').toUpperCase(),
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

// O conector do Claude (MCP) vem ligado mesmo quando o MODULES do Render é uma lista antiga sem ele.
// Para desligar: MCP=off.
function withMcp(modules, env) {
  const off = ['off', '0', 'nao', 'não', 'false'].includes(String(env.MCP || '').trim().toLowerCase());
  // O SMS vem ligado junto com o WhatsApp (sem as chaves da Twilio ele não faz nada). SMS=off desliga.
  const smsOff = ['off', '0', 'nao', 'não', 'false'].includes(String(env.SMS || '').trim().toLowerCase());
  const list = modules.filter((m) => m !== 'mcp' && m !== 'sms');
  if (!smsOff && (modules.includes('sms') || modules.includes('whatsapp'))) list.push('sms');
  return off ? list : [...list, 'mcp'];
}
