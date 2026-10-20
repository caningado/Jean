import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, chat, DRIVER_PHONE } from './helpers.js';

test('"ajuda" no meio do cadastro mostra os comandos e repete a pergunta', async () => {
  const ctx = makeContext();
  const replies = await chat(ctx, DRIVER_PHONE, 'novo', 'ajuda');
  const help = [].concat(replies[1]).join('\n');
  assert.match(help, /\*Comandos\*/);
  assert.match(help, /Responda a pergunta, ou mande \*cancelar\*/);
  assert.match(help, /telefone/);
  const user = ctx.bot.findUser(DRIVER_PHONE);
  assert.equal(ctx.bot.getConversation(user.id).flow, 'novo');
});

test('cadastro largado há mais de 6 horas é esquecido', async () => {
  const ctx = makeContext();
  await chat(ctx, DRIVER_PHONE, 'novo');
  const user = ctx.bot.findUser(DRIVER_PHONE);
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  ctx.db.prepare('UPDATE conversations SET updated_at = ? WHERE user_id = ?').run(old, user.id);
  const [reply] = await chat(ctx, DRIVER_PHONE, 'ajuda');
  assert.match(reply, /\*Comandos\*/);
  assert.doesNotMatch(reply, /meio de um cadastro/);
  assert.equal(ctx.bot.getConversation(user.id), null);
});
