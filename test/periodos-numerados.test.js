import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, OWNER_PHONE } from './helpers.js';
import { weeksOfYear, monthsOfYear } from '../src/lib/util.js';
import { zonedMidnight } from '../src/modules/planilha/index.js';

test('semanas numeradas: sábado a sexta, do ano da sexta', () => {
  const w26 = weeksOfYear(2026);
  assert.deepEqual(w26[0], { n: 1, start: '2025-12-27', end: '2026-01-02' });
  assert.equal(w26.length, 52);
  assert.deepEqual(w26[47], { n: 48, start: '2026-11-21', end: '2026-11-27' });
  assert.equal(w26.at(-1).end, '2026-12-25');
  assert.equal(weeksOfYear(2027)[0].start, '2026-12-26');
  // ano com 53 sextas
  assert.equal(weeksOfYear(2027).length, 53);
  for (const w of weeksOfYear(2030)) assert.equal(new Date(w.start + 'T12:00Z').getUTCDay(), 6);
  assert.deepEqual(monthsOfYear(2028)[1], { n: 2, start: '2028-02-01', end: '2028-02-29' });
});

test('lista das semanas e dos meses com quantidade e total; abrir uma semana', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const json = (method, path, body) => fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());
  const tz = ctx.config.timeZone;
  const at = (day, hour) => new Date(new Date(zonedMidnight(...day.split('-').map(Number), tz)).getTime() + hour * 3600000).toISOString();
  const mk = async (price, done) => {
    const s = await json('POST', '/services', { contact_name: 'Cliente', pickup: '12 Main St, Orlando FL', price });
    ctx.db.prepare("UPDATE services SET status = 'concluido', created_at = ?, completed_at = ? WHERE id = ?").run(at('2025-03-01', 1), done, s.id);
    return s.id;
  };
  // Semana 9 de 2025: sábado 22/02 a sexta 28/02. Sexta 23h30 ainda é da semana 9; sábado 00h30 já é da 10.
  const a = await mk(100, at('2025-02-28', 23.5));
  const b = await mk(50, at('2025-02-22', 0.5));
  const c = await mk(70, at('2025-03-01', 0.5));
  const r = await json('GET', '/services/periodos?tipo=semana&ano=2025&status=concluido');
  assert.ok(r.anos.includes(2025));
  assert.equal(r.periodos.length, 52);
  assert.equal(r.periodos[0].n, 52); // mais recente primeiro
  const w = Object.fromEntries(r.periodos.map((p) => [p.n, p]));
  assert.equal(w[9].start, '2025-02-22');
  assert.equal(w[9].count, 2);
  assert.equal(w[9].cents, 15000);
  assert.equal(w[10].count, 1);
  const m = await json('GET', '/services/periodos?tipo=mes&ano=2025&status=concluido');
  const mm = Object.fromEntries(m.periodos.map((p) => [p.n, p]));
  assert.equal(mm[2].count, 2);
  assert.equal(mm[3].cents, 7000);
  // % não paga do mês: fevereiro tem $150, recebeu $100 do serviço a → $50 não pago.
  ctx.db.prepare("INSERT INTO payments (service_id, amount_cents, method, status, created_at) VALUES (?, 10000, 'zelle', 'recebido', ?)").run(a, new Date().toISOString());
  const m2 = Object.fromEntries((await json('GET', '/services/periodos?tipo=mes&ano=2025&status=concluido')).periodos.map((p) => [p.n, p]));
  assert.equal(m2[2].unpaid_cents, 5000);
  assert.equal(m2[3].unpaid_cents, 7000);
  // Abrir a semana 9: só os entregues dela.
  const ids = (await json('GET', '/services?status=concluido&de=2025-02-22&ate=2025-02-28')).map((s) => s.id).sort();
  assert.deepEqual(ids, [a, b].sort());
  assert.ok(!ids.includes(c));
  // Serviço ainda não entregue não entra nas semanas/meses, nem em "Todos" (fica só em Pendentes/Em andamento).
  const aberto = await json('POST', '/services', { contact_name: 'Não feito', pickup: '12 Main St, Orlando FL', price: 300 });
  ctx.db.prepare("UPDATE services SET status = 'aberto', created_at = ? WHERE id = ?").run(at('2025-02-24', 10), aberto.id);
  const todos = Object.fromEntries((await json('GET', '/services/periodos?tipo=semana&ano=2025&status=')).periodos.map((p) => [p.n, p]));
  assert.equal(todos[9].count, 2);
  assert.equal(todos[9].cents, 15000);
  const semana = (await json('GET', '/services?status=&de=2025-02-22&ate=2025-02-28&feitos=1')).map((s) => s.id);
  assert.ok(!semana.includes(aberto.id));
  assert.ok(semana.includes(a));
});
