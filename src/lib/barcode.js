// Lê códigos de barras (etiqueta da porta, para-brisa) de uma foto, direto no servidor,
// sem precisar de chave nenhuma. Usa o leitor ZXing compilado para WebAssembly.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { readBarcodes, prepareZXingModule } from 'zxing-wasm/reader';

const require = createRequire(import.meta.url);
let ready;

function load() {
  ready ??= prepareZXingModule({
    overrides: { wasmBinary: readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm')) },
    fireImmediately: true,
  });
  return ready;
}

// Formatos usados em etiquetas de VIN.
export const VIN_FORMATS = ['Code39', 'Code128', 'DataMatrix', 'QRCode', 'PDF417'];

// Procura um VIN (17 caracteres) no texto lido de um código de barras.
// Etiquetas às vezes trazem um "I" na frente (Code 39 de importados).
export function vinFromCode(text) {
  const clean = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const candidates = clean.match(/[A-HJ-NPR-Z0-9]{17}/g) || [];
  if (clean.length === 18 && clean.startsWith('I')) candidates.unshift(clean.slice(1));
  return candidates[0] || null;
}

// Devolve o VIN encontrado nos códigos de barras da imagem, ou null.
export async function readVinBarcode(buffer) {
  await load();
  const codes = await readBarcodes(new Uint8Array(buffer), { formats: VIN_FORMATS, tryHarder: true, maxNumberOfSymbols: 4 });
  for (const code of codes) {
    const vin = vinFromCode(code.text);
    if (vin) return vin;
  }
  return null;
}
