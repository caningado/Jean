import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, chat, DRIVER_PHONE } from './helpers.js';
import { checkServicePrice } from '../src/lib/validate.js';

test('valor do serviço aceita free, grátis e 0; outros valores continuam conferidos', () => {
  assert.equal(checkServicePrice('free'), 0);
  assert.equal(checkServicePrice('Grátis'), 0);
  assert.equal(checkServicePrice('0'), 0);
  assert.equal(checkServicePrice('$0.00'), 0);
  assert.equal(checkServicePrice('150'), 15000);
  assert.throws(() => checkServicePrice('abc'));
  assert.throws(() => checkServicePrice('999999'));
});

test('robô: serviço free pelo WhatsApp', async () => {
  const ctx = makeContext({ PRICE_BASE: '', PRICE_PER_MILE: '' });
  const replies = await chat(ctx, DRIVER_PHONE, 'novo', '5085550123', 'John Smith', 'Rua Alfa', 'pular', 'pular', 'free', 'sim');
  assert.match(replies.at(-2), /Valor: Free \(\$0\)/);
  assert.match(replies.at(-1), /criado/);
  assert.equal(ctx.db.prepare('SELECT price_cents FROM services').get().price_cents, 0);
});
