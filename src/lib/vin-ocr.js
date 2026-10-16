// Lê o VIN escrito numa foto (etiqueta da porta, placa do para-brisa, documento) sem custo:
// usa o Tesseract (leitor de texto grátis) aqui no servidor e confere o dígito verificador
// para não aceitar leitura errada.
import { createRequire } from 'node:module';
import { createWorker, PSM } from 'tesseract.js';

const require = createRequire(import.meta.url);
const ENG_PATH = require('@tesseract.js-data/eng').langPath;

const TRANSLITERATION = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
// Letras e números que o leitor costuma trocar.
const LOOKALIKE = { S: '5', 5: 'S', B: '8', 8: 'B', Z: '2', 2: 'Z', G: '6', 6: 'G', A: '4', 4: 'A', T: '7', 7: 'T', D: '0', 0: 'D', U: 'V', V: 'U', L: '1', 1: 'L' };

function checkDigitOk(vin) {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i];
    const value = /\d/.test(ch) ? Number(ch) : TRANSLITERATION[ch];
    if (value === undefined) return false;
    sum += value * WEIGHTS[i];
  }
  const r = sum % 11;
  return vin[8] === (r === 10 ? 'X' : String(r));
}

// Procura um VIN válido no texto lido. O VIN vem escrito numa palavra só (sem espaços),
// então só olha dentro de cada palavra. Aceita até uma troca de letra parecida (S/5, B/8...),
// sempre conferindo o dígito verificador e os 4 últimos, que são números.
const plausible = (vin) => checkDigitOk(vin) && /\d{4}$/.test(vin);
export function findVin(text, { fuzzy = true } = {}) {
  const words = String(text || '')
    .toUpperCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Z0-9]/g, '').replace(/[OQ]/g, '0').replace(/I/g, '1'))
    .filter((w) => w.length >= 17);
  const windows = [];
  for (const w of words) for (let i = 0; i + 17 <= w.length; i++) windows.push(w.slice(i, i + 17));
  const found = windows.find(plausible);
  if (found || !fuzzy) return found || null;
  for (const w of windows) {
    for (let i = 0; i < 17; i++) {
      const alt = LOOKALIKE[w[i]];
      if (!alt) continue;
      const fixed = w.slice(0, i) + alt + w.slice(i + 1);
      if (plausible(fixed)) return fixed;
    }
  }
  return null;
}

// Um leitor só, criado na primeira foto e desligado depois de 2 minutos parado (economiza memória).
let workerPromise = null;
let idleTimer = null;
function getWorker() {
  workerPromise ??= (async () => {
    const worker = await createWorker('eng', 1, { langPath: ENG_PATH, gzip: true, cacheMethod: 'none' });
    await worker.setParameters({ debug_file: '/dev/null' });
    return worker;
  })();
  workerPromise.catch(() => (workerPromise = null));
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const w = workerPromise;
    workerPromise = null;
    (await w?.catch(() => null))?.terminate();
  }, 120_000);
  idleTimer.unref?.();
  return workerPromise;
}

// Várias tentativas, da mais rápida para a mais lenta: página inteira, texto solto,
// e a foto virada (etiqueta fotografada de lado). Para na primeira que dá um VIN válido.
const PASSES = [
  { psm: PSM.AUTO, rotate: 0 },
  { psm: PSM.SPARSE_TEXT, rotate: 0 },
  { psm: PSM.AUTO, rotate: Math.PI / 2 },
  { psm: PSM.AUTO, rotate: -Math.PI / 2 },
];
export async function readVinText(buffer) {
  const worker = await getWorker();
  const texts = [];
  for (const { psm, rotate } of PASSES) {
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await worker.recognize(buffer, { rotateRadians: rotate });
    const vin = findVin(data.text, { fuzzy: false });
    if (vin) return vin;
    texts.push(data.text);
  }
  // Nenhuma leitura certinha: aceita uma com uma letra parecida trocada (a pessoa confere depois).
  for (const text of texts) {
    const vin = findVin(text);
    if (vin) return vin;
  }
  return null;
}

export async function stopVinOcr() {
  clearTimeout(idleTimer);
  const w = workerPromise;
  workerPromise = null;
  (await w?.catch(() => null))?.terminate();
}
