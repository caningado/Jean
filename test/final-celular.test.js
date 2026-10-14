import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { makeContext, chat, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';

test('painel: os 4 últimos números do celular acham o cliente', async (t) => {
  const ctx = makeContext({ GEOCODER: 'off' });
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, pin: '1234' }) }))
    .headers.get('set-cookie').split(';')[0];
  const get = (p) => fetch(`${base}/api${p}`, { headers: { Cookie: cookie } }).then((r) => r.json());

  ctx.data.contacts.create({ name: 'Ana Lima', phone: '14075550199' });
  ctx.data.contacts.create({ name: 'Bruno Alves', phone: '14070199555' });
  // Quem termina com 0199 vem primeiro, mesmo que outro também tenha 0199 no meio.
  const r = await get('/contacts/suggest?q=0199');
  assert.deepEqual(r.map((c) => c.name), ['Ana Lima', 'Bruno Alves']);
  assert.equal(r[0].phone, '14075550199');
});

test('robô: novo serviço com só os 4 últimos números do celular', async () => {
  const ctx = makeContext();
  ctx.data.contacts.create({ name: 'Ana Lima', phone: '14075550199' });
  ctx.data.contacts.create({ name: 'Carla Dias', phone: '14075550777' });
  ctx.data.contacts.create({ name: 'Caio Dias', phone: '13215550777' });

  const [, found] = await chat(ctx, DRIVER_PHONE, 'novo', '0199');
  assert.match(found, /Ana Lima|retirada|pegar/i);
  await chat(ctx, DRIVER_PHONE, 'cancelar');

  const [, none] = await chat(ctx, DRIVER_PHONE, 'novo', '4321');
  assert.match(none, /Não achei ninguém .* 4321/);
  await chat(ctx, DRIVER_PHONE, 'cancelar');

  const [, many, pick] = await chat(ctx, DRIVER_PHONE, 'novo', '0777', '2');
  assert.match(many, /terminando em 0777/);
  assert.match(many, /Caio Dias/);
  assert.match(many, /Carla Dias/);
  assert.doesNotMatch(many, /\*0\*/);
  assert.match(pick, /retirada|pegar/i);
});
