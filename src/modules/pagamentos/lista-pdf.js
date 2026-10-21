// Lista de pendências em PDF (uso interno, em português): quem deve, quanto e de qual serviço.
import { startDoc, drawLetterhead, drawFooter, amount, usd, RED, DARK, GRAY, LINE, SOFT } from '../invoice/pdf.js';
import { formatPhone } from '../../lib/util.js';

const shortDate = (day) => {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y.slice(2)}`;
};

// list: itens de pendingList com `day` (AAAA-MM-DD); showIds: só o ADM vê o nº do serviço.
export function renderPendingList({ company, logo, list, today, search, showIds }) {
  const { doc, done } = startDoc('Pendências', company);
  const L = 50;
  const R = doc.page.width - 50;
  const W = R - L;
  const BOTTOM = doc.page.height - 80;
  const owed = list.reduce((t, s) => t + s.open_cents, 0);
  const insurers = list.reduce((t, s) => t + s.to_receive_cents, 0);

  let y = drawLetterhead(doc, company, logo);
  doc.rect(L, y, W, 2).fill(RED);
  y += 14;
  doc.font('Helvetica-Bold').fontSize(24).fillColor(DARK).text('PENDÊNCIAS', L, y);
  doc.font('Helvetica').fontSize(10).fillColor(GRAY).text(search ? `Busca: "${search}"` : 'Todos os serviços com valor a receber', L, doc.y + 2);
  let my = y + 2;
  for (const [k, v] of [
    ['Data', shortDate(today)],
    ['Serviços', String(list.length)],
    ['Clientes devem', usd(owed)],
    ...(insurers ? [['Seguradoras', usd(insurers)]] : []),
  ]) {
    doc.font('Helvetica').fontSize(9.5).fillColor(GRAY).text(k, R - 230, my, { width: 100 });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(DARK).text(v, R - 130, my, { width: 130, align: 'right' });
    my += 15;
  }
  y = Math.max(doc.y, my) + 16;

  const cols = [
    { title: 'DATA', x: L + 8, w: 46 },
    { title: 'CLIENTE', x: L + 56, w: 150 },
    { title: 'VEÍCULO', x: L + 210, w: 120 },
    { title: 'VALOR', x: R - 186, w: 56, align: 'right' },
    { title: 'PAGO', x: R - 126, w: 56, align: 'right' },
    { title: 'FALTA', x: R - 66, w: 58, align: 'right' },
  ];
  const header = () => {
    doc.rect(L, y, W, 22).fill(RED);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF');
    for (const c of cols) doc.text(c.title, c.x, y + 7, { width: c.w, align: c.align || 'left', lineBreak: false });
    y += 22;
  };
  const need = (h, withHeader = true) => {
    if (y + h <= BOTTOM) return;
    drawFooter(doc, company, 'Pendências');
    doc.addPage();
    y = 50;
    if (withHeader) header();
  };

  header();
  if (!list.length) {
    doc.font('Helvetica').fontSize(10).fillColor(GRAY).text('Nada pendente.', L + 8, y + 12);
    y += 36;
  }
  list.forEach((s, i) => {
    const who = [s.contact_name || '–', s.contact_phone ? formatPhone(s.contact_phone) : ''].filter(Boolean);
    const car = [s.vehicle || '–', s.plate ? `Placa ${s.plate}` : ''].filter(Boolean);
    const extra = s.to_receive_cents ? `${s.payer || 'Seguradora'}: ${usd(s.to_receive_cents)}` : '';
    const lines = Math.max(who.length, car.length + (extra ? 1 : 0), showIds ? 2 : 1);
    const h = 14 + lines * 11;
    need(h);
    if (i % 2 === 1) doc.rect(L, y, W, h).fill(SOFT);
    const ty = y + 7;
    doc.font('Helvetica').fontSize(9).fillColor(DARK).text(shortDate(s.day), cols[0].x, ty, { width: cols[0].w, lineBreak: false });
    if (showIds) doc.fontSize(8).fillColor(GRAY).text(`#${s.id}`, cols[0].x, ty + 11, { width: cols[0].w, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK).text(who[0], cols[1].x, ty, { width: cols[1].w, lineBreak: false, ellipsis: true });
    if (who[1]) doc.font('Helvetica').fontSize(8).fillColor(GRAY).text(who[1], cols[1].x, ty + 11, { width: cols[1].w, lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor(DARK).text(car[0], cols[2].x, ty, { width: cols[2].w, lineBreak: false, ellipsis: true });
    let cy = ty + 11;
    for (const line of [car[1], extra].filter(Boolean)) {
      doc.fontSize(8).fillColor(GRAY).text(line, cols[2].x, cy, { width: cols[2].w, lineBreak: false, ellipsis: true });
      cy += 11;
    }
    doc.font('Helvetica').fontSize(9).fillColor(DARK).text(amount(s.price_cents), cols[3].x, ty, { width: cols[3].w, align: 'right', lineBreak: false });
    doc.fillColor(GRAY).text(s.received_cents ? amount(s.received_cents) : '–', cols[4].x, ty, { width: cols[4].w, align: 'right', lineBreak: false });
    doc.font('Helvetica-Bold').fillColor(s.open_cents ? DARK : GRAY).text(s.open_cents ? amount(s.open_cents) : '–', cols[5].x, ty, { width: cols[5].w, align: 'right', lineBreak: false });
    y += h;
  });

  need(50, false);
  doc.moveTo(L, y).lineTo(R, y).lineWidth(1).strokeColor(LINE).stroke();
  y += 12;
  const tx = R - 230;
  doc.rect(tx - 10, y, R - tx + 10, 32).fill(RED);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#FFFFFF').text('TOTAL QUE FALTA', tx, y + 10, { width: 150, lineBreak: false });
  doc.text(usd(owed), R - 110, y + 10, { width: 100, align: 'right', lineBreak: false });

  drawFooter(doc, company, 'Pendências');
  doc.end();
  return done;
}
