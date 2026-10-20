// Módulo VIN: confere o número do chassi, descobre marca/modelo/ano na base
// gratuita do governo americano (NHTSA) e lê o VIN a partir de uma foto.
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { FlowError } from '../../core/bot.js';
import { simplify, HttpError } from '../../lib/util.js';
import { readVinBarcode } from '../../lib/barcode.js';
import { readVinText } from '../../lib/vin-ocr.js';

const TRANSLITERATION = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

// Limpa o que veio digitado ou lido da foto. VIN não usa I, O nem Q.
export function cleanVin(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0')
    .replace(/Q/g, '0')
    .replace(/I/g, '1');
}

// Confere o tamanho e o dígito verificador (9ª posição), obrigatório nos EUA.
export function validateVin(raw) {
  const vin = cleanVin(raw);
  if (vin.length !== 17) return { vin, valid: false, reason: `O VIN tem 17 caracteres, recebi ${vin.length}.` };
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i];
    const value = /\d/.test(ch) ? Number(ch) : TRANSLITERATION[ch];
    if (value === undefined) return { vin, valid: false, reason: `Caractere inválido no VIN: ${ch}` };
    sum += value * WEIGHTS[i];
  }
  const remainder = sum % 11;
  const expected = remainder === 10 ? 'X' : String(remainder);
  if (vin[8] !== expected) return { vin, valid: false, reason: 'O dígito verificador não bate. Confira se algum caractere foi lido errado.' };
  return { vin, valid: true };
}

export async function decodeVin(vin, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${vin}?format=json`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const row = (await res.json()).Results?.[0];
    if (!row || !row.Make) return null;
    return {
      year: row.ModelYear || null,
      make: row.Make || null,
      model: row.Model || null,
      trim: row.Trim || null,
      body: row.BodyClass || null,
    };
  } catch {
    return null;
  }
}

export function describeVehicle(info) {
  if (!info) return null;
  return [info.year, info.make, info.model].filter(Boolean).join(' ') || null;
}

const VIN_PROMPT =
  'This photo should show a vehicle VIN (17 characters), from a door-jamb label, the windshield plate, ' +
  'a barcode label or a document. Reply with only the VIN exactly as printed, with no other words. ' +
  'If you cannot read a full VIN, reply with NONE.';

const vinInText = (text) => {
  const match = String(text || '').toUpperCase().match(/[A-Z0-9]{17}/);
  return match ? cleanVin(match[0]) : null;
};

// Pergunta ao Gemini (Google). Tem uso grátis com a chave do AI Studio.
export async function readVinGemini(ctx, buffer, mimeType, fetchImpl = fetch) {
  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${ctx.config.geminiModel}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.config.geminiApiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: mimeType || 'image/jpeg', data: buffer.toString('base64') } }, { text: VIN_PROMPT }] }],
      generationConfig: { temperature: 0 },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Gemini respondeu ${res.status}`);
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join(' ');
  return vinInText(text);
}

// Lê o VIN de uma foto (etiqueta da porta, para-brisa ou documento).
// Primeiro procura o código de barras. Se não achar e houver GEMINI_API_KEY, pergunta ao Gemini,
// que lê bem melhor que o leitor grátis. Depois tenta o leitor grátis (Tesseract) e, por último,
// o Claude, se houver ANTHROPIC_API_KEY.
export async function readVinFromImage(ctx, buffer, mimeType) {
  try {
    const vin = await readVinBarcode(buffer);
    if (vin) return { vin, source: 'codigo' };
  } catch (err) {
    ctx.log?.('Falha ao ler código de barras', err);
  }
  if (ctx.config.geminiApiKey) {
    try {
      const vin = await readVinGemini(ctx, buffer, mimeType);
      if (vin) return { vin, source: 'gemini' };
    } catch (err) {
      ctx.log?.('Falha ao ler o VIN com o Gemini', err);
      // Modelo lotado ou lento: tenta o outro modelo do Gemini antes do leitor grátis.
      const reserva = ctx.config.geminiVoiceModel;
      if (reserva && reserva !== ctx.config.geminiModel) {
        try {
          const vin = await readVinGemini({ ...ctx, config: { ...ctx.config, geminiModel: reserva } }, buffer, mimeType);
          if (vin) return { vin, source: 'gemini' };
        } catch (err2) {
          ctx.log?.('Falha ao ler o VIN com o Gemini (reserva)', err2);
        }
      }
    }
  }
  if (ctx.config.vinOcr !== false) {
    try {
      const vin = await readVinText(buffer);
      if (vin) return { vin, source: 'texto' };
    } catch (err) {
      ctx.log?.('Falha ao ler o texto do VIN', err);
    }
  }
  if (!ctx.config.anthropicApiKey) return { vin: null, reason: 'sem-chave' };
  const client = new Anthropic({ apiKey: ctx.config.anthropicApiKey });
  const response = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 2048,
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: buffer.toString('base64') } },
          { type: 'text', text: VIN_PROMPT },
        ],
      },
    ],
  });
  if (response.stop_reason === 'refusal') return { vin: null, reason: 'recusado' };
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  const vin = vinInText(text);
  return vin ? { vin } : { vin: null, reason: 'nao-leu' };
}

// Grava o VIN no serviço e completa o veículo com marca/modelo/ano.
async function saveVin(ctx, service, vin) {
  const info = await decodeVin(vin);
  const fields = { vin, vin_info: info ? JSON.stringify(info) : null };
  if (info && !service.vehicle) fields.vehicle = describeVehicle(info);
  return { service: ctx.data.services.update(service.id, fields), info };
}

function savedMessage(ctx, service, info, user) {
  const vehicle = describeVehicle(info);
  return `✅ VIN ${service.vin} salvo no serviço #${ctx.data.services.ref(service, user)}.${vehicle ? `\nVeículo: ${vehicle}` : ''}`;
}

const flows = {
  vin_confirmar: {
    steps: [
      {
        key: 'confirmed',
        ask: (data) =>
          `Li o VIN: *${data.vin}*${data.valid ? '' : ' (o dígito verificador não bateu)'}\nEstá certo? Mande *sim* ou digite o número correto.`,
        parse(text, { data }) {
          if (['sim', 's', 'ok', 'certo'].includes(simplify(text))) return data.vin;
          const check = validateVin(text);
          if (!check.valid) throw new FlowError(check.reason);
          return check.vin;
        },
      },
    ],
    async finish({ ctx, user, data }) {
      const service = ctx.data.services.get(data.serviceId);
      if (!service) return 'O serviço não existe mais.';
      const saved = await saveVin(ctx, service, data.confirmed);
      return savedMessage(ctx, saved.service, saved.info, user);
    },
  },
};

const commands = [
  {
    names: ['vin', 'chassi'],
    help: '*vin 1HGCM82633A004352* – salvar o VIN (ou mande a foto com a legenda *vin*)',
    async run({ ctx, user, rawArgs }) {
      const service = ctx.data.services.active(user);
      if (!service) return 'Nenhum serviço em andamento. Mande *novo* primeiro.';
      if (!rawArgs) return 'Mande *vin* seguido do número, ou a foto da etiqueta com a legenda *vin*.';
      const check = validateVin(rawArgs);
      if (!check.valid) return `${check.reason}\nSe tiver certeza do número, mande a foto da etiqueta com a legenda *vin*.`;
      const saved = await saveVin(ctx, service, check.vin);
      return savedMessage(ctx, saved.service, saved.info, user);
    },
  },
];

function routes(api, ctx) {
  api.post('/services/:id/vin', async (req, res) => {
    const service = ctx.data.services.get(Number(req.params.id));
    if (!service || (req.user.role !== 'dono' && service.driver_id !== req.user.id)) throw new HttpError(404, 'Serviço não encontrado.');
    const check = validateVin(req.body?.vin);
    if (!check.valid && !req.body?.force) throw new HttpError(400, check.reason);
    const saved = await saveVin(ctx, service, check.vin);
    res.json({ ...saved.service, vin_info: saved.info });
  });

  // Novo serviço: confere o VIN digitado e devolve ano/marca/modelo para preencher o veículo.
  api.get('/vin/decode/:vin', async (req, res) => {
    const check = validateVin(req.params.vin);
    if (!/^[A-Z0-9]{17}$/.test(check.vin)) return res.json({ ...check, info: null, vehicle: null });
    const info = await ctx.api.vin.decode(check.vin);
    res.json({ ...check, info, vehicle: describeVehicle(info) });
  });

  // Recebe a foto (corpo da requisição é a imagem) e devolve o VIN lido.
  api.post('/vin/read', express.raw({ type: 'image/*', limit: '15mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Mande uma foto.');
    // Fotos automáticas do escaner: só o código de barras (rápido) e sem erro quando não acha.
    if (req.query.so === 'codigo') {
      const vin = await readVinBarcode(req.body).catch(() => null);
      return res.json(vin ? validateVin(vin) : { vin: null });
    }
    const result = await readVinFromImage(ctx, req.body, req.headers['content-type']);
    if (!result.vin) {
      const msg =
        result.reason === 'sem-chave'
          ? 'Não consegui ler o VIN nessa foto. Tire de perto, com o VIN reto e sem reflexo (etiqueta da porta do motorista ou para-brisa), ou digite o VIN.'
          : 'Não consegui ler o VIN nessa foto. Tente de novo mais de perto ou digite o VIN.';
      throw new HttpError(422, msg);
    }
    res.json(validateVin(result.vin));
  });
}

// VIN lido de foto sem serviço aberto: fica guardado um tempo e entra no próximo serviço criado.
const PENDENTE_MS = 2 * 3600 * 1000;

export default {
  name: 'vin',
  label: 'VIN',
  commands,
  flows,
  routes,
  serviceHint: '🔎 VIN: mande *vin* + número, ou a foto da etiqueta com a legenda *vin*.',
  setup(ctx) {
    const pendentes = new Map();
    ctx.api.vin = {
      validate: validateVin,
      decode: decodeVin,
      readFromImage: (buffer, mime) => readVinFromImage(ctx, buffer, mime),
      // Último VIN lido sem serviço (para o robô responder "qual VIN?").
      pending(userId) {
        const p = pendentes.get(userId);
        if (!p || Date.now() - p.at > PENDENTE_MS) return null;
        return p;
      },
      // VIN lido de outro jeito (ex.: gate pass em PDF): entra no próximo serviço criado.
      remember(userId, raw) {
        const check = validateVin(raw);
        if (check.vin.length !== 17) return null;
        pendentes.set(userId, { vin: check.vin, valid: check.valid, vehicle: null, at: Date.now() });
        return check;
      },
      // Chamado quando um serviço é criado: põe nele o VIN lido antes.
      async attachPending(user, service) {
        const p = this.pending(user.id);
        pendentes.delete(user.id);
        if (!p || service.vin) return null;
        return (await saveVin(ctx, service, p.vin)).service;
      },
      // Foto sem serviço aberto: lê o VIN mesmo assim, mostra o carro e guarda para o próximo serviço.
      async readLoose(user, buffer, mime) {
        let result;
        try {
          result = await readVinFromImage(ctx, buffer, mime);
        } catch (err) {
          ctx.log('Falha ao ler VIN da foto', err);
          result = { vin: null };
        }
        if (!result.vin) return null;
        const check = validateVin(result.vin);
        const info = await decodeVin(check.vin);
        const vehicle = describeVehicle(info);
        pendentes.set(user.id, { vin: check.vin, valid: check.valid, vehicle, at: Date.now() });
        return [
          `🔎 VIN: *${check.vin}*${check.valid ? '' : ' (o dígito verificador não bateu, confira)'}${vehicle ? `\nVeículo: ${vehicle}` : ''}`,
          'Não tem serviço aberto agora. Quando você mandar *novo*, eu já coloco esse VIN no serviço.',
        ].join('\n');
      },
      // Usado pelo módulo de fotos: lê a foto e pede confirmação ao motorista.
      async askConfirmation(user, service, buffer, mime) {
        let result;
        try {
          result = await readVinFromImage(ctx, buffer, mime);
        } catch (err) {
          ctx.log('Falha ao ler VIN da foto', err);
          result = { vin: null };
        }
        if (!result.vin) {
          return result.reason === 'sem-chave'
            ? 'Foto do VIN guardada, mas não consegui ler o número. Mande outra foto de perto, com o VIN reto e sem reflexo (etiqueta da porta ou para-brisa), com a legenda *vin*. Ou mande *vin* seguido do número.'
            : 'Foto do VIN guardada, mas não consegui ler o número. Mande *vin* seguido dele.';
        }
        const check = validateVin(result.vin);
        return ctx.bot.startFlow(user, 'vin_confirmar', { serviceId: service.id, vin: check.vin, valid: check.valid });
      },
    };
  },
};
