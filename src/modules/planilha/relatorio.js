// Relatório do mês em PDF (em português): as mesmas abas da planilha, cada linha virando um bloco
// fácil de ler no celular. É o que o motorista recebe no lugar do Excel.
import { startDoc, drawLetterhead, drawFooter, sectionLabel, usd, RED, DARK, GRAY, LINE } from '../invoice/pdf.js';

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const mesNome = (label) => (/^\d{4}-\d{2}$/.test(label) ? `${MESES[Number(label.slice(5, 7)) - 1]} de ${label.slice(0, 4)}` : 'todo o período');

function formatter(timeZone) {
  const f = new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return (value, type) => {
    if (value === null || value === undefined || value === '') return '';
    if (type === 'money') return usd(Math.round(Number(value) * 100));
    if (type === 'date') {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? String(value) : f.format(d).replace(',', '');
    }
    return String(value).replace(/https?:\/\/\S+/g, 'local no mapa');
  };
}

// skip: colunas que não entram (ex.: "Motorista" no relatório do próprio motorista).
export function renderReport({ company, logo, sheets, label, person = null, skip = [], timeZone }) {
  const fmt = formatter(timeZone);
  const { doc, done } = startDoc(`Relatório ${label}${person ? ' ' + person : ''}`, company);
  const L = 50;
  const R = doc.page.width - 50;
  const W = R - L;
  const BOTTOM = doc.page.height - 90;

  let y = drawLetterhead(doc, company, logo);
  doc.rect(L, y, W, 2).fill(RED);
  y += 14;
  doc.font('Helvetica-Bold').fontSize(20).fillColor(DARK).text('RELATÓRIO DO MÊS', L, y, { width: W });
  y = doc.y + 4;
  const sub = [mesNome(label)[0].toUpperCase() + mesNome(label).slice(1), person && `Motorista: ${person}`].filter(Boolean).join('  ·  ');
  doc.font('Helvetica').fontSize(11).fillColor(GRAY).text(sub, L, y, { width: W });
  y = doc.y + 16;

  const newPage = () => {
    drawFooter(doc, company, 'Relatório interno');
    doc.addPage();
    return 50;
  };

  for (const sheet of sheets) {
    const cols = sheet.columns.map((c, i) => ({ ...c, i })).filter((c) => !skip.includes(c.header));
    const money = cols.find((c) => c.type === 'money');
    const status = cols.find((c) => c.header === 'Situação');
    const counted = sheet.rows.filter((r) => !status || r[status.i] !== 'Cancelado');
    const total = money ? counted.reduce((sum, r) => sum + Math.round(Number(r[money.i] || 0) * 100), 0) : null;

    if (y > BOTTOM - 60) y = newPage();
    sectionLabel(doc, sheet.name.toUpperCase(), L, y);
    const summary = `${counted.length} ${counted.length === 1 ? 'registro' : 'registros'}${money ? `  ·  Total ${usd(total)}` : ''}`;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(DARK).text(summary, L, y, { width: W, align: 'right' });
    y += 16;
    doc.moveTo(L, y).lineTo(R, y).lineWidth(0.8).strokeColor(RED).stroke();
    y += 8;

    if (!sheet.rows.length) {
      doc.font('Helvetica').fontSize(10).fillColor(GRAY).text('Nada neste mês.', L, y, { width: W });
      y = doc.y + 18;
      continue;
    }

    // Primeira linha em negrito: data, nome e valor. O resto embaixo, "Campo: valor".
    const date = cols.find((c) => c.type === 'date');
    const name = cols.find((c) => ['Cliente', 'Descrição', 'Categoria'].includes(c.header)) || cols.find((c) => !c.type && c !== status);
    const head = [date, name].filter(Boolean);
    for (const row of sheet.rows) {
      const title = head.map((c) => fmt(row[c.i], c.type)).filter(Boolean).join('  ·  ') || '—';
      const right = [money && fmt(row[money.i], 'money'), status && row[status.i]].filter(Boolean).join('  ·  ');
      const rest = cols
        .filter((c) => !head.includes(c) && c !== money && c !== status && c.header !== 'Nº')
        // Zeros (Fotos: 0, Recebido: $0.00) só poluem: ficam de fora.
        .filter((c) => !((c.type === 'money' || c.type === 'number') && !Number(row[c.i])))
        .map((c) => [c.header, fmt(row[c.i], c.type)])
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join('   ·   ');
      doc.font('Helvetica').fontSize(9);
      const need = 18 + (rest ? doc.heightOfString(rest, { width: W }) : 0) + 12;
      if (y + need > BOTTOM) y = newPage();
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(DARK).text(title, L, y, { width: W - 170, lineBreak: false, ellipsis: true });
      if (right) doc.font('Helvetica-Bold').fontSize(10).fillColor(status && row[status.i] === 'Cancelado' ? GRAY : DARK).text(right, R - 170, y, { width: 170, align: 'right' });
      y += 16;
      if (rest) {
        doc.font('Helvetica').fontSize(9).fillColor(GRAY).text(rest, L, y, { width: W, lineGap: 1 });
        y = doc.y;
      }
      y += 6;
      doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(LINE).stroke();
      y += 8;
    }
    y += 12;
  }
  drawFooter(doc, company, 'Relatório interno');
  doc.end();
  return done;
}
