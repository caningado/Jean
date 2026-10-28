import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, chat, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';
import { hashPin } from '../src/lib/auth.js';

const VIVIANE = '14073691819';
const DAY = 86400000;

function setup() {
  const ctx = makeContext({ TIME_ZONE: 'America/New_York' });
  ctx.db.prepare("INSERT INTO users (name, phone, role, pin_hash, created_at) VALUES ('Viviane', ?, 'dono', ?, ?)").run(VIVIANE, hashPin('9999'), new Date().toISOString());
  const sent = [];
  ctx.send = async (to, text) => (sent.push({ to, text }), true);
  const driver = ctx.bot.findUser(DRIVER_PHONE);
  // Serviço de 10 dias atrás (atrasado) e um de hoje.
  const old = ctx.data.services.create({ driver_id: driver.id, pickup: 'A', vehicle: 'Honda Civic', price_cents: 15000, status: 'aberto' });
  ctx.db.prepare('UPDATE services SET created_at = ?, completed_at = ? WHERE id = ?').run(new Date(Date.now() - 10 * DAY).toISOString(), new Date(Date.now() - 10 * DAY).toISOString(), old.id);
  const today = ctx.data.services.create({ driver_id: driver.id, pickup: 'B', price_cents: 9000, status: 'aberto' });
  return { ctx, sent, driver, old: ctx.data.services.get(old.id), today };
}

async function serve(t, ctx, phone, pin) {
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers.get('set-cookie').split(';')[0];
  return (method, path, body) =>
    fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

test('motorista registra pagamento de serviço atrasado: os ADM recebem o aviso no WhatsApp', async () => {
  const { ctx, sent, driver, old } = setup();
  ctx.db.prepare('UPDATE users SET active_service_id = ? WHERE id = ?').run(old.id, driver.id);
  await chat(ctx, DRIVER_PHONE, 'pago 150 zelle');
  const toOwners = sent.filter((m) => [OWNER_PHONE, VIVIANE].includes(m.to));
  assert.equal(toOwners.length, 2);
  assert.match(toOwners[0].text, /⏰ \*Pagamento recebido de serviço atrasado\*/);
  assert.match(toOwners[0].text, /Honda Civic: \$150\.00 – Zelle · ⏰ estava atrasado 10 dias · quitado ✅/);
  assert.match(toOwners[0].text, /Registrado por Jorge/);
  assert.equal(sent.filter((m) => m.to === DRIVER_PHONE && /Pagamento recebido/.test(m.text)).length, 0);
});

test('pagamento no cartão pelo painel: o outro ADM é avisado, quem registrou não', async (t) => {
  const { ctx, sent, today } = setup();
  const call = await serve(t, ctx, OWNER_PHONE, '1234');
  assert.equal((await call('POST', `/services/${today.id}/payments`, { amount: '50', method: 'cartao' })).status, 201);
  assert.deepEqual(sent.map((m) => m.to), [VIVIANE]);
  assert.match(sent[0].text, /💳 \*Pagamento recebido no cartão\*/);
  assert.match(sent[0].text, /falta \$40\.00/);
});

test('conferir pagamentos: só de serviço de outro dia, e sai da lista depois do OK de qualquer ADM', async (t) => {
  const { ctx, old, today } = setup();
  const owner = await serve(t, ctx, OWNER_PHONE, '1234');
  await owner('POST', `/services/${old.id}/payments`, { amount: '150', method: 'zelle' });
  await owner('POST', `/services/${today.id}/payments`, { amount: '90', method: 'dinheiro' });
  let list = (await owner('GET', '/payments/conferir')).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].service_id, old.id);
  const drv = await serve(t, ctx, DRIVER_PHONE, '5678');
  assert.equal((await drv('GET', '/payments/conferir')).status, 403);
  assert.equal((await drv('POST', `/payments/${list[0].id}/ok`)).status, 403);
  const viviane = await serve(t, ctx, VIVIANE, '9999');
  assert.equal((await viviane('POST', `/payments/${list[0].id}/ok`)).status, 200);
  assert.equal((await owner('GET', '/payments/conferir')).body.length, 0);
  assert.equal((await viviane('POST', `/payments/${list[0].id}/ok`)).status, 404);
});

test('ADM busca serviços por intervalo de datas', async (t) => {
  const { ctx, old, today } = setup();
  const call = await serve(t, ctx, OWNER_PHONE, '1234');
  const day = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
  const ids = async (q) => (await call('GET', `/services?status=${q}`)).body.map((s) => s.id);
  assert.deepEqual(await ids(`&de=${day(Date.now() - 12 * DAY)}&ate=${day(Date.now() - 8 * DAY)}`), [old.id]);
  assert.deepEqual(await ids(`&de=${day(Date.now())}&ate=${day(Date.now())}`), [today.id]);
  assert.deepEqual((await ids(`&de=${day(Date.now() - 12 * DAY)}&ate=${day(Date.now())}`)).sort(), [old.id, today.id].sort());
  assert.equal((await call('GET', `/services?status=&de=${day(Date.now())}&ate=${day(Date.now() - DAY)}`)).status, 400);
});
