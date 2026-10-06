// Módulo VIN: confere o número do chassi, descobre marca/modelo/ano na base
// gratuita do governo americano (NHTSA) e lê o VIN a partir de uma foto.
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { FlowError } from '../../core/bot.js';
import { simplify, HttpError } from '../../lib/util.js';
import { readVinBarcode } from '../../lib/barcode.js';

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

// Lê o VIN de uma foto (etiqueta da porta, para-brisa ou documento).
// Primeiro procura o código de barras (funciona sempre); se não achar, lê o texto
// com o Claude, que só funciona com ANTHROPIC_API_KEY configurada.
export async function readVinFromImage(ctx, buffer, mimeType) {
  try {
    const vin = await readVinBarcode(buffer);
    if (vin) return { vin, source: 'codigo' };
  } catch (err) {
    ctx.log?.('Falha ao ler código de barras', err);
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
          {
            type: 'text',
            text:
              'This photo should show a vehicle VIN (17 characters), from a door-jamb label, the windshield plate, ' +
              'a barcode label or a document. Reply with only the VIN exactly as printed, with no other words. ' +
              'If you cannot read a full VIN, reply with NONE.',
          },
        ],
      },
    ],
  });
  if (response.stop_reason === 'refusal') return { vin: null, reason: 'recusado' };
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  const match = text.toUpperCase().match(/[A-Z0-9]{17}/);
  return match ? { vin: cleanVin(match[0]) } : { vin: null, reason: 'nao-leu' };
}

// Grava o VIN no serviço e completa o veículo com marca/modelo/ano.
async function saveVin(ctx, service, vin) {
  const info = await decodeVin(vin);
  const fields = { vin, vin_info: info ? JSON.stringify(info) : null };
  if (info && !service.vehicle) fields.vehicle = describeVehicle(info);
  return { service: ctx.data.services.update(service.id, fields), info };
}

function savedMessage(service, info) {
  const vehicle = describeVehicle(info);
  return `✅ VIN ${service.vin} salvo no serviço #${service.id}.${vehicle ? `\nVeículo: ${vehicle}` : ''}`;
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
      return savedMessage(saved.service, saved.info);
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
      return savedMessage(saved.service, saved.info);
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

  // Recebe a foto (corpo da requisição é a imagem) e devolve o VIN lido.
  api.post('/vin/read', express.raw({ type: 'image/*', limit: '15mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Mande uma foto.');
    const result = await readVinFromImage(ctx, req.body, req.headers['content-type']);
    if (!result.vin) {
      const msg =
        result.reason === 'sem-chave'
          ? 'Não achei o código de barras do VIN nessa foto. Tire a foto de perto, só do código de barras (porta do motorista ou para-brisa), ou digite o VIN.'
          : 'Não consegui ler o VIN nessa foto. Tente de novo mais de perto ou digite o VIN.';
      throw new HttpError(422, msg);
    }
    res.json(validateVin(result.vin));
  });
}

export default {
  name: 'vin',
  label: 'VIN',
  commands,
  flows,
  routes,
  serviceHint: '🔎 VIN: mande *vin* + número, ou a foto da etiqueta com a legenda *vin*.',
  setup(ctx) {
    ctx.api.vin = {
      validate: validateVin,
      decode: decodeVin,
      readFromImage: (buffer, mime) => readVinFromImage(ctx, buffer, mime),
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
            ? 'Foto do VIN guardada, mas não achei o código de barras nela. Mande outra foto de perto, só do código de barras (porta do motorista ou para-brisa), com a legenda *vin*. Ou mande *vin* seguido do número.'
            : 'Foto do VIN guardada, mas não consegui ler o número. Mande *vin* seguido dele.';
        }
        const check = validateVin(result.vin);
        return ctx.bot.startFlow(user, 'vin_confirmar', { serviceId: service.id, vin: check.vin, valid: check.valid });
      },
    };
  },
};
