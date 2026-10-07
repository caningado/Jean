// Relatório semanal da frota em PDF (para o dono, em português): milhas de cada caminhão,
// serviços feitos na semana e as próximas trocas.
import { startDoc, drawLetterhead, drawFooter, sectionLabel, usd, amount, RED, DARK, GRAY, LINE, SOFT } from '../invoice/pdf.js';

const GREEN = '#15803D';
const AMBER = '#B45309';
const dm = (day) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const dmy = (day) => `${dm(day)}/${day.slice(0, 4)}`;
const milhas = (n) => `${Number(n || 0).toLocaleString('en-US')} mi`;
const STATE = { vencido: ['ATRASADO', RED], perto: ['CHEGANDO', AMBER], ok: ['EM DIA', GREEN] };

export function renderFleetWeek({ company, logo, data }) {
  const { doc, done } = startDoc(`Relatório da frota ${data.start}`, company);
  const L = 50;
  const R = doc.page.width - 50;
  const W = R - L;
  const BOTTOM = doc.page.height - 80;
  const dia = (iso) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: data.timeZone, day: '2-digit', month: '2-digit' });
  const footer = `Relatório da frota · ${dm(data.start)} a ${dmy(data.end)}`;

  let y = drawLetterhead(doc, company, logo);
  doc.rect(L, y, W, 2).fill(RED);
  y += 14;
  doc.font('Helvetica-Bold').fontSize(20).fillColor(DARK).text('RELATÓRIO\nSEMANAL DA FROTA', L, y, { width: W - 250, lineGap: -2 });
  let my = y + 2;
  for (const [k, v] of [
    ['Semana', `${dm(data.start)} a ${dmy(data.end)}`],
    ['Caminhões', String(data.trucks.length)],
    ['Milhagem informada', `${data.trucks.length - data.totals.missing} de ${data.trucks.length}`],
  ]) {
    doc.font('Helvetica').fontSize(9.5).fillColor(GRAY).text(k, R - 230, my, { width: 110 });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(DARK).text(v, R - 120, my, { width: 120, align: 'right' });
    my += 15;
  }
  y = Math.max(doc.y, my) + 18;

  // Três números
  const boxW = (W - 20) / 3;
  const boxes = [
    ['Milhas rodadas', milhas(data.totals.miles), DARK],
    ['Serviços feitos', `${data.totals.services}${data.totals.services_cents ? `  ·  ${usd(data.totals.services_cents)}` : ''}`, DARK],
    ['Itens atrasados', String(data.totals.late), data.totals.late ? RED : GREEN],
  ];
  boxes.forEach(([k, v, color], i) => {
    const x = L + i * (boxW + 10);
    doc.roundedRect(x, y, boxW, 56, 6).fillAndStroke(i === 2 && data.totals.late ? '#FDECEE' : SOFT, LINE);
    doc.font('Helvetica').fontSize(9).fillColor(GRAY).text(k, x + 12, y + 11, { width: boxW - 24 });
    doc.font('Helvetica-Bold').fontSize(15).fillColor(color).text(v, x + 12, y + 26, { width: boxW - 24, lineBreak: false });
  });
  y += 76;

  const need = (h) => {
    if (y + h > BOTTOM) {
      drawFooter(doc, company, footer);
      doc.addPage();
      y = 50;
      return true;
    }
    return false;
  };
  const header = (cols) => {
    doc.rect(L, y, W, 20).fill(SOFT);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(GRAY);
    for (const c of cols) doc.text(c.title, c.x, y + 6.5, { width: c.w, align: c.align || 'left', lineBreak: false });
    y += 20;
  };
  const row = (cols, values, color = DARK) => {
    if (need(18)) header(cols);
    values.forEach((v, j) => {
      const [text, c, bold] = Array.isArray(v) ? v : [v, color, false];
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(c);
      doc.text(String(text), cols[j].x, y + 5, { width: cols[j].w, height: 11, align: cols[j].align || 'left', lineBreak: false, ellipsis: true });
    });
    y += 18;
    doc.moveTo(L, y).lineTo(R, y).lineWidth(0.4).strokeColor(LINE).stroke();
  };

  if (!data.trucks.length) {
    doc.font('Helvetica').fontSize(10).fillColor(GRAY).text('Nenhum caminhão cadastrado.', L, y);
  }

  for (const t of data.trucks) {
    need(150);
    // Faixa com o nome do caminhão
    doc.rect(L, y, W, 26).fill(RED);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#FFFFFF').text(`${t.name}${t.plate ? `  (${t.plate})` : ''}`, L + 12, y + 7.5, { width: W - 200, lineBreak: false });
    doc.font('Helvetica').fontSize(9.5).text(t.driver_name ? `Motorista: ${t.driver_name}` : 'Sem motorista fixo', R - 200, y + 9, { width: 188, align: 'right', lineBreak: false });
    y += 34;

    // Milhagem
    if (t.reported) {
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(DARK).text(`${milhas(t.miles)} rodadas na semana`, L, y, { continued: true });
      doc.font('Helvetica').fontSize(9.5).fillColor(GRAY).text(
        `   ${t.miles_start != null ? `${milhas(t.miles_start)} até ` : ''}${milhas(t.miles_end)}  ·  informado por ${t.reported_by || '–'} em ${dia(t.reported_at)}`
      );
    } else {
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(RED).text('Milhagem NÃO informada nesta semana', L, y, { continued: true });
      doc.font('Helvetica').fontSize(9.5).fillColor(GRAY).text(`   ·  última registrada: ${milhas(t.odometer)}`);
    }
    y = doc.y + 4;
    if (t.expenses_cents != null) {
      doc.font('Helvetica').fontSize(9.5).fillColor(GRAY).text(`Gastos lançados para este caminhão na semana: ${usd(t.expenses_cents)}`, L, y);
      y = doc.y + 4;
    }
    y += 8;

    // Serviços feitos
    sectionLabel(doc, 'SERVIÇOS FEITOS NA SEMANA', L, y);
    y += 15;
    if (!t.services.length) {
      doc.font('Helvetica').fontSize(9.5).fillColor(GRAY).text('Nenhum serviço registrado.', L, y);
      y = doc.y + 12;
    } else {
      const cols = [
        { title: 'DATA', x: L + 8, w: 38 },
        { title: 'SERVIÇO', x: L + 50, w: 130 },
        { title: 'MILHAS', x: L + 182, w: 70, align: 'right' },
        { title: 'OFICINA / OBS.', x: L + 262, w: 140 },
        { title: 'VALOR', x: R - 78, w: 70, align: 'right' },
      ];
      header(cols);
      for (const l of t.services) {
        row(cols, [dia(l.done_at), [l.item_name, DARK, true], milhas(l.miles), [l.shop, l.notes].filter(Boolean).join(' · ') || '–', l.cost_cents ? amount(l.cost_cents) : '–']);
      }
      y += 12;
    }

    // Próximas trocas
    need(60);
    sectionLabel(doc, 'PRÓXIMAS TROCAS', L, y);
    y += 15;
    const cols = [
      { title: 'ITEM', x: L + 8, w: 130 },
      { title: 'SITUAÇÃO', x: L + 140, w: 70 },
      { title: 'PRÓXIMA (MILHAS)', x: L + 212, w: 90, align: 'right' },
      { title: 'PRÓXIMA (DATA)', x: L + 312, w: 75, align: 'right' },
      { title: 'FALTA', x: R - 118, w: 110, align: 'right' },
    ];
    header(cols);
    for (const i of t.items) {
      const [label, color] = STATE[i.state];
      const left = [
        i.miles_left != null ? (i.miles_left > 0 ? milhas(i.miles_left) : `passou ${milhas(-i.miles_left)}`) : '',
        i.days_left != null ? (i.days_left > 0 ? `${i.days_left} dias` : `${-i.days_left} dias atrás`) : '',
      ]
        .filter(Boolean)
        .join(' / ');
      row(cols, [
        [i.name, DARK, true],
        [label, color, true],
        i.due_miles != null ? milhas(i.due_miles) : '–',
        i.due_date ? dmy(i.due_date) : '–',
        [left || '–', i.state === 'ok' ? DARK : color, i.state !== 'ok'],
      ]);
    }
    y += 22;
  }

  drawFooter(doc, company, footer);
  doc.end();
  return done;
}
