import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, chat, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';

test('ADM pede serviço novo ao Jay: entra na lista sem motorista e não pergunta milhas', async () => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const r = await chat(ctx, OWNER_PHONE, 'novo', '5085550123', 'John Smith', '12 Main St, Orlando FL', 'pular', 'pular', '150', 'sim');
  assert.doesNotMatch(r.join('\n'), /milhas/);
  assert.match(r.at(-1), /sem motorista/);
  const s = ctx.data.services.get(1);
  assert.equal(s.driver_id, null);
  assert.equal(s.status, 'pendente');
  assert.equal(s.price_cents, 15000);

  // Motorista continua ficando com o serviço que ele mesmo abre.
  await chat(ctx, DRIVER_PHONE, 'novo', '5085550124', 'Ana Lima', '20 Oak St, Orlando FL', 'pular', 'pular', '90', 'sim');
  const d = ctx.data.services.get(2);
  assert.equal(d.driver_id, ctx.bot.findUser(DRIVER_PHONE).id);
  assert.equal(d.status, 'aberto');
});
