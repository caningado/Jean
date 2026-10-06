import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, chat, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';
import { cashInHand } from '../src/modules/pagamentos/index.js';

// Cria um serviço do motorista e registra um pagamento nele pelo robô.
async function serviceWithPayment(ctx, phone, payment) {
  const user = ctx.db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  const service = ctx.data.services.create({ pickup: '12 Main St, Framingham', price_cents: 50000, driver_id: user.id });
  ctx.db.prepare('UPDATE users SET active_service_id = ? WHERE id = ?').run(service.id, user.id);
  const [reply] = await chat(ctx, phone, payment);
  assert.match(reply, /recebido/);
  return reply;
}

test('dinheiro e cheque acumulam em mãos até o dono recolher', async () => {
  const ctx = makeContext();
  await serviceWithPayment(ctx, DRIVER_PHONE, 'pago 100 dinheiro');
  await serviceWithPayment(ctx, DRIVER_PHONE, 'pago 80 cheque');
  await serviceWithPayment(ctx, DRIVER_PHONE, 'pago 200 zelle');
  const [jorge] = cashInHand(ctx);
  assert.equal(jorge.name, 'Jorge');
  assert.equal(jorge.in_hand_cents, 18000);
  assert.equal(jorge.payments.length, 2);

  const [mine] = await chat(ctx, DRIVER_PHONE, 'caixa');
  assert.match(mine, /Jorge: \$180\.00/);
  const [denied] = await chat(ctx, DRIVER_PHONE, 'recolhi jorge');
  assert.match(denied, /Só o dono/);

  const [partial] = await chat(ctx, OWNER_PHONE, 'recolhi 50 jorge');
  assert.match(partial, /Recolhido \$50\.00 de Jorge/);
  assert.match(partial, /\$130\.00/);
  const [all] = await chat(ctx, OWNER_PHONE, 'recolhi Jorge');
  assert.match(all, /zerado/);
  const [after] = cashInHand(ctx);
  assert.equal(after.in_hand_cents, 0);
  assert.equal(after.payments.length, 0);

  // Dinheiro novo depois do recolhimento começa do zero.
  await serviceWithPayment(ctx, DRIVER_PHONE, 'pago 40 dinheiro');
  assert.equal(cashInHand(ctx, cashInHand(ctx)[0].driver_id)[0].in_hand_cents, 4000);
  const [owner] = await chat(ctx, OWNER_PHONE, 'caixa');
  assert.match(owner, /Jorge: \$40\.00/);
  assert.match(owner, /último recolhimento hoje/);
});

test('recolher sem nome pede o motorista', async () => {
  const ctx = makeContext();
  await serviceWithPayment(ctx, DRIVER_PHONE, 'pago 100 dinheiro');
  const [reply] = await chat(ctx, OWNER_PHONE, 'recolhi');
  assert.match(reply, /De qual motorista/);
  assert.match(reply, /Jorge \(\$100\.00\)/);
});

test('pagamento anotado pelo dono no serviço do motorista fica em mãos com o motorista', async () => {
  const ctx = makeContext();
  const driver = ctx.db.prepare('SELECT * FROM users WHERE phone = ?').get(DRIVER_PHONE);
  const service = ctx.data.services.create({ pickup: '12 Main St, Framingham', price_cents: 20000, driver_id: driver.id });
  await chat(ctx, OWNER_PHONE, `abrir ${service.id}`);
  await chat(ctx, OWNER_PHONE, 'pago 120 dinheiro');
  assert.equal(cashInHand(ctx, driver.id)[0].in_hand_cents, 12000);
});
