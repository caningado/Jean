import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, chat, OWNER_PHONE } from './helpers.js';

test('Pendências: procurar quem deve, pagar vários de uma vez e pagamento parcial', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) }))
    .headers.get('set-cookie')
    .split(';')[0];
  const call = (method, path, body) => fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const json = (...a) => call(...a).then((r) => r.json());

  const a = await json('POST', '/services', { contact_name: 'Ana Souza', contact_phone: '4075552697', pickup: '12 Main St, Orlando FL', price: '500' });
  const b = await json('POST', '/services', { contact_name: 'Bia Lima', pickup: '12 Main St, Orlando FL', price: '150' });
  const c = await json('POST', '/services', { contact_name: 'Caio Reis', pickup: '12 Main St, Orlando FL', price: '90' });

  // Parcial: devia 500, pagou 200.
  await json('POST', `/services/${a.id}/payments`, { amount: '200', method: 'zelle' });
  let pend = await json('GET', '/payments/pending');
  assert.equal(pend.find((s) => s.id === a.id).open_cents, 30000);

  const [busca] = await chat(ctx, OWNER_PHONE, 'pendentes ana');
  assert.match(busca, /Ana Souza – falta \$300\.00/);
  assert.doesNotMatch(busca, /Bia/);
  const [fone] = await chat(ctx, OWNER_PHONE, 'pendentes 2697');
  assert.match(fone, /Ana Souza/);
  assert.match(fone, /Total que deve: \$300\.00/);
  const [nada] = await chat(ctx, OWNER_PHONE, 'pendentes zeca');
  assert.match(nada, /Ninguém com "zeca"/);

  // Vários de uma vez: paga o que falta em cada um.
  const r = await json('POST', '/payments/lote', { service_ids: [a.id, b.id], method: 'zelle' });
  assert.deepEqual(r, { count: 2, total_cents: 45000, partial: [], still_open_cents: 0 });
  pend = await json('GET', '/payments/pending');
  assert.deepEqual(pend.map((s) => s.id), [c.id]);
  // De novo não paga duas vezes.
  assert.equal((await json('POST', '/payments/lote', { service_ids: [a.id], method: 'zelle' })).count, 0);
  assert.equal((await call('POST', '/payments/lote', { service_ids: [c.id], method: 'seguradora' })).status, 400);

  // Um pagamento só para vários serviços: deve 500 em 3, pagou 200.
  const x = await json('POST', '/services', { contact_name: 'Dino', pickup: '12 Main St, Orlando FL', price: '150' });
  const y = await json('POST', '/services', { contact_name: 'Dino', pickup: '20 Oak St, Orlando FL', price: '200' });
  const z = await json('POST', '/services', { contact_name: 'Dino', pickup: '30 Pine St, Orlando FL', price: '150' });
  assert.equal((await call('POST', '/payments/lote', { service_ids: [x.id, y.id, z.id], method: 'zelle', amount: '600' })).status, 400);
  const p = await json('POST', '/payments/lote', { service_ids: [z.id, y.id, x.id], method: 'zelle', amount: '200' });
  assert.deepEqual(p, { count: 2, total_cents: 20000, partial: [y.id], still_open_cents: 30000 });
  pend = await json('GET', '/payments/pending');
  assert.equal(pend.find((s) => s.id === x.id), undefined);
  assert.equal(pend.find((s) => s.id === y.id).open_cents, 15000);
  assert.equal(pend.find((s) => s.id === z.id).open_cents, 15000);

  // PDF da lista, com a busca.
  const pdf = await call('GET', '/payments/pending.pdf?q=dino');
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');

  // Cliente de empresa: procurar quem pediu traz tudo o que a empresa deve.
  const m1 = await json('POST', '/services', { contact_name: 'Mike', pickup: '40 Elm St, Orlando FL', price: '100' });
  const m2 = await json('POST', '/services', { contact_name: 'Carlos', pickup: '50 Elm St, Orlando FL', price: '70' });
  ctx.db.prepare("INSERT INTO companies (name, token, created_at) VALUES ('USAVE Motors', 'tk', '2026-01-01')").run();
  ctx.db.prepare("UPDATE contacts SET company_id = (SELECT id FROM companies) WHERE name IN ('Mike', 'Carlos')").run();
  const [emp] = await chat(ctx, OWNER_PHONE, 'pendentes carlos');
  assert.match(emp, new RegExp(`#${m1.id} 🏢 USAVE Motors \\(Mike\\)`));
  assert.match(emp, new RegExp(`#${m2.id} 🏢 USAVE Motors \\(Carlos\\)`));
  assert.match(emp, /Total que deve: \$170\.00/);
});
