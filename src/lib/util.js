// Funções pequenas usadas por todos os módulos.

// Deixa só os dígitos. Números americanos com 10 dígitos ganham o código do país (1).
export function normalizePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return '1' + digits;
  return digits;
}

export function formatPhone(phone) {
  if (/^1\d{10}$/.test(phone)) {
    return `+1 (${phone.slice(1, 4)}) ${phone.slice(4, 7)}-${phone.slice(7)}`;
  }
  return phone ? '+' + phone : '';
}

// "250", "$250", "250.50", "250,50", "1,250.00" -> centavos (25000)
export function parseMoney(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/[^\d.,]/g, '');
  if (!s) return null;
  if (/,\d{1,2}$/.test(s) && !/\.\d{1,2}$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

export function formatMoney(cents) {
  const value = (cents || 0) / 100;
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Para comparar comandos sem se preocupar com acento ou maiúscula.
export function simplify(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// Dia (AAAA-MM-DD) no fuso da empresa; sem data = hoje.
export function dayFormatter(timeZone) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone });
  return (iso) => f.format(iso ? new Date(iso) : new Date());
}

export function nowIso() {
  return new Date().toISOString();
}

// Início do dia de hoje no fuso da empresa, em ISO (UTC).
export function startOfDayIso(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const localAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offsetMs = localAsUtc - date.getTime();
  const localMidnightAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'));
  return new Date(localMidnightAsUtc - offsetMs).toISOString();
}

export function startOfMonthIso(timeZone, date = new Date()) {
  const day = new Intl.DateTimeFormat('en-US', { timeZone, day: 'numeric' }).format(date);
  const first = new Date(date.getTime() - (Number(day) - 1) * 86400000);
  return startOfDayIso(timeZone, first);
}

// Segunda-feira desta semana, meia-noite no fuso da empresa.
export function startOfWeekIso(timeZone, date = new Date()) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  // A semana da empresa vai de sábado a sexta (pedido do Caningado 25/10).
  const back = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'].indexOf(weekday);
  return startOfDayIso(timeZone, new Date(date.getTime() - back * 86400000));
}

export function startOfYearIso(timeZone, date = new Date()) {
  const year = Number(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(date));
  // Meio-dia UTC de 1º de janeiro ainda é 1º de janeiro no fuso dos EUA.
  return startOfDayIso(timeZone, new Date(Date.UTC(year, 0, 1, 12)));
}

// Dia "AAAA-MM-DD" mais (ou menos) alguns dias.
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Semanas numeradas do ano (sábado a sexta, pedido do Caningado 21/11).
// A semana é do ano em que cai a sexta dela: a Semana 1 é a que tem a primeira sexta do ano.
// Por isso o ano tem 52 ou 53 semanas, e a Semana 1 pode começar no fim de dezembro.
export function weeksOfYear(year) {
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const firstFriday = addDays(jan1.toISOString().slice(0, 10), (5 - jan1.getUTCDay() + 7) % 7);
  const weeks = [];
  for (let end = firstFriday; end.startsWith(String(year)); end = addDays(end, 7)) {
    weeks.push({ n: weeks.length + 1, start: addDays(end, -6), end });
  }
  return weeks;
}

// Os 12 meses do ano: { n: 1..12, start: 'AAAA-MM-01', end: último dia }.
export function monthsOfYear(year) {
  return Array.from({ length: 12 }, (_, i) => {
    const mm = String(i + 1).padStart(2, '0');
    return { n: i + 1, start: `${year}-${mm}-01`, end: new Date(Date.UTC(year, i + 1, 0)).toISOString().slice(0, 10) };
  });
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
