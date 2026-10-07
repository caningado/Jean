import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../src/app.js';
import { makeContext, chat, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';
import { statementData } from '../src/modules/empresas/index.js';

async function startServer(ctx, t) {
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone, pin) =>
    (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers
      .get('set-cookie')
      .split(';')[0];
  const call = (cookie) => async (path, { method = 'GET', body } = {}) => {
    const headers = { Cookie: cookie };
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}/api${path}`, { method, headers, body: body && JSON.stringify(body) });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, type, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  return { base, owner: call(await login(OWNER_PHONE, '1234')), driver: call(await login(DRIVER_PHONE, '5678')) };
}

function service(ctx, contact, price, daysAgo = 1) {
  const driver = ctx.db.prepare('SELECT id FROM users WHERE phone = ?').get(DRIVER_PHONE);
  const s = ctx.data.services.create({ pickup: '18580 E Colonial Dr, Orlando', price_cents: price, driver_id: driver.id, contact_id: contact.id, vehicle: '2019 Honda Civic' });
  const at = new Date(Date.now() - daysAgo * 86400000).toISOString();
  ctx.db.prepare("UPDATE services SET status = 'concluido', created_at = ?, completed_at = ? WHERE id = ?").run(at, at, s.id);
  return s;
}

test('empresa com vários solicitantes: extrato agrupado e só o que está em aberto', async (t) => {
  const ctx = makeContext();
  const { base, owner, driver } = await startServer(ctx, t);
  const created = await owner('/companies', { method: 'POST', body: { name: 'USAVE Motors', bill_to: 'USAVE MOTORS\n18580 E Colonial Dr, Ste 141\nOrlando, FL 32820' } });
  assert.equal(created.status, 201);
  assert.equal((await driver('/companies', { method: 'POST', body: { name: 'X' } })).status, 403);
  assert.equal((await owner('/companies', { method: 'POST', body: { name: 'usave motors' } })).status, 409);

  const mike = ctx.data.contacts.create({ name: 'Mike', phone: '4075550101' });
  const ana = ctx.data.contacts.create({ name: 'Ana', phone: '4075550102' });
  const other = ctx.data.contacts.create({ name: 'John Smith', phone: '4075550199' });
  for (const c of [mike, ana]) assert.equal((await driver(`/contacts/${c.id}/company`, { method: 'PUT', body: { company_id: created.data.id } })).status, 200);

  const s1 = service(ctx, mike, 15000, 10);
  service(ctx, mike, 12000, 3);
  const s3 = service(ctx, ana, 20000, 5);
  service(ctx, other, 9900, 2);
  await chat(ctx, DRIVER_PHONE, `abrir ${s3.id}`, 'pago 200 zelle');

  const data = statementData(ctx, created.data);
  assert.equal(data.count, 2, 'só os de Mike: Ana já pagou e John não é da empresa');
  assert.equal(data.groups.length, 1);
  assert.equal(data.groups[0].requester, 'Mike');
  assert.equal(data.due_cents, 27000);

  const month = statementData(ctx, created.data, new Date().toISOString().slice(0, 7));
  assert.ok(month.groups.some((g) => g.requester === 'Ana'), 'no mês aparecem os pagos também');

  const detail = await owner(`/companies/${created.data.id}`);
  assert.equal(detail.data.requesters.length, 2);
  assert.equal(detail.data.statement.due_cents, 27000);
  const list = await owner('/companies');
  assert.equal(list.data[0].due_cents, 27000);
  assert.equal(list.data[0].requesters_count, 2);

  const pdf = await owner(`/companies/${created.data.id}/statement.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.data.subarray(0, 5).toString(), '%PDF-');
  if (process.env.SAVE_PDF) fs.writeFileSync(process.env.SAVE_PDF, pdf.data);
  assert.equal((await driver(`/companies/${created.data.id}/statement.pdf`)).status, 403);
  const pub = await fetch(`${base}/extrato/${created.data.token}.pdf`);
  assert.equal(pub.status, 200);

  // Invoice de serviço de solicitante sai em nome da empresa e diz quem pediu.
  const inv = await owner(`/services/${s1.id}/invoices`);
  assert.match(inv.data.draft.bill_to, /^USAVE MOTORS\n/);
  assert.match(inv.data.draft.items[0].details, /Requested by: Mike/);
  assert.equal((await owner(`/services/${s1.id}`)).data.company_name, 'USAVE Motors');
});

test('robô: empresa e extrato', async () => {
  const ctx = makeContext();
  ctx.db.prepare("INSERT INTO companies (name, token, created_at) VALUES ('USAVE Motors', 'tok', '2026-10-01')").run();
  const mike = ctx.data.contacts.create({ name: 'Mike', phone: '4075550101' });
  const s = service(ctx, mike, 15000);
  ctx.db.prepare("UPDATE services SET status = 'aberto' WHERE id = ?").run(s.id);
  const [, linked] = await chat(ctx, DRIVER_PHONE, `abrir ${s.id}`, 'empresa usave');
  assert.match(linked, /Mike agora é solicitante da USAVE Motors/);
  const [denied] = await chat(ctx, DRIVER_PHONE, 'extrato usave');
  assert.match(denied, /Só o dono/);
  const [ext] = await chat(ctx, OWNER_PHONE, 'extrato usave');
  assert.match(ext, /USAVE Motors\* – deve \$150\.00/);
  assert.match(ext, /• Mike: \$150\.00/);
  const [which] = await chat(ctx, OWNER_PHONE, 'extrato');
  assert.match(which, /De qual empresa/);
});
