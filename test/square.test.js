import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeContext, chat, OWNER_PHONE, DRIVER_PHONE } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSquare, validSquareSignature } from '../src/lib/square.js';
import { withCardFee, updateCardFee } from '../src/modules/pagamentos/index.js';

// Square de mentira: guarda os links criados.
function fakeSquare(ctx, payments = []) {
  ctx.square = {
    configured: true,
    links: [],
    async createLink({ amountCents, name }) {
      const n = this.links.push({ amountCents, name });
      return { id: `L${n}`, url: `https://square.link/u/${n}`, orderId: `ORD${n}` };
    },
    listPayments: async () => payments,
  };
  return ctx;
}

function setup(env = {}) {
  const ctx = fakeSquare(makeContext({ SQUARE_WEBHOOK_KEY: 'segredo', ...env }));
  const driver = ctx.db.prepare('SELECT * FROM users WHERE phone = ?').get(DRIVER_PHONE);
  const contact = ctx.data.contacts.create({ name: 'Daylon Smith', phone: '13218305723' });
  const service = ctx.data.services.create({ pickup: '1 Main St', price_cents: 21000, driver_id: driver.id, contact_id: contact.id, status: 'aberto' });
  ctx.data.services.setActive(driver.id, service.id);
  const sent = [];
  ctx.send = async (to, text) => sent.push({ to, text });
  return { ctx, service, sent };
}

test('taxa do cartão: o cliente paga a taxa e a empresa recebe o valor cheio', () => {
  const { ctx } = setup();
  const p = withCardFee(ctx, 21000); // 3.3% + $0.30
  assert.deepEqual(p, { base_cents: 21000, fee_cents: 748, total_cents: 21748 });
  assert.ok(p.total_cents - Math.round(p.total_cents * 0.033) - 30 >= 21000);
});

test('robô: *link* manda o link do cartão com a taxa; *cobrar* junta Zelle e cartão, sem criar link novo', async () => {
  const { ctx } = setup({ ZELLE_CONTACT: 'pay@jj.com' });
  let r = await chat(ctx, DRIVER_PHONE, 'link');
  assert.match(r.flat().join('\n'), /Hi Daylon! Thank you for choosing Towing J&J\.\n\nTowing service\nAmount: \$210\.00\nCard fee: \$7\.48\nTotal: \$217\.48\n\nPay securely by card: https:\/\/square\.link\/u\/1/);
  assert.doesNotMatch(r.flat().join('\n'), /#1/);
  r = await chat(ctx, DRIVER_PHONE, 'cobrar');
  assert.match(r.flat().join('\n'), /Zelle to .*\nOr pay by card \(\$217\.48, includes \$7\.48 card fee\): https:\/\/square\.link\/u\/1/);
  assert.equal(ctx.square.links.length, 1);
  assert.equal(ctx.square.links[0].amountCents, 21748);
});

test('painel: botão Link do cartão e aviso do Square marcam o serviço como pago', async (t) => {
  const { ctx, service, sent } = setup();
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  let res = await fetch(`${base}/api/services/${service.id}/square-link`, { method: 'POST', headers: { Cookie: cookie } });
  const card = await res.json();
  assert.equal(card.total_cents, 21748);
  assert.equal(card.url, 'https://square.link/u/1');
  assert.match(card.message, /Pay securely by card/);
  assert.equal((await (await fetch(`${base}/api/services/${service.id}`, { headers: { Cookie: cookie } })).json()).square, true);

  const event = JSON.stringify({ type: 'payment.updated', data: { object: { payment: { id: 'P1', order_id: 'ORD1', status: 'COMPLETED', amount_money: { amount: 21748 } } } } });
  const url = `${base}/webhook/square`;
  const host = new URL(base).host;
  const sign = (body) => crypto.createHmac('sha256', 'segredo').update(`https://${host}/webhook/square` + body).digest('base64');
  // Sem assinatura certa: ignora.
  res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-square-hmacsha256-signature': 'falso' }, body: event });
  assert.equal(res.status, 401);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM payments').get().n, 0);
  for (let i = 0; i < 2; i++) {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-square-hmacsha256-signature': sign(event) }, body: event });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 50));
  }
  const pays = ctx.db.prepare('SELECT * FROM payments').all();
  assert.equal(pays.length, 1); // aviso repetido não duplica
  assert.equal(pays[0].amount_cents, 21000); // entra o valor do serviço, a taxa fica com o Square
  assert.equal(pays[0].method, 'cartao');
  assert.ok(sent.some((m) => m.to === OWNER_PHONE && /pagou \$210\.00 com cartão \(Square\).*\n.*quitado/.test(m.text)));
  assert.ok(sent.some((m) => m.to === DRIVER_PHONE));
});

test('sem chave do webhook, ninguém marca pagamento de fora', async (t) => {
  const { ctx } = setup({ SQUARE_WEBHOOK_KEY: '' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${server.address().port}/webhook/square`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
  assert.equal(validSquareSignature({ key: '', url: 'x', rawBody: Buffer.from(''), header: 'a' }), false);
});

test('taxa atualizada todo dia com o que o Square cobrou de verdade nos nossos links', async () => {
  const { ctx, service } = setup();
  ctx.db.prepare("INSERT INTO square_links (service_id, amount_cents, url, order_id, created_at) VALUES (?, 10000, 'u', 'ORD9', '2026-10-01')").run(service.id);
  ctx.square.listPayments = async () => [
    { status: 'COMPLETED', order_id: 'ORD9', total_money: { amount: 10000 }, processing_fee: [{ amount_money: { amount: 320 } }] }, // 2.9% + 30
    { status: 'COMPLETED', order_id: 'OUTRO', total_money: { amount: 10000 }, processing_fee: [{ amount_money: { amount: 100 } }] }, // não é nosso
  ];
  const fee = await updateCardFee(ctx, new Date('2026-10-20T12:00:00Z'));
  assert.equal(fee.pct, 2.9);
  assert.deepEqual(withCardFee(ctx, 10000), { base_cents: 10000, fee_cents: 330, total_cents: 10330 });
});

test('cliente do Square: acha a loja e cria o link com valor em dólar', async () => {
  const calls = [];
  const sq = createSquare({ token: 'tk' }, async (url, opts = {}) => {
    calls.push({ url, opts });
    const body = url.endsWith('/locations') ? { locations: [{ id: 'LOC1', status: 'ACTIVE' }] } : { payment_link: { id: 'PL', url: 'https://square.link/u/x', order_id: 'O' } };
    return { ok: true, status: 200, json: async () => body };
  });
  const link = await sq.createLink({ amountCents: 21748, name: 'Tow #1' });
  assert.deepEqual(link, { id: 'PL', url: 'https://square.link/u/x', orderId: 'O' });
  assert.match(calls[1].url, /^https:\/\/connect\.squareup\.com\/v2\/online-checkout\/payment-links$/);
  const body = JSON.parse(calls[1].opts.body);
  assert.deepEqual(body.quick_pay.price_money, { amount: 21748, currency: 'USD' });
  assert.equal(body.quick_pay.location_id, 'LOC1');
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer tk');
});

test('mensagem ao cliente usa o número da invoice, não o número interno do serviço', async () => {
  const { ctx, service } = setup();
  ctx.db.prepare("UPDATE services SET vehicle = '2015 Honda Civic' WHERE id = ?").run(service.id);
  let r = await chat(ctx, DRIVER_PHONE, 'link');
  assert.match(r.flat().join('\n'), /\nTowing service – 2015 Honda Civic\n/);
  ctx.db.prepare("INSERT INTO invoices (number, service_id, items, total_cents, issue_date, due_date, token, created_at) VALUES (2610007, ?, '[]', 21000, '2026-10-20', '2026-10-20', 'tk', '2026-10-20')").run(service.id);
  r = await chat(ctx, DRIVER_PHONE, 'cobrar');
  assert.match(r.flat().join('\n'), /\nInvoice #2610007\nAmount due: \$210\.00/);
});
