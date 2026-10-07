import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, chat, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';
import { runDaily } from '../src/lib/daily.js';
import { weekReport, weekText } from '../src/modules/manutencao/index.js';

async function start(t, env = {}) {
  const ctx = makeContext({ TIME_ZONE: 'America/New_York', ...env });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone, pin) =>
    (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers.get('set-cookie').split(';')[0];
  const owner = await login(OWNER_PHONE, '1234');
  const call = (method, path, body, cookie = owner) =>
    fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const driver = ctx.db.prepare('SELECT * FROM users WHERE phone = ?').get(DRIVER_PHONE);
  return { ctx, base, owner, call, login, driver };
}

test('registrar serviço com oficina, valor e próxima troca marcada à mão', async (t) => {
  const { ctx, call, driver } = await start(t);
  const { body: truck } = await call('POST', '/trucks', { name: 'F-550', odometer: 100000, driver_id: driver.id });
  const oil = ctx.db.prepare("SELECT * FROM maintenance_items WHERE truck_id = ? AND name = 'Troca de óleo'").get(truck.id);

  // Próxima troca diferente do intervalo (óleo sintético: 7.500 mi).
  const r = await call('POST', `/trucks/${truck.id}/services`, { item_id: oil.id, miles: '101,000', cost: '89.90', shop: 'Jiffy Lube', next_miles: '108500', next_date: '2027-03-01' });
  assert.equal(r.status, 201);
  assert.equal(r.body.item.next_miles, 108500);
  assert.equal(r.body.log.cost_cents, 8990);
  assert.equal(r.body.log.shop, 'Jiffy Lube');
  const { body: trucks } = await call('GET', '/trucks');
  const item = trucks[0].items.find((i) => i.id === oil.id);
  assert.equal(item.due_miles, 108500);
  assert.equal(item.due_date, '2027-03-01');
  assert.match(item.note, /faltam 7,500 mi ou até 01\/03\/2027/);
  // O valor virou despesa de manutenção do caminhão.
  const exp = ctx.db.prepare('SELECT * FROM expenses').get();
  assert.equal(exp.category, 'manutencao');
  assert.equal(exp.truck_id, truck.id);
  assert.equal(exp.amount_cents, 8990);

  // Mesma conta do intervalo: não guarda à mão (mudar o intervalo depois vale).
  const r2 = await call('POST', `/trucks/${truck.id}/services`, { item_id: oil.id, miles: '102000', next_miles: '107000' });
  assert.equal(r2.body.item.next_miles, null);

  // Apagar o último volta para o anterior e apaga a despesa.
  await call('DELETE', `/maintenance-log/${r2.body.log.id}`);
  const back = ctx.db.prepare('SELECT * FROM maintenance_items WHERE id = ?').get(oil.id);
  assert.equal(back.last_miles, 101000);
  assert.equal(back.next_miles, 108500);
  await call('DELETE', `/maintenance-log/${r.body.log.id}`);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n, 0);

  // Serviço avulso com próxima data vira item para avisar.
  const bat = await call('POST', `/trucks/${truck.id}/services`, { name: 'Bateria', cost: '210', next_date: '2028-10-01' });
  assert.equal(bat.status, 201);
  assert.equal(bat.body.item.name, 'Bateria');
  // Avulso sem próxima: só fica no histórico.
  const lav = await call('POST', `/trucks/${truck.id}/services`, { name: 'Lavagem' });
  assert.equal(lav.body.item, null);

  // Erros
  assert.equal((await call('POST', `/trucks/${truck.id}/services`, {})).status, 400);
  assert.equal((await call('POST', `/trucks/${truck.id}/services`, { item_id: oil.id, next_miles: '90000' })).status, 400);
  assert.equal((await call('POST', `/trucks/${truck.id}/services`, { item_id: oil.id, date: '2999-01-01' })).status, 400);
});

test('relatório da semana: milhas rodadas, quem informou, serviços e próximas trocas', async (t) => {
  const { ctx, call, base, owner, driver } = await start(t);
  const { body: f550 } = await call('POST', '/trucks', { name: 'F-550', odometer: 100000, driver_id: driver.id });
  await call('POST', '/trucks', { name: 'Ram 5500', odometer: 50000 });
  // Leitura anterior à semana para o F-550.
  ctx.db.prepare("UPDATE odometer_readings SET at = '2026-09-20T12:00:00Z' WHERE truck_id = ?").run(f550.id);
  await chat(ctx, DRIVER_PHONE, 'odometro 100812');
  const oil = ctx.db.prepare("SELECT * FROM maintenance_items WHERE truck_id = ? AND name = 'Troca de óleo'").get(f550.id);
  await call('POST', `/trucks/${f550.id}/services`, { item_id: oil.id, cost: '85', shop: 'Oficina do Zé' });

  const rep = weekReport(ctx);
  const f = rep.trucks.find((x) => x.name === 'F-550');
  assert.equal(f.miles, 812);
  assert.equal(f.reported, true);
  assert.equal(f.reported_by, 'Jorge');
  assert.equal(f.services.length, 1);
  assert.equal(f.expenses_cents, 8500);
  const ram = rep.trucks.find((x) => x.name === 'Ram 5500');
  assert.equal(ram.reported, true, 'cadastro pelo dono conta como informado');
  assert.equal(rep.totals.services, 1);

  const text = weekText(rep, 'https://x/frota/abc/2026-10-05.pdf');
  assert.match(text, /Relatório semanal da frota/);
  assert.match(text, /F-550\*: 812 mi rodadas/);
  assert.match(text, /🔧 Troca de óleo em 100,812 mi – Oficina do Zé – \$85\.00/);
  assert.match(text, /📄 PDF: https:\/\/x/);

  const pdf = await fetch(`${base}/api/frota/semana.pdf`, { headers: { Cookie: owner } });
  assert.equal(pdf.status, 200);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
});

test('lembrete de milhagem na sexta e relatório para o dono na segunda', async (t) => {
  const { ctx, call, base, driver } = await start(t, { AVISO_HORA: '8' });
  const { body: truck } = await call('POST', '/trucks', { name: 'F-550', odometer: 100000, driver_id: driver.id });
  // Tudo cadastrado bem antes da semana testada.
  ctx.db.prepare("UPDATE odometer_readings SET at = '2026-09-01T12:00:00Z'").run();
  ctx.db.prepare("UPDATE trucks SET odometer_at = '2026-09-01T12:00:00Z', created_at = '2026-09-01T12:00:00Z'").run();
  ctx.db.prepare("UPDATE maintenance_items SET last_date = '2026-09-01T12:00:00Z', created_at = '2026-09-01T12:00:00Z'").run();
  ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('public_url', 'https://guincho.test') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  const sent = [];
  ctx.send = async (phone, text) => {
    sent.push({ phone, text });
    return true;
  };
  // Primeira vez que roda (quarta): manda o relatório da semana passada.
  await runDaily(ctx, new Date('2026-10-07T13:00:00Z'));
  assert.equal(sent.filter((m) => m.phone === OWNER_PHONE && /Relatório semanal/.test(m.text)).length, 1);
  sent.length = 0;

  // Sexta 9h (Nova York): o motorista não mandou a milhagem ainda.
  await runDaily(ctx, new Date('2026-10-09T13:00:00Z'));
  const toDriver = sent.filter((m) => m.phone === DRIVER_PHONE);
  assert.equal(toDriver.length, 1);
  assert.match(toDriver[0].text, /Falta mandar a milhagem do F-550/);
  // Sábado: não repete.
  sent.length = 0;
  await runDaily(ctx, new Date('2026-10-10T13:00:00Z'));
  assert.equal(sent.filter((m) => m.phone === DRIVER_PHONE).length, 0);

  // Segunda: relatório da semana 05/10 a 11/10, com o link do PDF.
  await runDaily(ctx, new Date('2026-10-12T13:00:00Z'));
  const report = sent.find((m) => m.phone === OWNER_PHONE && /Relatório semanal/.test(m.text));
  assert.ok(report);
  assert.match(report.text, /05\/10 a 11\/10/);
  assert.match(report.text, /milhagem \*não informada\*/);
  const link = report.text.match(/https:\/\/guincho\.test(\S+)/)[1];
  const pdf = await fetch(`${base}${link}`);
  assert.equal(pdf.status, 200);
  assert.equal((await fetch(`${base}/frota/errado/2026-10-05.pdf`)).status, 404);
  assert.ok(truck.id);
});
