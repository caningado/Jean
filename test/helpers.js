import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/app.js';
import { hashPin } from '../src/lib/auth.js';

export const OWNER_PHONE = '15085550100';
export const DRIVER_PHONE = '15085550111';

export function makeContext(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guincho-test-'));
  const config = loadConfig({
    DATA_DIR: dir,
    SESSION_SECRET: 'test-secret',
    PRICE_BASE: '75',
    PRICE_PER_MILE: '4',
    ZELLE_NAME: 'Towing J&J',
    ZELLE_CONTACT: '(508) 555-0100',
    WHATSAPP_TOKEN: '',
    WHATSAPP_PHONE_NUMBER_ID: '',
    ANTHROPIC_API_KEY: '',
    ...overrides,
  });
  const ctx = createContext(config);
  ctx.log = () => {};
  const insert = ctx.db.prepare('INSERT INTO users (name, phone, role, pin_hash, created_at) VALUES (?, ?, ?, ?, ?)');
  insert.run('Caningado', OWNER_PHONE, 'dono', hashPin('1234'), new Date().toISOString());
  insert.run('Jorge', DRIVER_PHONE, 'motorista', hashPin('5678'), new Date().toISOString());
  return ctx;
}

// Manda várias mensagens em sequência e devolve as respostas de cada uma.
export async function chat(ctx, phone, ...messages) {
  const out = [];
  for (const text of messages) out.push((await ctx.bot.handle({ phone, text })).join('\n'));
  return out;
}
