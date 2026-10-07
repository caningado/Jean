// Desenha o invoice em PDF (em inglês, para o cliente nos EUA), no estilo do modelo da Towing J&J.
import PDFDocument from 'pdfkit';

export const RED = '#C8102E';
export const DARK = '#1F2328';
export const GRAY = '#6B7280';
export const LINE = '#E5E7EB';
export const SOFT = '#F7F7F8';

export const usd = (cents) => '$' + ((cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const amount = (cents) => ((cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// "2026-10-06" -> "Oct 06, 2026"
export function longDate(day) {
  if (!day) return '';
  const [y, m, d] = String(day).slice(0, 10).split('-').map(Number);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  return `${month} ${String(d).padStart(2, '0')}, ${y}`;
}

const qtyText = (q) => (Number.isInteger(q) ? String(q) : String(Number(q).toFixed(2)).replace(/0+$/, '').replace(/\.$/, ''));

// data = { company, logo (Buffer|null), invoice: { number, issue_date, due_date, bill_to, items, notes },
//          service: { vehicle, vin, plate, pickup, dropoff, miles } | null, paid_cents }
export function renderInvoice(data) {
  const { company, logo, invoice, service } = data;
  const { doc, done } = startDoc(`Invoice ${invoice.number} - ${company.name}`, company);
  const L = 50;
  const R = doc.page.width - 50;
  const W = R - L;
  let y = drawLetterhead(doc, company, logo);

  // ---- Faixa do título ----
  doc.rect(L, y, W, 2).fill(RED);
  y += 14;
  doc.font('Helvetica-Bold').fontSize(26).fillColor(DARK).text('INVOICE', L, y);
  const meta = [
    ['Invoice No.', String(invoice.number)],
    ['Issue date', longDate(invoice.issue_date)],
    ['Due date', longDate(invoice.due_date)],
  ];
  let my = y + 2;
  for (const [label, value] of meta) {
    doc.font('Helvetica').fontSize(9.5).fillColor(GRAY).text(label, R - 210, my, { width: 100 });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(DARK).text(value, R - 110, my, { width: 110, align: 'right' });
    my += 15;
  }
  y = Math.max(doc.y, my) + 16;

  // ---- Bill to | Serviço ----
  const colW = (W - 20) / 2;
  const label = (text, x, yy) => sectionLabel(doc, text, x, yy);
  label('BILL TO', L, y);
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(DARK);
  const billLines = String(invoice.bill_to || '').split('\n').filter(Boolean);
  doc.text(billLines[0] || '', L, y + 14, { width: colW });
  doc.font('Helvetica').fontSize(9.5).fillColor(DARK);
  for (const line of billLines.slice(1)) doc.text(line, { width: colW, lineGap: 1 });
  const billBottom = doc.y;

  let svcBottom = y;
  const details = service
    ? [
        ['Vehicle', service.vehicle],
        ['VIN', service.vin],
        ['Plate', service.plate],
        ['Pickup', service.pickup],
        ['Drop-off', service.dropoff],
        ['Distance', service.miles ? `${Number(service.miles).toLocaleString('en-US', { maximumFractionDigits: 1 })} mi` : ''],
      ].filter(([, v]) => v)
    : [];
  if (details.length) {
    const sx = L + colW + 20;
    label('SERVICE DETAILS', sx, y);
    let sy = y + 14;
    for (const [k, v] of details) {
      doc.font('Helvetica').fontSize(9).fillColor(GRAY).text(k, sx, sy, { width: 55 });
      doc.font('Helvetica').fontSize(9).fillColor(DARK).text(String(v), sx + 58, sy, { width: colW - 58 });
      sy = doc.y + 3;
    }
    svcBottom = sy;
  }
  y = Math.max(billBottom, svcBottom) + 20;

  // ---- Tabela de itens ----
  const cols = { desc: L + 12, qty: R - 230, unit: R - 175, amt: R - 92 };
  doc.rect(L, y, W, 24).fill(RED);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#FFFFFF');
  doc.text('DESCRIPTION', cols.desc, y + 8);
  doc.text('QTY', cols.qty, y + 8, { width: 40, align: 'center' });
  doc.text('UNIT PRICE', cols.unit, y + 8, { width: 75, align: 'right' });
  doc.text('AMOUNT', cols.amt, y + 8, { width: 80, align: 'right' });
  y += 24;

  let subtotal = 0;
  invoice.items.forEach((item, i) => {
    const lineCents = Math.round(item.qty * item.unit_cents);
    subtotal += lineCents;
    const descW = cols.qty - cols.desc - 10;
    const h =
      doc.font('Helvetica-Bold').fontSize(10).heightOfString(item.description || '', { width: descW }) +
      (item.details ? doc.font('Helvetica').fontSize(8.5).heightOfString(item.details, { width: descW }) + 3 : 0) +
      18;
    if (i % 2 === 1) doc.rect(L, y, W, h).fill(SOFT);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text(item.description || '', cols.desc, y + 9, { width: descW });
    if (item.details) doc.font('Helvetica').fontSize(8.5).fillColor(GRAY).text(item.details, cols.desc, doc.y + 3, { width: descW });
    doc.font('Helvetica').fontSize(10).fillColor(DARK);
    doc.text(qtyText(item.qty), cols.qty, y + 9, { width: 40, align: 'center' });
    doc.text(amount(item.unit_cents), cols.unit, y + 9, { width: 75, align: 'right' });
    doc.text(amount(lineCents), cols.amt, y + 9, { width: 80, align: 'right' });
    y += h;
  });
  doc.moveTo(L, y).lineTo(R, y).lineWidth(1).strokeColor(LINE).stroke();
  y += 14;

  // ---- Totais (direita) e pagamento (esquerda) ----
  const paid = Math.min(data.paid_cents || 0, subtotal);
  const balance = subtotal - paid;
  const tx = R - 230;
  const totalRow = (text, value, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(bold ? DARK : GRAY).text(text, tx, y, { width: 130 });
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(DARK).text(value, R - 100, y, { width: 100, align: 'right' });
    y += 17;
  };
  const totalsTop = y;
  totalRow('Subtotal', usd(subtotal));
  if (paid) totalRow('Amount paid', `- ${usd(paid)}`);
  y += 4;
  doc.rect(tx - 10, y, R - tx + 10, 32).fill(balance ? RED : '#15803D');
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#FFFFFF').text(balance ? 'BALANCE DUE (USD)' : 'PAID IN FULL', tx, y + 10, { width: 150 });
  doc.text(usd(balance), R - 110, y + 10, { width: 100, align: 'right' });
  const totalsBottom = y + 32;

  // Pagamento
  let py = totalsTop;
  if (company.zelle) {
    doc.roundedRect(L, py, 240, 62, 6).fillAndStroke(SOFT, LINE);
    label('PAYMENT', L + 12, py + 10);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK).text(`Zelle: ${company.zelle}`, L + 12, py + 24, { width: 216 });
    doc.font('Helvetica').fontSize(9).fillColor(GRAY).text(`Name: ${company.zelleName || company.name}`, L + 12, doc.y + 2, { width: 216 });
    py += 74;
  }
  y = Math.max(totalsBottom, py) + 18;

  // Carimbo PAGO, embaixo do total.
  if (!balance && subtotal > 0) {
    const sx = R - 165;
    const sy = totalsBottom + 26;
    doc.save();
    doc.rotate(-12, { origin: [sx + 70, sy + 22] });
    doc.roundedRect(sx, sy, 140, 44, 6).lineWidth(3).strokeColor('#15803D').stroke();
    doc.font('Helvetica-Bold').fontSize(26).fillColor('#15803D').text('PAID', sx, sy + 10, { width: 140, align: 'center', lineBreak: false });
    doc.restore();
    y = Math.max(y, sy + 70);
  }

  if (invoice.notes) {
    label('NOTES', L, y);
    doc.font('Helvetica').fontSize(9.5).fillColor(DARK).text(invoice.notes, L, y + 13, { width: W });
    y = doc.y + 12;
  }

  drawFooter(doc, company);

  doc.end();
  return done;
}

// ---- Partes comuns (invoice e extrato) ----

export function startDoc(title, company) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, info: { Title: title, Author: company.name } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  return { doc, done };
}

export function sectionLabel(doc, text, x, y) {
  return doc.font('Helvetica-Bold').fontSize(8.5).fillColor(RED).text(text, x, y, { characterSpacing: 1 });
}

// Logo à esquerda, dados da empresa à direita. Devolve onde o conteúdo começa.
export function drawLetterhead(doc, company, logo) {
  const L = 50;
  const R = doc.page.width - 50;
  const W = R - L;
  let logoBottom = 50;
  if (logo) {
    try {
      doc.image(logo, L, 40, { fit: [110, 110] });
      logoBottom = 150;
    } catch {
      logo = null;
    }
  }
  if (!logo) {
    doc.font('Helvetica-Bold').fontSize(22).fillColor(RED).text(company.name, L, 50, { width: W / 2 });
    logoBottom = doc.y + 10;
  }
  const companyLines = [
    ...String(company.address || '').split('\n').filter(Boolean),
    [company.contact, company.phone].filter(Boolean).join('  ·  '),
    company.email,
  ].filter(Boolean);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK).text(company.name, L + W / 2, 52, { width: W / 2, align: 'right' });
  doc.font('Helvetica').fontSize(9.5).fillColor(GRAY);
  for (const line of companyLines) doc.text(line, { width: W / 2, align: 'right', lineGap: 1.5 });
  return Math.max(logoBottom, doc.y) + 14;
}

export function drawFooter(doc, company, note = 'Thank you for your business!') {
  const L = 50;
  const R = doc.page.width - 50;
  const W = R - L;
  const fy = doc.page.height - 70;
  const bottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.moveTo(L, fy).lineTo(R, fy).lineWidth(0.5).strokeColor(LINE).stroke();
  doc.font('Helvetica-Bold').fontSize(10).fillColor(RED).text(note, L, fy + 10, { width: W, align: 'center', lineBreak: false });
  doc.font('Helvetica').fontSize(8.5).fillColor(GRAY)
    .text([company.name, company.phone, company.email].filter(Boolean).join('  ·  '), L, fy + 25, { width: W, align: 'center', lineBreak: false });
  doc.page.margins.bottom = bottom;
}
