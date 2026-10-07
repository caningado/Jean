// Extrato (statement) da empresa em PDF: serviços separados por solicitante, com total a pagar.
import { startDoc, drawLetterhead, drawFooter, sectionLabel, longDate, usd, amount, RED, DARK, GRAY, LINE, SOFT } from '../invoice/pdf.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const shortDate = (day) => {
  const [y, m, d] = day.split('-');
  return `${m}/${d}/${y.slice(2)}`;
};

// data = statementData(...) do módulo; account = empresa cliente; company = nossa empresa (cabeçalho).
export function renderStatement({ company, logo, account, data, today }) {
  const { doc, done } = startDoc(`Statement - ${account.name}`, company);
  const L = 50;
  const R = doc.page.width - 50;
  const W = R - L;
  const BOTTOM = doc.page.height - 80;

  let y = drawLetterhead(doc, company, logo);
  doc.rect(L, y, W, 2).fill(RED);
  y += 14;
  doc.font('Helvetica-Bold').fontSize(26).fillColor(DARK).text('STATEMENT', L, y);
  const period =
    data.periodo === 'abertos' ? 'All open items' : `${MONTHS[Number(data.periodo.slice(5, 7)) - 1]} ${data.periodo.slice(0, 4)}`;
  let my = y + 2;
  for (const [k, v] of [
    ['Statement date', longDate(today)],
    ['Period', period],
    ['Services', String(data.count)],
  ]) {
    doc.font('Helvetica').fontSize(9.5).fillColor(GRAY).text(k, R - 230, my, { width: 100 });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(DARK).text(v, R - 130, my, { width: 130, align: 'right' });
    my += 15;
  }
  y = Math.max(doc.y, my) + 16;

  // Bill to | resumo
  const colW = (W - 20) / 2;
  sectionLabel(doc, 'BILL TO', L, y);
  const bill = String(account.bill_to || account.name).split('\n').filter(Boolean);
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(DARK).text(bill[0], L, y + 14, { width: colW });
  doc.font('Helvetica').fontSize(9.5);
  for (const line of bill.slice(1)) doc.text(line, { width: colW, lineGap: 1 });
  const billBottom = doc.y;

  const bx = L + colW + 20;
  doc.roundedRect(bx, y, colW, 74, 6).fillAndStroke(SOFT, LINE);
  let sy = y + 10;
  for (const [k, v] of [
    ['Total services', usd(data.amount_cents)],
    ['Payments received', data.paid_cents ? `- ${usd(data.paid_cents)}` : usd(0)],
  ]) {
    doc.font('Helvetica').fontSize(9.5).fillColor(GRAY).text(k, bx + 12, sy, { width: 120 });
    doc.font('Helvetica').fontSize(9.5).fillColor(DARK).text(v, bx + colW - 112, sy, { width: 100, align: 'right' });
    sy += 16;
  }
  doc.font('Helvetica-Bold').fontSize(12).fillColor(data.due_cents ? RED : '#15803D').text('BALANCE DUE', bx + 12, sy + 8, { width: 120 });
  doc.text(usd(data.due_cents), bx + colW - 132, sy + 8, { width: 120, align: 'right' });
  y = Math.max(billBottom, y + 74) + 20;

  // Tabela
  const cols = [
    { key: 'date', title: 'DATE', x: L + 10, w: 52 },
    { key: 'inv', title: 'INVOICE', x: L + 64, w: 52 },
    { key: 'desc', title: 'VEHICLE / VIN', x: L + 118, w: 190 },
    { key: 'amt', title: 'AMOUNT', x: R - 196, w: 60, align: 'right' },
    { key: 'paid', title: 'PAID', x: R - 132, w: 60, align: 'right' },
    { key: 'due', title: 'BALANCE', x: R - 68, w: 60, align: 'right' },
  ];
  const header = () => {
    doc.rect(L, y, W, 22).fill(RED);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF');
    for (const c of cols) doc.text(c.title, c.x, y + 7, { width: c.w, align: c.align || 'left', lineBreak: false });
    y += 22;
  };
  const newPage = (withHeader = true) => {
    drawFooter(doc, company, `Statement - ${account.name}`);
    doc.addPage();
    y = 50;
    if (withHeader) header();
  };
  const need = (h, withHeader = true) => {
    if (y + h > BOTTOM) newPage(withHeader);
  };

  header();
  if (!data.groups.length) {
    doc.font('Helvetica').fontSize(10).fillColor(GRAY).text('No open items. Thank you!', L + 10, y + 12);
    y += 36;
  }
  for (const g of data.groups) {
    need(48);
    doc.rect(L, y, W, 22).fill('#FDECEE');
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(DARK).text(`Requested by: ${g.requester}`, L + 10, y + 7, { width: 300, lineBreak: false });
    doc.font('Helvetica').fontSize(8.5).fillColor(GRAY).text(`${g.services.length} service${g.services.length === 1 ? '' : 's'}`, R - 140, y + 7.5, { width: 130, align: 'right', lineBreak: false });
    y += 22;
    g.services.forEach((s, i) => {
      const desc = [s.vehicle || `Service #${s.id}`, s.vin ? `VIN: ${s.vin}` : s.plate ? `Plate: ${s.plate}` : ''].filter(Boolean);
      const h = 14 + desc.length * 11;
      need(h);
      if (i % 2 === 1) doc.rect(L, y, W, h).fill(SOFT);
      const ty = y + 7;
      doc.font('Helvetica').fontSize(9).fillColor(DARK);
      doc.text(shortDate(s.day), cols[0].x, ty, { width: cols[0].w, lineBreak: false });
      doc.text(s.invoices.length ? s.invoices.join(', ') : '–', cols[1].x, ty, { width: cols[1].w, lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor(DARK).text(desc[0], cols[2].x, ty, { width: cols[2].w, lineBreak: false, ellipsis: true });
      if (desc[1]) doc.fontSize(8).fillColor(GRAY).text(desc[1], cols[2].x, ty + 11, { width: cols[2].w, lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor(DARK);
      doc.text(amount(s.amount_cents), cols[3].x, ty, { width: cols[3].w, align: 'right', lineBreak: false });
      doc.fillColor(GRAY).text(s.paid_cents ? amount(s.paid_cents) : '–', cols[4].x, ty, { width: cols[4].w, align: 'right', lineBreak: false });
      doc.font('Helvetica-Bold').fillColor(s.due_cents ? DARK : '#15803D').text(s.due_cents ? amount(s.due_cents) : 'PAID', cols[5].x, ty, { width: cols[5].w, align: 'right', lineBreak: false });
      y += h;
    });
    need(22);
    doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY).text(`Subtotal ${g.requester}`, cols[2].x, y + 6, { width: 200, lineBreak: false });
    doc.fillColor(DARK);
    doc.text(amount(g.amount_cents), cols[3].x, y + 6, { width: cols[3].w, align: 'right', lineBreak: false });
    doc.text(g.paid_cents ? amount(g.paid_cents) : '–', cols[4].x, y + 6, { width: cols[4].w, align: 'right', lineBreak: false });
    doc.text(amount(g.due_cents), cols[5].x, y + 6, { width: cols[5].w, align: 'right', lineBreak: false });
    y += 26;
  }

  // Total e pagamento
  need(64, false);
  doc.moveTo(L, y).lineTo(R, y).lineWidth(1).strokeColor(LINE).stroke();
  y += 12;
  const tx = R - 230;
  doc.rect(tx - 10, y, R - tx + 10, 32).fill(data.due_cents ? RED : '#15803D');
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#FFFFFF').text(data.due_cents ? 'TOTAL DUE (USD)' : 'NOTHING DUE', tx, y + 10, { width: 150, lineBreak: false });
  doc.text(usd(data.due_cents), R - 110, y + 10, { width: 100, align: 'right', lineBreak: false });
  if (company.zelle) {
    doc.roundedRect(L, y - 2, 240, 58, 6).fillAndStroke(SOFT, LINE);
    sectionLabel(doc, 'PAYMENT', L + 12, y + 8);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK).text(`Zelle: ${company.zelle}`, L + 12, y + 22, { width: 216 });
    doc.font('Helvetica').fontSize(9).fillColor(GRAY).text(`Name: ${company.zelleName || company.name}`, L + 12, doc.y + 2, { width: 216 });
  }

  drawFooter(doc, company);
  doc.end();
  return done;
}
