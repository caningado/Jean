// PDFs do motorista: pagamento da semana e fechamento do mês (em português).
import { startDoc, drawLetterhead, drawFooter, sectionLabel, usd, amount, RED, DARK, GRAY, LINE, SOFT } from '../invoice/pdf.js';

const GREEN = '#15803D';
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const mesNome = (mes) => `${MESES[Number(mes.slice(5, 7)) - 1]} de ${mes.slice(0, 4)}`;
const dm = (day) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const semana = (w) => `${dm(w.start)} a ${dm(w.end)}`;

function tiersText(tiers) {
  const sorted = [...tiers].sort((a, b) => a.from_cents - b.from_cents);
  return sorted
    .map((t, i) => {
      const next = sorted[i + 1];
      if (!t.from_cents && next) return `${t.pct}% abaixo de ${usd(next.from_cents)}`;
      return `${t.pct}% a partir de ${usd(t.from_cents)}`;
    })
    .join('  ·  ');
}

// week: segunda-feira da semana ("2026-10-05") para o PDF semanal; sem week = fechamento do mês.
export function renderDriverStatement({ company, logo, data, week = null }) {
  const w = week ? data.weeks.find((x) => x.start === week) : null;
  const title = w ? 'PAGAMENTO\nDA SEMANA' : 'FECHAMENTO\nDO MÊS';
  const { doc, done } = startDoc(`${w ? 'Semana' : 'Fechamento'} ${data.driver.name} ${w ? w.start : data.mes}`, company);
  const L = 50;
  const R = doc.page.width - 50;
  const W = R - L;
  const BOTTOM = doc.page.height - 80;
  const footer = `${data.driver.name} · ${w ? `semana de ${semana(w)}` : mesNome(data.mes)}`;

  let y = drawLetterhead(doc, company, logo);
  doc.rect(L, y, W, 2).fill(RED);
  y += 14;
  doc.font('Helvetica-Bold').fontSize(20).fillColor(DARK).text(title, L, y, { width: W - 250, lineGap: -2 });
  let my = y + 2;
  for (const [k, v] of [
    ['Motorista', data.driver.name],
    w ? ['Semana', semana(w)] : ['Mês', mesNome(data.mes)],
    w ? ['Mês', mesNome(data.mes)] : ['Serviços', String(data.services.length)],
  ]) {
    doc.font('Helvetica').fontSize(9.5).fillColor(GRAY).text(k, R - 230, my, { width: 80 });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(DARK).text(v, R - 150, my, { width: 150, align: 'right' });
    my += 15;
  }
  y = Math.max(doc.y, my) + 18;

  // Três números
  const boxW = (W - 20) / 3;
  const due = w ? w.amount_cents - w.paid_cents : data.settlement_cents - data.settled_cents;
  const boxes = w
    ? [
        ['Faturamento da semana', usd(w.revenue_cents)],
        ['Porcentagem', `${w.pct}%`],
        [w.paid_cents >= w.amount_cents && w.amount_cents ? 'Pago' : 'Valor a pagar', usd(w.amount_cents)],
      ]
    : [
        ['Faturamento do mês', usd(data.revenue_cents)],
        ['Porcentagem final', `${data.pct}%`],
        ['Total do mês', usd(data.commission_cents)],
      ];
  boxes.forEach(([k, v], i) => {
    const x = L + i * (boxW + 10);
    const hi = i === 2;
    doc.roundedRect(x, y, boxW, 56, 6).fillAndStroke(hi ? '#FDECEE' : SOFT, LINE);
    doc.font('Helvetica').fontSize(9).fillColor(GRAY).text(k, x + 12, y + 11, { width: boxW - 24 });
    doc.font('Helvetica-Bold').fontSize(16).fillColor(hi ? RED : DARK).text(v, x + 12, y + 26, { width: boxW - 24 });
  });
  y += 66;
  doc.font('Helvetica').fontSize(8.5).fillColor(GRAY).text(
    w
      ? `A porcentagem vem do faturamento do mês até o fim desta semana: ${usd(w.month_to_date_cents)}.  Faixas: ${tiersText(data.tiers)}.`
      : `Faixas: ${tiersText(data.tiers)}.`,
    L,
    y,
    { width: W }
  );
  y = doc.y + 18;

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
    doc.rect(L, y, W, 22).fill(RED);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF');
    for (const c of cols) doc.text(c.title, c.x, y + 7, { width: c.w, align: c.align || 'left', lineBreak: false });
    y += 22;
  };
  const rows = (cols, list, values) => {
    header(cols);
    list.forEach((item, i) => {
      if (need(20)) header(cols);
      if (i % 2 === 1) doc.rect(L, y, W, 20).fill(SOFT);
      doc.font('Helvetica').fontSize(9).fillColor(DARK);
      values(item).forEach((v, j) => doc.text(String(v), cols[j].x, y + 6, { width: cols[j].w, align: cols[j].align || 'left', lineBreak: false, ellipsis: true }));
      y += 20;
    });
    doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(LINE).stroke();
  };

  // Semanas do mês (só no fechamento)
  if (!w) {
    sectionLabel(doc, 'SEMANAS', L, y);
    y += 16;
    const cols = [
      { title: 'SEMANA', x: L + 10, w: 80 },
      { title: 'SERV.', x: L + 95, w: 35, align: 'right' },
      { title: 'FATURADO', x: L + 140, w: 70, align: 'right' },
      { title: 'NO MÊS', x: L + 215, w: 75, align: 'right' },
      { title: '%', x: L + 295, w: 35, align: 'right' },
      { title: 'VALOR', x: L + 335, w: 70, align: 'right' },
      { title: 'PAGO', x: R - 80, w: 70, align: 'right' },
    ];
    rows(cols, data.weeks, (x) => [semana(x), x.services, amount(x.revenue_cents), amount(x.month_to_date_cents), `${x.pct}%`, amount(x.amount_cents), x.paid_cents ? amount(x.paid_cents) : '–']);
    y += 16;

    // Acerto
    need(110);
    sectionLabel(doc, 'ACERTO DO MÊS', L, y);
    y += 16;
    const line = (k, v, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(bold ? DARK : GRAY).text(k, L, y, { width: 300 });
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(DARK).text(v, R - 150, y, { width: 150, align: 'right' });
      y += 17;
    };
    line(`Faturamento do mês ${usd(data.revenue_cents)} × ${data.pct}%`, usd(data.commission_cents));
    line('Já pago nas semanas', `- ${usd(data.weekly_paid_cents)}`);
    if (data.settled_cents) line('Acerto já pago', `- ${usd(data.settled_cents)}`);
    y += 4;
    const owed = due;
    doc.rect(L, y, W, 32).fill(owed > 0 ? RED : owed < 0 ? '#B45309' : GREEN);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#FFFFFF')
      .text(owed > 0 ? 'ACERTO A PAGAR AO MOTORISTA' : owed < 0 ? 'MOTORISTA RECEBEU A MAIS' : 'MÊS QUITADO', L + 12, y + 10, { width: 300, lineBreak: false });
    doc.text(usd(Math.abs(owed)), R - 160, y + 10, { width: 148, align: 'right', lineBreak: false });
    y += 52;
  } else {
    // Situação do pagamento da semana
    const paid = w.paid_cents >= w.amount_cents && w.amount_cents > 0;
    doc.rect(L, y, W, 32).fill(paid ? GREEN : RED);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#FFFFFF')
      .text(paid ? 'PAGO' : w.paid_cents ? 'FALTA PAGAR' : 'VALOR A PAGAR', L + 12, y + 10, { width: 300, lineBreak: false });
    doc.text(usd(paid ? w.paid_cents : due), R - 160, y + 10, { width: 148, align: 'right', lineBreak: false });
    y += 52;
  }

  // Serviços
  const list = w ? data.services.filter((s) => s.day >= w.start && s.day <= w.end) : data.services;
  need(70);
  sectionLabel(doc, w ? 'SERVIÇOS DA SEMANA' : 'SERVIÇOS DO MÊS', L, y);
  y += 16;
  if (!list.length) {
    doc.font('Helvetica').fontSize(10).fillColor(GRAY).text('Nenhum serviço entregue.', L, y);
    y += 20;
  } else {
    const cols = [
      { title: 'DATA', x: L + 10, w: 40 },
      { title: 'Nº', x: L + 55, w: 35 },
      { title: 'CLIENTE', x: L + 95, w: 150 },
      { title: 'VEÍCULO', x: L + 250, w: 150 },
      { title: 'VALOR', x: R - 80, w: 70, align: 'right' },
    ];
    rows(cols, list, (s) => [dm(s.day), `#${s.id}`, s.contact_name || '', s.vehicle || '', amount(s.price_cents)]);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text('Total faturado', L + 250, y + 8, { width: 150, lineBreak: false });
    doc.text(usd(list.reduce((t, s) => t + s.price_cents, 0)), R - 100, y + 8, { width: 90, align: 'right', lineBreak: false });
    y += 30;
  }

  drawFooter(doc, company, footer);
  doc.end();
  return done;
}
