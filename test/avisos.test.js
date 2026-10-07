import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, chat, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';
import { collectAlerts, runDaily } from '../src/lib/daily.js';

const owner = (ctx) => ctx.db.prepare('SELECT * FROM users WHERE phone = ?').get(OWNER_PHONE);
const driver = (ctx) => ctx.db.prepare('SELECT * FROM users WHERE phone = ?').get(DRIVER_PHONE);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

function oldService(ctx, days, fields = {}) {
  const s = ctx.data.services.create({ pickup: '12 Main St, Framingham', price_cents: 20000, driver_id: driver(ctx).id, ...fields });
  ctx.db.prepare("UPDATE services SET status = 'concluido', created_at = ?, completed_at = ? WHERE id = ?").run(daysAgo(days), daysAgo(days), s.id);
  return s;
}

test('cobrança atrasada: pendentes mostra há quantos dias e o alerta aparece', async () => {
  const ctx = makeContext({ COBRANCA_DIAS: '7' });
  const late = oldService(ctx, 10);
  oldService(ctx, 2);
  const [reply] = await chat(ctx, OWNER_PHONE, 'pendentes');
  assert.match(reply, /1 atrasado/);
  assert.match(reply, new RegExp(`⚠️ #${late.id} .*há 10 dias`));
  assert.match(reply, /há 2 dias/);
  assert.ok(reply.indexOf('há 10 dias') < reply.indexOf('há 2 dias'), 'mais antigo primeiro');

  const alerts = collectAlerts(ctx, owner(ctx));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /1 cliente\(s\) devendo há mais de 7 dias: \$200\.00/);

  // Depois de pago, some.
  await chat(ctx, OWNER_PHONE, `abrir ${late.id}`, 'pago 200 zelle');
  assert.equal(collectAlerts(ctx, owner(ctx)).length, 0);
});

test('manutenção: cadastro, milhas, aviso de óleo e "fiz oleo"', async () => {
  const ctx = makeContext();
  const [none] = await chat(ctx, DRIVER_PHONE, 'caminhao');
  assert.match(none, /Nenhum caminhão/);

  const { default: manutencao } = await import('../src/modules/manutencao/index.js');
  assert.ok(manutencao.routes);
  ctx.db.prepare('INSERT INTO trucks (name, driver_id, odometer, odometer_at, created_at) VALUES (?, ?, ?, ?, ?)').run('F-550', driver(ctx).id, 100000, daysAgo(0), daysAgo(0));
  const truckId = ctx.db.prepare('SELECT id FROM trucks').get().id;
  ctx.db.prepare("INSERT INTO maintenance_items (truck_id, name, every_miles, every_days, last_miles, last_date, created_at) VALUES (?, 'Troca de óleo', 5000, 180, 100000, ?, ?)").run(truckId, daysAgo(0), daysAgo(0));

  const [status] = await chat(ctx, DRIVER_PHONE, 'caminhao');
  assert.match(status, /F-550/);
  assert.match(status, /✅ Troca de óleo: faltam 5,000 mi/);

  const [km] = await chat(ctx, DRIVER_PHONE, 'odometro 104,700');
  assert.match(km, /104,700 mi registrado/);
  assert.match(km, /🟡 Troca de óleo: faltam 300 mi/);
  const [back] = await chat(ctx, DRIVER_PHONE, 'odometro 90000');
  assert.match(back, /menos do que o último/);

  await chat(ctx, DRIVER_PHONE, 'odometro 105200');
  const alerts = collectAlerts(ctx, owner(ctx));
  assert.ok(alerts.some((a) => /🔴 F-550: Troca de óleo atrasado \(passou 200 mi/.test(a.text)));

  const [done] = await chat(ctx, DRIVER_PHONE, 'troquei oleo');
  assert.match(done, /Troca de óleo do F-550 registrado em 105,200 mi/);
  assert.match(done, /faltam 5,000 mi/);
  assert.equal(collectAlerts(ctx, owner(ctx)).length, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM maintenance_log').get().n, 1);
});

test('caminhão novo pelo painel ganha os itens padrão; inspeção vence pela data', async () => {
  const ctx = makeContext();
  const { DEFAULT_ITEMS, itemStatus } = await import('../src/modules/manutencao/index.js');
  assert.ok(DEFAULT_ITEMS.some((i) => i.name === 'Inspeção anual'));
  const truck = { odometer: 0 };
  const status = itemStatus(truck, { every_days: 365, last_date: daysAgo(370) });
  assert.equal(status.state, 'vencido');
  assert.equal(itemStatus(truck, { every_days: 365, last_date: daysAgo(355) }).state, 'perto');
  assert.equal(itemStatus(truck, { every_days: 365, last_date: daysAgo(10) }).state, 'ok');
});

test('aviso da manhã: manda uma vez por dia, só depois da hora, só para o dono', async () => {
  const ctx = makeContext({ AVISO_HORA: '8', TIME_ZONE: 'America/New_York' });
  oldService(ctx, 9);
  const sent = [];
  ctx.send = async (phone, text) => {
    sent.push({ phone, text });
    return true;
  };
  // 7h em Nova York (11h UTC): cedo demais.
  assert.equal(await runDaily(ctx, new Date('2026-10-07T11:00:00Z')), 0);
  // 9h em Nova York.
  assert.equal(await runDaily(ctx, new Date('2026-10-07T13:00:00Z')), 1);
  assert.equal(sent[0].phone, OWNER_PHONE);
  assert.match(sent[0].text, /Bom dia/);
  assert.match(sent[0].text, /devendo há mais de 7 dias/);
  // Mesmo dia: não repete.
  assert.equal(await runDaily(ctx, new Date('2026-10-07T20:00:00Z')), 0);
  // Dia seguinte: manda de novo.
  assert.equal(await runDaily(ctx, new Date('2026-10-08T13:00:00Z')), 1);
});

test('aviso da manhã desligado com AVISO_HORA=off', async () => {
  const ctx = makeContext({ AVISO_HORA: 'off' });
  oldService(ctx, 9);
  ctx.send = async () => assert.fail('não devia mandar');
  assert.equal(await runDaily(ctx, new Date('2026-10-07T13:00:00Z')), 0);
});
