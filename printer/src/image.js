// Converte uma imagem (logo da loja) em bitmap ESC/POS (comando GS v 0),
// para imprimir no topo do cupom. Usa Jimp (puro JS, sem binário nativo)
// para redimensionar e binarizar a imagem antes de empacotar os bits.
import { Jimp } from 'jimp';

const GS = 0x1d;

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  const base64 = String(input).replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(base64, 'base64');
}

/**
 * @param {Buffer|string} input - Buffer da imagem, ou data URL/base64
 * @param {object} [opts]
 * @param {number} [opts.maxWidth] - largura máxima em dots (múltiplo de 8)
 * @param {number} [opts.threshold] - 0-255; abaixo disso vira preto
 * @returns {Promise<Buffer>} comando GS v 0 + dados do bitmap
 */
export async function imageToGSv0(input, { maxWidth = 384, threshold = 150 } = {}) {
  const img = await Jimp.read(toBuffer(input));
  if (img.bitmap.width > maxWidth) img.resize({ w: maxWidth });
  img.greyscale();

  const w = img.bitmap.width;
  const h = img.bitmap.height;
  const bytesPerRow = Math.ceil(w / 8);
  const raster = Buffer.alloc(bytesPerRow * h, 0);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4; // RGBA, já em escala de cinza (R=G=B)
      const gray = img.bitmap.data[idx];
      if (gray < threshold) {
        raster[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x % 8);
      }
    }
  }

  const xL = bytesPerRow & 0xff;
  const xH = (bytesPerRow >> 8) & 0xff;
  const yL = h & 0xff;
  const yH = (h >> 8) & 0xff;
  const header = Buffer.from([GS, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
  return Buffer.concat([header, raster]);
}
