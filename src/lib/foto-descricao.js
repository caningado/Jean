// Descreve em texto uma foto que o dono mandou ao Jay (carro, placa, VIN, danos, textos), com a
// visão do Claude (API da Anthropic, ANTHROPIC_API_KEY). O texto fica guardado com a foto para o
// conector do Claude ler mesmo no modo de voz, onde a imagem não chega até o modelo.
import Anthropic from '@anthropic-ai/sdk';

export const PROMPT = `Você ajuda uma empresa de guincho nos EUA. Descreva esta foto em português do Brasil, só com o que dá para ver (não invente). Responda exatamente neste formato, uma linha por item, escrevendo "não dá para ver" quando não der:
Tipo de foto: (carro inteiro, etiqueta do VIN, painel, documento, local, outro)
Veículo: marca, modelo, ano aproximado (ex.: "2015 a 2018") e cor
Placa: número e estado (ex.: "ABC1234 – Flórida")
VIN: os 17 caracteres, se for a etiqueta ou o painel com o VIN
Danos e observações: batidas, pneu furado, vidro quebrado, carro em cima de outro guincho, onde está (rua, garagem, oficina) etc.
Texto escrito na foto: tudo o que estiver escrito e der para ler (placas de loja, papéis, adesivos)`;

export async function describePhoto(ctx, buffer, mimeType) {
  if (!ctx.config.anthropicApiKey) return null;
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
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });
  if (response.stop_reason === 'refusal') return null;
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return text ? text.slice(0, 3000) : null;
}
