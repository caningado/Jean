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

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
