// Regras para não deixar entrar dado sem sentido (ex.: "23" como nome de cliente).
// Usadas tanto pelo robô quanto pelo painel. Cada função devolve o valor limpo
// ou lança ValidationError com uma mensagem pronta para mostrar ao usuário.
import { normalizePhone } from './util.js';

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const letters = (text) => (String(text).match(/\p{L}/gu) || []).length;

export function checkName(raw, what = 'O nome') {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (letters(name) < 2) throw new ValidationError(`${what} precisa ter letras. Ex: Maria Souza`);
  if (name.length > 60) throw new ValidationError(`${what} está muito comprido (máximo 60 letras).`);
  return name;
}

// Telefone com código de área: (508) 555-0123, +1 508 555 0123, +55 11 98888-7777...
export function checkPhone(raw) {
  const phone = normalizePhone(raw);
  if (phone.length < 11 || phone.length > 15) {
    throw new ValidationError('Telefone inválido. Mande com o código de área, ex: (508) 555-0123');
  }
  return phone;
}

export function checkAddress(raw, what = 'O endereço') {
  const address = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (letters(address) < 3 || address.length < 4) {
    throw new ValidationError(`${what} parece incompleto. Mande rua e cidade, ou uma referência. Ex: 12 Main St, Framingham`);
  }
  if (address.length > 300) throw new ValidationError(`${what} está muito comprido.`);
  return address;
}

export function checkVehicle(raw) {
  const vehicle = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (letters(vehicle) < 2) throw new ValidationError('Mande a marca e o modelo do veículo. Ex: Honda Civic ABC1234');
  if (vehicle.length > 60) throw new ValidationError('O veículo está muito comprido (máximo 60 letras).');
  return vehicle;
}

export function checkPlate(raw) {
  const plate = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9-]{2,8}$/.test(plate)) throw new ValidationError('Placa inválida. Use só letras e números, até 8. Ex: 7ABC123');
  return plate;
}

export function checkMiles(raw) {
  const miles = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(miles) || miles <= 0 || miles > 1000) {
    throw new ValidationError('Milhas inválidas. Mande só o número, entre 0.1 e 1000. Ex: 12.5');
  }
  return Math.round(miles * 10) / 10;
}

// Valor em centavos. max em dólares.
export function checkMoney(cents, { max = 10000, what = 'O valor' } = {}) {
  if (cents == null || !Number.isFinite(cents) || cents <= 0) throw new ValidationError(`${what} precisa ser maior que zero. Ex: 150 ou 150.50`);
  if (cents > max * 100) throw new ValidationError(`${what} parece alto demais (máximo $${max.toLocaleString('en-US')}). Confira e mande de novo.`);
  return cents;
}

// Sites de mapa aceitos quando o motorista cola um link.
const MAP_HOSTS = /(^|\.)(google\.[a-z.]+|goo\.gl|maps\.app\.goo\.gl|g\.co|waze\.com|apple\.com|bing\.com|openstreetmap\.org|here\.com)$/i;
const COORDS = /(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/;

// Local de retirada/destino: aceita endereço colado, link de mapa (Google Maps, Waze, Apple)
// ou coordenadas (ex.: a localização mandada pelo WhatsApp).
export function checkLocation(raw, what = 'O endereço') {
  const text = String(raw ?? '').trim().replace(/[ \t]+/g, ' ');
  const url = text.match(/https?:\/\/[^\s]+/i)?.[0];
  if (url) {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      /* link quebrado */
    }
    if (!MAP_HOSTS.test(host)) throw new ValidationError(`${what}: esse link não é de mapa. Cole o endereço ou o link do Google Maps / Waze.`);
    if (text.length > 600) throw new ValidationError(`${what} está muito comprido.`);
    return text;
  }
  const coords = text.match(COORDS);
  if (coords) {
    const [lat, lng] = [Number(coords[1]), Number(coords[2])];
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new ValidationError(`${what}: coordenadas inválidas.`);
    if (text.length > 300) throw new ValidationError(`${what} está muito comprido.`);
    return text;
  }
  const address = checkAddress(text.replace(/\s*\n\s*/g, ', '), what);
  if (address.length > 300) throw new ValidationError(`${what} está muito comprido.`);
  return address;
}

// Link para abrir o local no mapa do celular.
export function mapLink(location) {
  if (!location) return null;
  const url = location.match(/https?:\/\/[^\s]+/i)?.[0];
  if (url) return url;
  const coords = location.match(COORDS);
  if (coords) return `https://www.google.com/maps?q=${coords[1]},${coords[2]}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
}
