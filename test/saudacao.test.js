import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, chat, DRIVER_PHONE } from './helpers.js';

test('"oi" e "bom dia" recebem uma saudação curta, sem a lista de comandos', async () => {
  const ctx = makeContext();
  for (const text of ['oi', 'Bom dia', 'boa noite!', 'Oi, tudo bem?']) {
    const [r] = await chat(ctx, DRIVER_PHONE, text);
    assert.match(r, /^(Bom dia|Boa tarde|Boa noite), \S+! 👋 Em que posso ajudar\?/);
    assert.doesNotMatch(r, /Comandos/);
  }
  const [help] = await chat(ctx, DRIVER_PHONE, 'ajuda');
  assert.match(help, /\*Comandos\*/);
});

test('saudação no meio do cadastro lembra a pergunta', async () => {
  const ctx = makeContext();
  const [, r] = await chat(ctx, DRIVER_PHONE, 'novo', 'bom dia');
  assert.match(r, /Vamos continuar de onde paramos/);
  assert.match(r, /telefone/);
});
