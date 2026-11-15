// Carimbo nas fotos do carro: data, hora, endereço e coordenadas escritos numa faixa
// no pé da foto, como as câmeras com marca d'água (pedido do Caningado 15/11).
// A foto original fica guardada sem mexer; o carimbo vai numa cópia.
import exifr from 'exifr';
import { Jimp, loadFont, measureText, measureTextHeight } from 'jimp';
import { SANS_16_WHITE, SANS_32_WHITE } from 'jimp/fonts';

const MAX_SIDE = 2048; // a cópia carimbada fica no máximo com 2048 px no lado maior
const fonts = {};
const font = async (name, file) => (fonts[name] ||= loadFont(file));

// GPS e hora em que a foto foi tirada, quando o celular deixou isso na foto (EXIF).
// O WhatsApp apaga esses dados das fotos comuns; foto mandada como documento mantém.
export async function readPhotoMeta(buffer) {
  try {
    const raw = await exifr.parse(buffer, { gps: true, reviveValues: false, pick: ['DateTimeOriginal', 'OffsetTimeOriginal', 'GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef'] });
    const gps = await exifr.gps(buffer).catch(() => null);
    const out = {};
    if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude) && (gps.latitude || gps.longitude)) {
      out.lat = gps.latitude;
      out.lng = gps.longitude;
    }
    const m = String(raw?.DateTimeOriginal || '').match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (m) out.taken = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6], offset: /^[+-]\d{2}:\d{2}$/.test(raw.OffsetTimeOriginal) ? raw.OffsetTimeOriginal : null };
    return out;
  } catch {
    return {};
  }
}

// Hora "de relógio" do EXIF -> ISO. Sem fuso na foto, vale o fuso da empresa.
export function takenToIso(taken, timeZone) {
  if (!taken) return null;
  const { y, mo, d, h, mi, s, offset } = taken;
  if (offset) return new Date(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}${offset}`).toISOString();
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const iso = new Date(guess - offsetMs(timeZone, new Date(guess))).toISOString();
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

const pad = (n) => String(n).padStart(2, '0');
function offsetMs(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - date.getTime();
}

// "11/15/2026 2:20 PM EST" no fuso da empresa (os clientes e as seguradoras são dos EUA).
export function stampDate(iso, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
    .format(new Date(iso))
    .replace(',', '');
}

// As letras do carimbo não têm acento: "Rua São João" vira "Rua Sao Joao".
const plain = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();

export const coordsText = (lat, lng) => `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;

// Devolve a foto carimbada (JPEG) com as linhas num canto, ou null se não der para abrir a foto.
// Discreto (pedido do Caningado 15/11): letra pequena, no canto de baixo à direita, num
// quadradinho escuro meio transparente só do tamanho do texto.
export async function stampPhoto(buffer, lines) {
  let image;
  try {
    image = await Jimp.read(buffer); // já endireita a foto pelo EXIF (celular de pé ou deitado)
  } catch {
    return null;
  }
  if (Math.max(image.width, image.height) > MAX_SIDE) image.scaleToFit({ w: MAX_SIDE, h: MAX_SIDE });
  const text = lines.map(plain).filter(Boolean);
  if (!text.length) return null;
  const big = image.width >= 1200;
  const f = await font(big ? '32' : '16', big ? SANS_32_WHITE : SANS_16_WHITE);
  const pad = Math.round(f.common.lineHeight * 0.35);
  const margin = Math.round(image.width * 0.015);
  const maxWidth = Math.round(image.width * 0.6); // endereço comprido quebra em duas linhas
  const width = Math.min(maxWidth, Math.max(...text.map((t) => measureText(f, t))));
  const heights = text.map((t) => measureTextHeight(f, t, width + 1));
  const boxW = width + pad * 2;
  const boxH = heights.reduce((a, b) => a + b, 0) + pad * 2;
  const left = Math.max(0, image.width - margin - boxW);
  const top = Math.max(0, image.height - margin - boxH);
  image.scan(left, top, Math.min(boxW, image.width - left), Math.min(boxH, image.height - top), (x, y, idx) => {
    const data = image.bitmap.data;
    data[idx] *= 0.5;
    data[idx + 1] *= 0.5;
    data[idx + 2] *= 0.5;
  });
  let y = top + pad;
  text.forEach((t, i) => {
    image.print({ font: f, x: left + pad, y, text: t, maxWidth: width + 1 });
    y += heights[i];
  });
  return image.getBuffer('image/jpeg', { quality: 85 });
}
