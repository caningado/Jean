import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createApp } from '../src/app.js';
import { buildXlsx, excelDate } from '../src/lib/xlsx.js';
import { monthRange } from '../src/modules/planilha/index.js';
import { makeContext, chat, DRIVER_PHONE, OWNER_PHONE } from './helpers.js';

// Lê os arquivos de dentro do .xlsx (que é um zip).
function unzip(buffer) {
  const files = {};
  let end = buffer.length - 22;
  while (buffer.readUInt32LE(end) !== 0x06054b50) end--;
  let p = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
    const size = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const local = buffer.readUInt32LE(p + 42);
    const name = buffer.subarray(p + 46, p + 46 + nameLen).toString();
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + size);
    const data = buffer.readUInt16LE(p + 10) === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    assert.equal(zlib.crc32(data), buffer.readUInt32LE(p + 16), name);
    files[name] = name.endsWith('.xml') || name.endsWith('.rels') ? data.toString() : data;
    p += 46 + nameLen + buffer.readUInt16LE(p + 30) + buffer.readUInt16LE(p + 32);
  }
  return files;
}

test('gera um .xlsx com abas, cabeçalho, dinheiro e datas', () => {
  const file = buildXlsx([
    { name: 'Serviços', columns: [{ header: 'Nº', type: 'number' }, { header: 'Cliente' }, { header: 'Valor', type: 'money' }, { header: 'Data', type: 'date' }], rows: [[1, 'Ana & <Bia>', 115.5, '2026-10-06T14:30:00Z']] },
    { name: 'Despesas', columns: [{ header: 'Valor', type: 'money' }], rows: [] },
  ]);
  const files = unzip(file);
  assert.match(files['xl/workbook.xml'], /<sheet name="Serviços" sheetId="1"/);
  assert.match(files['xl/workbook.xml'], /<sheet name="Despesas" sheetId="2"/);
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /<t>Cliente<\/t>/);
  assert.match(sheet, /Ana &amp; &lt;Bia&gt;/);
  assert.match(sheet, /<c r="C2" s="2"><v>115.5<\/v><\/c>/);
  // 14:30 UTC = 10:30 em Nova York (horário de verão)
  assert.equal(excelDate('2026-10-06T14:30:00Z'), 46301 + 10.5 / 24);
});

test('mês da planilha no fuso da empresa', () => {
  const r = monthRange('2026-10', 'America/New_York');
  assert.equal(r.from, '2026-10-01T04:00:00.000Z');
  assert.equal(r.to, '2026-11-01T04:00:00.000Z');
  assert.equal(monthRange('2026-12', 'America/New_York').to, '2027-01-01T05:00:00.000Z');
  assert.equal(monthRange('', 'America/New_York').label, 'tudo');
});

test('painel: baixar a planilha e link automático para o Google Planilhas', async (t) => {
  const ctx = makeContext();
  await chat(ctx, DRIVER_PHONE, 'novo', '5085550123', 'John Smith', '12 Main St, Framingham', 'Joe Shop, Worcester', 'Honda Civic ABC1234', '10', 'ok', 'sim');
  await chat(ctx, DRIVER_PHONE, 'pago 100 zelle', 'gasto 80 diesel');
  await chat(ctx, OWNER_PHONE, 'novo', '5085550199', 'Ana Lima', 'Rua Alfa 10', 'pular', 'pular', 'pular', '200', 'sim');

  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone, pin) =>
    (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) })).headers
      .get('set-cookie')
      .split(';')[0];
  const owner = await login(OWNER_PHONE, '1234');
  const driver = await login(DRIVER_PHONE, '5678');

  let res = await fetch(`${base}/api/planilha.xlsx`, { headers: { Cookie: owner } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /towing-j-j-tudo\.xlsx/);
  let files = unzip(Buffer.from(await res.arrayBuffer()));
  assert.match(files['xl/workbook.xml'], /Serviços.*Pagamentos.*Despesas/);
  const servicos = files['xl/worksheets/sheet1.xml'];
  assert.match(servicos, /John Smith/);
  assert.match(servicos, /Ana Lima/);
  assert.match(servicos, /<t>Falta receber<\/t>/);

  // Motorista só vê o que é dele.
  res = await fetch(`${base}/api/planilha.xlsx`, { headers: { Cookie: driver } });
  files = unzip(Buffer.from(await res.arrayBuffer()));
  assert.match(files['xl/worksheets/sheet1.xml'], /John Smith/);
  assert.doesNotMatch(files['xl/worksheets/sheet1.xml'], /Ana Lima/);
  assert.equal((await fetch(`${base}/api/planilha/link`, { method: 'POST', headers: { Cookie: driver } })).status, 403);

  // Mês sem nada: só os cabeçalhos.
  res = await fetch(`${base}/api/planilha.xlsx?mes=2020-01`, { headers: { Cookie: owner } });
  assert.doesNotMatch(unzip(Buffer.from(await res.arrayBuffer()))['xl/worksheets/sheet1.xml'], /John Smith/);

  // Planilha com fotos (.zip): a planilha e uma pasta por serviço.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  for (const angle of ['frente', 'traseira']) {
    res = await fetch(`${base}/api/services/1/photos?kind=antes&angle=${angle}`, { method: 'POST', headers: { Cookie: driver, 'Content-Type': 'image/jpeg' }, body: jpeg });
    assert.equal(res.status, 201);
  }
  res = await fetch(`${base}/api/planilha.zip`, { headers: { Cookie: owner } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /towing-j-j-tudo\.zip/);
  files = unzip(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(Object.keys(files).sort(), [
    'fotos/Serviço 1 - John Smith/antes - frente.jpg',
    'fotos/Serviço 1 - John Smith/antes - traseira.jpg',
    'towing-j-j-tudo.xlsx',
  ]);
  assert.deepEqual(files['fotos/Serviço 1 - John Smith/antes - frente.jpg'], jpeg);
  assert.match(unzip(files['towing-j-j-tudo.xlsx'])['xl/worksheets/sheet1.xml'], /Ana Lima/);
  // Mês sem serviços: só a planilha.
  res = await fetch(`${base}/api/planilha.zip?mes=2020-01`, { headers: { Cookie: owner } });
  assert.deepEqual(Object.keys(unzip(Buffer.from(await res.arrayBuffer()))), ['towing-j-j-2020-01.xlsx']);
  // Motorista: só as fotos dos serviços dele.
  await fetch(`${base}/api/services/2/photos?kind=depois`, { method: 'POST', headers: { Cookie: owner, 'Content-Type': 'image/jpeg' }, body: jpeg });
  res = await fetch(`${base}/api/planilha.zip`, { headers: { Cookie: driver } });
  assert.ok(Object.keys(unzip(Buffer.from(await res.arrayBuffer()))).every((n) => !n.includes('Ana Lima')));

  // Link automático
  assert.equal((await (await fetch(`${base}/api/planilha/link`, { headers: { Cookie: owner } })).json()).active, false);
  const link = await (await fetch(`${base}/api/planilha/link`, { method: 'POST', headers: { Cookie: owner } })).json();
  assert.deepEqual(link.sheets.map((s) => s.name), ['Serviços', 'Pagamentos', 'Despesas']);
  const url = link.sheets[0].url.replace(/^https?:\/\/[^/]+/, base);
  assert.match(url, /\/planilha\/[\w-]{20,}\/servicos\.csv$/);
  res = await fetch(url);
  assert.equal(res.status, 200);
  const csv = await res.text();
  assert.match(csv, /^Nº,Data,Situação,Motorista,Cliente/);
  assert.match(csv, /John Smith,"?\+1 \(508\) 555-0123"?,"12 Main St, Framingham"/);
  assert.match(csv, /,10,115\.00,2,100\.00,0\.00,15\.00,/); // milhas, valor, fotos, recebido, seguradora, falta
  assert.match(await (await fetch(link.sheets[2].url.replace(/^https?:\/\/[^/]+/, base))).text(), /80\.00,Combustível/);

  // Link errado ou depois de trocar: não funciona.
  assert.equal((await fetch(url.replace(/planilha\/[^/]+/, 'planilha/errado'))).status, 404);
  await fetch(`${base}/api/planilha/link`, { method: 'POST', headers: { Cookie: owner } });
  assert.equal((await fetch(url)).status, 404);
  await fetch(`${base}/api/planilha/link`, { method: 'DELETE', headers: { Cookie: owner } });
  assert.equal((await (await fetch(`${base}/api/planilha/link`, { headers: { Cookie: owner } })).json()).active, false);
});
