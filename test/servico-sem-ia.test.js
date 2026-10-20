import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, chat, DRIVER_PHONE } from './helpers.js';
import { guessService } from '../src/lib/servico-texto.js';

// Do jeito que chega do WhatsApp: localização, valor, endereço, carro, rótulo e telefone, juntos.
const ENCAMINHADO = ['(28.4801, -81.4567)', '$160', '4209 Old Winter Garden Rd, Orlando, FL 32805', 'Colorado', 'Deixar', '+1 (689) 867-7916'].join('\n');

test('plano B: tira os dados do serviço do texto encaminhado', () => {
  assert.deepEqual(guessService(ENCAMINHADO), {
    retirada: '(28.4801, -81.4567)',
    destino: '4209 Old Winter Garden Rd, Orlando, FL 32805',
    valor: 160,
    veiculo: 'Colorado',
    telefone: '16898677916',
  });
  assert.deepEqual(guessService('Contato do cliente: Daylon Smith 13218305723\n3241 Bella vista Dr'), {
    telefone: '13218305723',
    cliente: 'Daylon Smith',
    retirada: '3241 Bella vista Dr',
  });
});

test('Gemini fora do ar: mensagem encaminhada vira serviço novo mesmo assim', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('generativelanguage.googleapis.com')) return new Response('quota', { status: 429 });
    return realFetch(url, opts);
  };
  const ctx = makeContext({ GEMINI_API_KEY: 'k', PRICE_BASE: '', PRICE_PER_MILE: '' });
  const r = await chat(ctx, DRIVER_PHONE, ENCAMINHADO);
  const all = r.flat().join('\n');
  assert.match(all, /📝 Novo serviço\. Entendi:/);
  assert.match(all, /Telefone: \+1 \(689\) 867-7916/);
  assert.match(all, /Levar: 4209 Old Winter Garden Rd/);
  assert.match(all, /Valor: \$160/);
  assert.doesNotMatch(all, /inteligência não respondeu/);

  // Frase comum continua com o aviso de sempre.
  await chat(ctx, DRIVER_PHONE, 'cancelar');
  const [y] = await chat(ctx, DRIVER_PHONE, 'quanto eu faturei essa semana inteira?');
  assert.match(y, /inteligência não respondeu/);
});
