// Foto que chega no WhatsApp sem legenda: o Gemini diz o que é. Se for um endereço
// (print do mapa, pedido de serviço, cartão da oficina), ele escreve o texto para o robô
// tratar como se a pessoa tivesse digitado (pedido do Caningado 21/10).
// Foto da bomba de combustível: lê o valor e os galões para lançar a despesa; foto do painel: lê a milhagem (pedido do Caningado 25/10).
import { askGemini } from './gemini.js';

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    tipo: { type: 'STRING', enum: ['vin', 'endereco', 'carro', 'documento', 'bomba', 'painel', 'outro'] },
    texto: { type: 'STRING' },
    valor: { type: 'NUMBER' },
    galoes: { type: 'NUMBER' },
    milhas: { type: 'NUMBER' },
  },
  required: ['tipo'],
};

const PROMPT = `Esta foto foi mandada no WhatsApp por alguém de uma empresa de guincho nos EUA.
Diga em "tipo" o que ela é:
- "vin": etiqueta ou placa com o número VIN (17 caracteres) ou código de barras do VIN.
- "endereco": foto ou print com endereço ou local (mapa, pedido de serviço, mensagem com endereços, cartão ou fachada de oficina com endereço).
- "carro": foto do veículo (frente, lateral, traseira, dano).
- "documento": gate pass, release, invoice ou outro papel sem endereço para o serviço.
- "bomba": visor da bomba de combustível ("This Sale", "Gallons") ou recibo do posto.
- "painel": painel do caminhão mostrando o odômetro (milhagem total).
- "outro": nada disso.
Se for "endereco", escreva em "texto" o que serve para o serviço, exatamente como aparece, uma informação por linha: endereços completos (rua, cidade, estado, CEP), nome e telefone do cliente, carro e valor. Quando a foto mostrar de onde pegar e para onde levar, comece as linhas com "Pegar:" e "Deixar:". Se for "bomba", escreva em "valor" o total pago em dólares e em "galoes" quantos galões, exatamente como aparecem no visor ou no recibo (ex.: 101.40 e 16.464); o que não der para ler fica vazio.
Se for "painel", escreva em "milhas" o número do odômetro (milhagem total, não o trip), só os números inteiros (ex.: 184523).
Nunca invente nada. Nos outros tipos, deixe "texto" vazio.`;

// Devolve { tipo, texto }. Erro do Gemini sobe para quem chamou.
export async function readPhotoText(ctx, buffer, mime) {
  const a = await askGemini(ctx, { prompt: PROMPT, audio: buffer, mimeType: mime || 'image/jpeg', schema: SCHEMA });
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  return { tipo: String(a.tipo || ''), texto: String(a.texto || '').trim().slice(0, 1500), valor: num(a.valor), galoes: num(a.galoes), milhas: num(a.milhas) && Math.round(num(a.milhas)) };
}
