// Converte imagens (logo da loja, QR code) em bitmap ESC/POS (comando
// GS v 0), e compõe blocos lado a lado (logo+texto, QR+texto) como uma
// única imagem — impressoras térmicas via ESC/POS puro não têm como
// posicionar texto ao lado de uma imagem nativamente, então montamos
// tudo em um canvas e imprimimos como um bitmap só. Usa Jimp (puro JS,
// sem binário nativo) para montar/binarizar, e `qrcode` para gerar o
// QR Code fiscal.
import { Jimp, loadFont } from 'jimp';
import QRCode from 'qrcode';
import { PAPER_WIDTH_DOTS } from './escpos.js';

const GS = 0x1d;

// Texto renderizado por fonte bitmap tem bordas anti-aliased em cinza
// (principalmente traços finos, tipo o dígito "1") — um threshold
// baixo (bom pra fotos/logo) perde esses pixels e corrompe glifos
// finos. 200 preserva o anti-aliasing sem borrar o texto.
const TEXT_THRESHOLD = 200;

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  const base64 = String(input).replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(base64, 'base64');
}

// Empacota um Jimp já pronto (em escala de cinza ou não) no formato
// raster monocromático do comando GS v 0.
function packRasterGSv0(img, threshold) {
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
  return packRasterGSv0(img, threshold);
}

// Redimensiona mantendo proporção, sem ampliar, pra caber numa caixa
// de no máximo maxW x maxH.
function fitBox(w, h, maxW, maxH) {
  const scale = Math.min(maxW / w, maxH / h, 1);
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

let fonts = null;
async function getFonts() {
  if (!fonts) {
    const { SANS_16_BLACK, SANS_12_BLACK, SANS_10_BLACK } = await import('jimp/fonts');
    fonts = {
      title: await loadFont(SANS_16_BLACK),
      body: await loadFont(SANS_12_BLACK),
      small: await loadFont(SANS_10_BLACK),
    };
  }
  return fonts;
}

// Escreve linhas de texto verticalmente a partir de (x, y), cada uma
// com sua fonte ('title' | 'body' | 'small'). Retorna a altura total
// ocupada.
async function drawLines(img, lines, x, y, maxWidth) {
  const f = await getFonts();
  let cursorY = y;
  for (const line of lines) {
    const font = f[line.size || 'body'];
    img.print({ font, x, y: cursorY, text: line.text, maxWidth: maxWidth });
    cursorY += font.common.lineHeight;
  }
  return cursorY - y;
}

/**
 * Cabeçalho fiscal: logo à esquerda, dados da empresa à direita.
 * @param {object} p
 * @param {string|Buffer} [p.logoBase64]
 * @param {Array<{text:string,size?:'title'|'body'|'small'}>} p.lines
 * @param {number} [p.width]
 * @returns {Promise<Buffer|null>} comando GS v 0, ou null se não houver o que desenhar
 */
export async function composeHeader({ logoBase64, lines, width = PAPER_WIDTH_DOTS }) {
  if (!lines?.length && !logoBase64) return null;

  const pad = 8;
  const logoColW = logoBase64 ? 130 : 0;
  const textX = logoColW + (logoBase64 ? pad : 0) + pad;
  const textMaxWidth = width - textX - pad;

  // altura do bloco de texto = soma do lineHeight de cada linha (é
  // exatamente o espaçamento que drawLines() usa entre linhas)
  const f = await getFonts();
  const estHeight = (lines || []).reduce(
    (acc, l) => acc + f[l.size || 'body'].common.lineHeight, pad,
  );

  let logoImg = null;
  let logoH = 0;
  if (logoBase64) {
    logoImg = await Jimp.read(toBuffer(logoBase64));
    const fitted = fitBox(logoImg.bitmap.width, logoImg.bitmap.height, logoColW, Math.max(estHeight, 80));
    logoImg.resize({ w: fitted.w, h: fitted.h });
    logoH = fitted.h;
  }

  const height = Math.max(estHeight, logoH) + pad;
  const canvas = new Jimp({ width, height, color: 0xffffffff });

  if (logoImg) canvas.composite(logoImg, pad, Math.round((height - logoH) / 2));
  if (lines?.length) await drawLines(canvas, lines, textX, pad / 2, textMaxWidth);

  return packRasterGSv0(canvas, TEXT_THRESHOLD);
}

/**
 * Rodapé fiscal: QR Code à esquerda, NFC-e/protocolo/data à direita.
 * @param {object} p
 * @param {string} p.qrContent - conteúdo a codificar no QR (URL/consulta da NFC-e)
 * @param {Array<{text:string,size?:'title'|'body'|'small'}>} p.lines
 * @param {number} [p.width]
 * @returns {Promise<Buffer|null>}
 */
export async function composeQrFooter({ qrContent, lines, width = PAPER_WIDTH_DOTS }) {
  if (!qrContent) return null;

  const pad = 8;
  const qrSize = 160;
  const textX = qrSize + pad * 2;
  const textMaxWidth = width - textX - pad;

  const qrPng = await QRCode.toBuffer(String(qrContent), { type: 'png', margin: 1, width: qrSize });
  const qrImg = await Jimp.read(qrPng);

  const f = await getFonts();
  const textHeight = (lines || []).reduce(
    (acc, l) => acc + f[l.size || 'body'].common.lineHeight, 0,
  );

  const height = Math.max(qrSize, textHeight) + pad * 2;
  const canvas = new Jimp({ width, height, color: 0xffffffff });

  canvas.composite(qrImg, pad, Math.round((height - qrSize) / 2));
  if (lines?.length) await drawLines(canvas, lines, textX, Math.round((height - textHeight) / 2), textMaxWidth);

  return packRasterGSv0(canvas, TEXT_THRESHOLD);
}
