// Extrato mensal do caminhão em PDF (para o dono, em português): despesas, milhas e manutenção.
import { startDoc, drawLetterhead, drawFooter, sectionLabel, usd, amount, RED, DARK, GRAY, LINE, SOFT } from '../invoice/pdf.js';
import { CATEGORIES } from '../despesas/index.js';

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const mesNome = (mes) => `${MESES[Number(mes.slice(5, 7)) - 1]} de ${mes.slice(0, 4)}`;
const milhas = (n) => `${Number(n || 0).toLocaleString('en-US')} mi`;

export function renderTruckMonth({ company, logo, data }) {
  const { doc, done } = startDoc(`Despesas ${data.truck.name} ${data.mes}`, company);
  const L = 50;
  const R = doc.page.width - 50;
  const W = R - L;
  const BOTTOM = doc.page.height - 80;
  const dia = (iso) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: data.timeZone, day: '2-digit', month: '2-digit' });
  const footer = `${data.truck.name} · ${mesNome(data.mes)}`;

  let y = drawLetterhead(doc, company, logo);
  doc.rect(L, y, W, 2).fill(RED);
  y += 14;
  doc.font('Helvetica-Bold').fontSize(20).fillColor(DARK).text('DESPESAS DO\nCAMINHÃO', L, y, { width: W - 250, lineGap: -2 });
  let my = y + 2;
  for (const [k, v] of [
    ['Caminhão', `${data.truck.name}${data.truck.plate ? ` (${data.truck.plate})` : ''}`],
    ['Mês', mesNome(data.mes)],
    ['Motorista', data.truck.driver_name || '–'],
  ]) {
    doc.font('Helvetica').fontSize(9.5).fillColor(GRAY).text(k, R - 230, my, { width: 80 });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(DARK).text(v, R - 150, my, { width: 150, align: 'right' });
    my += 15;
  }
  y = Math.max(doc.y, my) + 18;

  // Três números principais.
  const boxW = (W - 20) / 3;
  const boxes = [
    ['Total gasto', usd(data.total_cents)],
    ['Milhas rodadas', data.miles ? milhas(data.miles) : '–'],
    ['Custo por milha', data.cost_per_mile_cents != null ? usd(data.cost_per_mile_cents) : '–'],
  ];
  boxes.forEach(([k, v], i) => {
    const x = L + i * (boxW + 10);
    doc.roundedRect(x, y, boxW, 56, 6).fillAndStroke(i === 0 ? '#FDECEE' : SOFT, LINE);
    doc.font('Helvetica').fontSize(9).fillColor(GRAY).text(k, x + 12, y + 11, { width: boxW - 24 });
    doc.font('Helvetica-Bold').fontSize(16).fillColor(i === 0 ? RED : DARK).text(v, x + 12, y + 26, { width: boxW - 24 });
  });
  y += 76;

  const need = (h) => {
    if (y + h > BOTTOM) {
      drawFooter(doc, company, footer);
      doc.addPage();
      y = 50;
    }
  };
  const tableHeader = (cols) => {
    doc.rect(L, y, W, 22).fill(RED);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF');
    for (const c of cols) doc.text(c.title, c.x, y + 7, { width: c.w, align: c.align || 'left', lineBreak: false });
    y += 22;
  };

  // Por tipo
  sectionLabel(doc, 'POR TIPO DE DESPESA', L, y);
  y += 16;
  const cats = Object.entries(data.by_category).sort((a, b) => b[1] - a[1]);
  if (!cats.length) {
    doc.font('Helvetica').fontSize(10).fillColor(GRAY).text('Nenhuma despesa registrada para este caminhão no mês.', L, y);
    y += 24;
  }
  for (const [cat, cents] of cats) {
    const pct = data.total_cents ? Math.round((cents / data.total_cents) * 100) : 0;
    doc.font('Helvetica').fontSize(10).fillColor(DARK).text(CATEGORIES[cat] || cat, L, y, { width: 140, lineBreak: false });
    doc.rect(L + 145, y + 2, Math.max(2, (W - 300) * (pct / 100)), 9).fill(RED);
    doc.font('Helvetica').fontSize(9).fillColor(GRAY).text(`${pct}%`, R - 150, y, { width: 50, align: 'right', lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text(usd(cents), R - 95, y, { width: 95, align: 'right', lineBreak: false });
    y += 18;
  }
  y += 14;

  // Lista de despesas
  if (data.expenses.length) {
    need(70);
    sectionLabel(doc, 'DESPESAS', L, y);
    y += 16;
    const cols = [
      { title: 'DATA', x: L + 10, w: 40 },
      { title: 'TIPO', x: L + 55, w: 85 },
      { title: 'DESCRIÇÃO', x: L + 145, w: 200 },
      { title: 'QUEM', x: L + 350, w: 80 },
      { title: 'VALOR', x: R - 80, w: 70, align: 'right' },
    ];
    tableHeader(cols);
    data.expenses.forEach((e, i) => {
      if (y + 20 > BOTTOM) {
        need(999);
        tableHeader(cols);
      }
      if (i % 2 === 1) doc.rect(L, y, W, 20).fill(SOFT);
      doc.font('Helvetica').fontSize(9).fillColor(DARK);
      const vals = [dia(e.created_at), CATEGORIES[e.category] || e.category, e.description || '', e.user_name || '', amount(e.amount_cents)];
      cols.forEach((c, j) => doc.text(vals[j], c.x, y + 6, { width: c.w, align: c.align || 'left', lineBreak: false, ellipsis: true }));
      y += 20;
    });
    doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text('Total', L + 350, y + 8, { width: 80, lineBreak: false });
    doc.text(usd(data.total_cents), R - 100, y + 8, { width: 90, align: 'right', lineBreak: false });
    y += 34;
  }

  // Manutenção feita
  if (data.maintenance.length) {
    need(60);
    sectionLabel(doc, 'MANUTENÇÃO FEITA NO MÊS', L, y);
    y += 16;
    for (const m of data.maintenance) {
      need(18);
      doc.font('Helvetica').fontSize(9.5).fillColor(DARK)
        .text(`${dia(m.done_at)}  ·  ${m.item_name}${m.miles != null ? `  ·  ${milhas(m.miles)}` : ''}${m.user_name ? `  ·  ${m.user_name}` : ''}`, L, y, { width: W, lineBreak: false });
      y += 16;
    }
  }

  drawFooter(doc, company, footer);
  doc.end();
  return done;
}
