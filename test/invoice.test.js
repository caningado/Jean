import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, chat, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';

// Primeiro número do mês: ano (2) + mês (2) + 001, ex.: 2610001.
const firstOfMonth = (ctx) => {
  const [y, m] = new Intl.DateTimeFormat('en-CA', { timeZone: ctx.config.timeZone, year: 'numeric', month: '2-digit' }).format(new Date()).split('-');
  return (Number(y.slice(2)) * 100 + Number(m)) * 1000 + 1;
};

async function startServer(ctx, t) {
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone, pin) =>
    (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers
      .get('set-cookie')
      .split(';')[0];
  const call = (cookie) => async (path, { method = 'GET', body, host } = {}) => {
    const headers = { Cookie: cookie };
    if (body) headers['Content-Type'] = 'application/json';
    if (host) headers['X-Forwarded-Host'] = host;
    const res = await fetch(`${base}/api${path}`, { method, headers, body: body && JSON.stringify(body) });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, type, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  return { base, owner: call(await login(OWNER_PHONE, '1234')), driver: call(await login(DRIVER_PHONE, '5678')) };
}

function newService(ctx, fields = {}) {
  const driver = ctx.db.prepare('SELECT * FROM users WHERE phone = ?').get(DRIVER_PHONE);
  const contact = ctx.data.contacts.create({ name: 'USAVE Motors', phone: '4075550101' });
  const s = ctx.data.services.create({ pickup: '18580 E Colonial Dr, Orlando', price_cents: 15000, driver_id: driver.id, contact_id: contact.id, vehicle: '1996 Ford F350', ...fields });
  ctx.db.prepare("UPDATE services SET vin = '1FTJX35F0TEB26414' WHERE id = ?").run(s.id);
  return ctx.data.services.get(s.id);
}

test('invoice: rascunho, numeração ano+mês+sequência, PDF e link público', async (t) => {
  const ctx = makeContext();
  const service = newService(ctx);
  const { base, owner, driver } = await startServer(ctx, t);

  const { data } = await driver(`/services/${service.id}/invoices`);
  assert.equal(data.draft.number, firstOfMonth(ctx));
  assert.equal(data.draft.bill_to, 'USAVE Motors');
  assert.equal(data.draft.items[0].description, 'Towing Services');
  assert.match(data.draft.items[0].details, /^\d\d\/\d\d\/\d\d - 1996 Ford F350 - VIN: 1FTJX35F0TEB26414$/);
  assert.equal(data.draft.items[0].unit_cents, 15000);

  const created = await driver(`/services/${service.id}/invoices`, {
    method: 'POST',
    body: { ...data.draft, bill_to: 'USAVE MOTORS\n18580 E Colonial Dr, Ste 141\nOrlando, FL 32820', items: [...data.draft.items, { description: 'Waiting time', qty: '0.5', unit: '80' }] },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.number, firstOfMonth(ctx));
  assert.equal(created.data.total_cents, 19000);

  const pdf = await driver(`/invoices/${created.data.id}/pdf`);
  assert.equal(pdf.status, 200);
  assert.match(pdf.type, /application\/pdf/);
  assert.equal(pdf.data.subarray(0, 5).toString(), '%PDF-');

  // Link sem login (para o cliente).
  const pub = await fetch(`${base}/invoice/${created.data.token}.pdf`);
  assert.equal(pub.status, 200);
  assert.equal((await fetch(`${base}/invoice/naoexiste.pdf`)).status, 404);

  // Próximo número e número repetido.
  assert.equal((await owner(`/services/${service.id}/invoices`)).data.draft.number, firstOfMonth(ctx) + 1);
  const dup = await owner(`/services/${service.id}/invoices`, { method: 'POST', body: { number: firstOfMonth(ctx) } });
  assert.equal(dup.status, 400);

  // Dono muda os dados da empresa; a numeração segue o mês.
  const bad = await driver('/company', { method: 'PUT', body: { name: 'X' } });
  assert.equal(bad.status, 403);
  const ok = await owner('/company', { method: 'PUT', body: { phone: '(321) 000-0000' } });
  assert.equal(ok.data.next_number, firstOfMonth(ctx) + 1);
  // Invoice antigo (4099) não atrapalha a sequência do mês.
  ctx.db.prepare("INSERT INTO invoices (number, service_id, bill_to, items, total_cents, issue_date, due_date, token, created_at) VALUES (4099, ?, 'x', '[]', 0, '2026-01-01', '2026-01-01', 'old', '2026-01-01')").run(service.id);
  assert.equal((await owner('/company')).data.next_number, firstOfMonth(ctx) + 1);
  assert.equal((await owner('/company')).data.phone, '(321) 000-0000');
});

test('invoice pelo robô: cria uma vez e manda o link para o cliente', async (t) => {
  const ctx = makeContext();
  const service = newService(ctx);
  const { owner } = await startServer(ctx, t);
  const [none] = await chat(ctx, DRIVER_PHONE, 'invoice');
  assert.match(none, /Nenhum serviço em andamento/);
  await chat(ctx, DRIVER_PHONE, `abrir ${service.id}`);
  const [noLink] = await chat(ctx, DRIVER_PHONE, 'invoice');
  assert.match(noLink, new RegExp(`Invoice ${firstOfMonth(ctx)} do serviço`));
  assert.match(noLink, /painel/);
  // Depois que alguém abre o painel pela internet, o robô já sabe o endereço.
  ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('public_url', 'https://jean-abc.onrender.com') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  const [withLink] = await chat(ctx, DRIVER_PHONE, 'recibo');
  assert.match(withLink, /já existia/);
  assert.match(withLink, /https:\/\/jean-abc\.onrender\.com\/invoice\/[\w-]+\.pdf/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n, 1);
});

test('invoice de serviço pago sai com PAID', async (t) => {
  const ctx = makeContext();
  const service = newService(ctx);
  await chat(ctx, DRIVER_PHONE, `abrir ${service.id}`, 'pago 150 zelle', 'invoice');
  const { owner } = await startServer(ctx, t);
  const id = ctx.db.prepare('SELECT id FROM invoices').get().id;
  const pdf = await owner(`/invoices/${id}/pdf`);
  assert.equal(pdf.status, 200);
  assert.ok(pdf.data.length > 20000, 'tem o logo');
});
