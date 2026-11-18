// Foto para o Claude: o app do Claude (celular e site) não abre imagem muito grande que
// volta de uma ferramenta. Diminui para no máximo 1568 px no lado maior (o tamanho que o
// Claude enxerga de qualquer jeito) e manda em JPEG. Se não der para abrir, manda como está.
import { Jimp } from 'jimp';

const MAX_SIDE = 1568;
const MAX_BYTES = 600 * 1024;

export async function imageForClaude(buffer, mime = 'image/jpeg') {
  try {
    const image = await Jimp.read(buffer); // já endireita a foto pelo EXIF
    const big = Math.max(image.width, image.height) > MAX_SIDE;
    if (!big && buffer.length <= MAX_BYTES && /^image\/(jpeg|png)$/.test(mime)) return { data: buffer.toString('base64'), mimeType: mime };
    if (big) image.scaleToFit({ w: MAX_SIDE, h: MAX_SIDE });
    let out = await image.getBuffer('image/jpeg', { quality: 80 });
    if (out.length > MAX_BYTES) {
      image.scaleToFit({ w: 1000, h: 1000 });
      out = await image.getBuffer('image/jpeg', { quality: 70 });
    }
    return { data: out.toString('base64'), mimeType: 'image/jpeg' };
  } catch {
    return { data: buffer.toString('base64'), mimeType: mime };
  }
}
