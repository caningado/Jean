// Gera QR code (SVG) no servidor, sem chave nenhuma. Usa o ZXing (WebAssembly), o mesmo do leitor de VIN.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { writeBarcode, prepareZXingModule } from 'zxing-wasm/writer';

const require = createRequire(import.meta.url);
let ready;

export async function qrSvg(text) {
  ready ??= prepareZXingModule({
    overrides: { wasmBinary: readFileSync(require.resolve('zxing-wasm/writer/zxing_writer.wasm')) },
    fireImmediately: true,
  });
  await ready;
  const r = await writeBarcode(text, { format: 'QRCode', scale: 6 });
  if (r.error) throw new Error(`QR code: ${r.error}`);
  // Só o <svg>, para colocar direto na página.
  // viewBox para o QR poder crescer/diminuir na tela sem cortar.
  return r.svg.slice(r.svg.indexOf('<svg')).replace(/<svg width="(\d+)" height="(\d+)"/, '<svg viewBox="0 0 $1 $2"');
}
