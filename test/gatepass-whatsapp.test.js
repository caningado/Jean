import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, chat, DRIVER_PHONE } from './helpers.js';
import { processMessage, extractMessages } from '../src/modules/whatsapp/index.js';

// Gemini de mentira: lê o "gate pass" e devolve os dados do serviço.
function fakeGemini(t, answer) {
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('vpic.nhtsa.dot.gov')) return Response.json({ Results: [{}] });
    if (!String(url).includes('generativelanguage')) return realFetch(url, opts);
    calls.push(JSON.parse(opts.body).contents[0].parts);
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] });
  };
  return calls;
}

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
const CARMAX = {
  tipo: 'gate pass',
  veiculo: '2020 Ram 1500 Classic branca',
  vin: '1C6RR6TT7LS111070',
  retirada: 'CarMax - Clermont, 16731 State Road 50, Clermont, FL 34711',
  cliente: 'Hello Auto Sales LLC',
  telefone: '4079858351',
  destino: '3410 Old Winter Garden Rd Unit A, Orlando, FL 32805',
  observacoes: 'Não liga (no runner). Gate pass 899927967472.',
};

test('gate pass em PDF pelo WhatsApp: lê, abre o serviço e o PDF fica anexado', async (t) => {
  const ctx = makeContext({ GEMINI_API_KEY: 'k' });
  const calls = fakeGemini(t, CARMAX);
  const sent = [];
  const client = { sendText: async (to, body) => sent.push(body), downloadMedia: async () => ({ buffer: PDF, mime: 'application/pdf' }) };

  const [msg] = extractMessages({ entry: [{ changes: [{ value: { messages: [{ id: 'd1', from: DRIVER_PHONE, type: 'document', document: { id: 'm1', filename: 'eGatePass-29151819.pdf', mime_type: 'application/pdf' } }] } }] }] });
  await processMessage(ctx, client, msg);
  assert.equal(calls[0][0].inline_data.mime_type, 'application/pdf'); // o PDF vai para a inteligência
  const all = sent.join('\n');
  assert.match(all, /Li o gate pass/);
  assert.match(all, /Cliente: Hello Auto Sales LLC/);
  assert.match(all, /Pegar: CarMax - Clermont/);
  assert.match(all, /VIN: 1C6RR6TT7LS111070/);
  assert.match(all, /no runner/);

  // Pergunta o que falta (milhas, valor) e confirma.
  const replies = await chat(ctx, DRIVER_PHONE, 'pular', '150', 'sim');
  assert.match(replies.at(-1), /criado/);
  const s = ctx.db.prepare('SELECT * FROM services').get();
  assert.equal(s.vin, '1C6RR6TT7LS111070');
  assert.match(s.pickup, /16731 State Road 50/);
  assert.match(s.notes, /no runner/);
  const docs = ctx.db.prepare('SELECT * FROM service_docs WHERE service_id = ?').all(s.id);
  assert.deepEqual(docs.map((d) => [d.name, d.mime]), [['eGatePass-29151819.pdf', 'application/pdf']]);
});

test('PDF do mesmo carro com o serviço aberto: fica anexado nele', async (t) => {
  const ctx = makeContext({ GEMINI_API_KEY: 'k' });
  fakeGemini(t, CARMAX);
  await chat(ctx, DRIVER_PHONE, 'novo', '5085550123', 'John Smith', 'Rua Alfa', 'pular', 'pular', 'pular', 'sim');
  const [reply] = await ctx.bot.handle({ phone: DRIVER_PHONE, doc: { buffer: PDF, mime: 'application/pdf', name: 'gate.pdf' } });
  assert.match(reply, /Documento guardado no serviço #1\. VIN 1C6RR6TT7LS111070 salvo/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM service_docs WHERE service_id = 1').get().n, 1);
  assert.equal(ctx.db.prepare('SELECT vin FROM services WHERE id = 1').get().vin, '1C6RR6TT7LS111070');
});
