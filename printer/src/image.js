// Converte imagens (logo da loja, QR code) em bitmap ESC/POS (comando
// GS v 0), e compõe blocos lado a lado (logo+texto, QR+texto) como uma
// única imagem — impressoras térmicas via ESC/POS puro não têm como
// posicionar texto ao lado de uma imagem nativamente, então montamos
// tudo em um canvas e imprimimos como um bitmap só. Usa Jimp (puro JS,
// sem binário nativo) para montar/binarizar, e `qrcode` para gerar o
// QR Code fiscal.
import { Jimp, loadFont, measureText, measureTextHeight } from 'jimp';
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

// Converte pra preto/branco puro (sem tons de cinza) num threshold
// próprio — usado na logo antes de compor com o texto, pra que o
// threshold "duro" do texto (200) não apague tons claros da logo:
// depois de binarizada aqui, cada pixel já é 0 ou 255, então qualquer
// threshold posterior preserva o resultado.
function binarize(img, threshold) {
  img.greyscale();
  const { data } = img.bitmap;
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i] < threshold ? 0 : 255;
    data[i] = data[i + 1] = data[i + 2] = v;
  }
  return img;
}

let fonts = null;
async function getFonts() {
  if (!fonts) {
    const { SANS_32_BLACK, SANS_16_BLACK, SANS_12_BLACK, SANS_10_BLACK } = await import('jimp/fonts');
    fonts = {
      title: await loadFont(SANS_32_BLACK),
      medium: await loadFont(SANS_16_BLACK),
      body: await loadFont(SANS_12_BLACK),
      small: await loadFont(SANS_10_BLACK),
    };
  }
  return fonts;
}

// Escreve linhas de texto verticalmente a partir de (x, y), cada uma
// com sua fonte ('title' | 'medium' | 'body' | 'small'), sempre
// alinhadas à esquerda (print() não centraliza — só respeita x/maxWidth).
// `bold: true` numa linha imprime duas vezes com 1px de deslocamento
// horizontal — as fontes bitmap bundladas não têm variante negrito,
// então isso engrossa o traço (mesmo truque usado em renderização de
// texto bitmap em geral).
// Usa measureTextHeight (em vez de font.common.lineHeight) porque
// linhas longas quebram em várias linhas dentro de maxWidth, e um
// avanço fixo por linha causaria sobreposição com a linha seguinte.
async function drawLines(img, lines, x, y, maxWidth) {
  const f = await getFonts();
  let cursorY = y;
  for (const line of lines) {
    const font = f[line.size || 'body'];
    img.print({ font, x, y: cursorY, text: line.text, maxWidth });
    if (line.bold) img.print({ font, x: x + 1, y: cursorY, text: line.text, maxWidth });
    cursorY += measureTextHeight(font, line.text, maxWidth);
  }
  return cursorY - y;
}

// Mesma lógica de altura usada em drawLines, exposta pra quem precisa
// dimensionar o canvas ANTES de desenhar (composeHeader/composeQrFooter).
async function alturaLinhas(lines, maxWidth) {
  const f = await getFonts();
  let total = 0;
  for (const line of lines || []) {
    total += measureTextHeight(f[line.size || 'body'], line.text, maxWidth);
  }
  return total;
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

  // Carrega a logo isoladamente, com sua própria margem de erro: uma
  // logo que falha ao decodificar não deve derrubar o cabeçalho
  // inteiro (cai pro cabeçalho só de texto, ainda à esquerda — nunca
  // volta pro layout antigo centralizado).
  let logoImg = null;
  let logoColW = 0;
  if (logoBase64) {
    try {
      logoImg = await Jimp.read(toBuffer(logoBase64));
      logoColW = 130;
      console.log(`[logo] carregada: ${logoImg.bitmap.width}x${logoImg.bitmap.height}, alpha=${logoImg.hasAlpha()}`);
    } catch (err) {
      console.error('Logo inválida no cabeçalho, montando só com texto:', err.message);
    }
  }

  const textX = logoColW + (logoColW ? pad : 0) + pad;
  const textMaxWidth = width - textX - pad;
  const estHeight = pad + await alturaLinhas(lines, textMaxWidth);

  let logoH = 0;
  if (logoImg) {
    const fitted = fitBox(logoImg.bitmap.width, logoImg.bitmap.height, logoColW, Math.max(estHeight, 80));
    logoImg.resize({ w: fitted.w, h: fitted.h });
    // achata sobre um fundo branco opaco ANTES de binarizar — se a
    // logo tiver canal alfa (fundo transparente, PNG), isso evita
    // qualquer ambiguidade de como o alfa interage com o threshold.
    const logoChapada = new Jimp({ width: fitted.w, height: fitted.h, color: 0xffffffff });
    logoChapada.composite(logoImg, 0, 0);
    // binariza a logo no threshold de foto/logo (mais permissivo com
    // tons médios) ANTES de compor com o texto — assim tons claros da
    // logo não somem quando o canvas inteiro é rebinarizado no
    // threshold do texto (mais agressivo, ajustado pra traços finos
    // de fonte).
    binarize(logoChapada, 150);
    logoImg = logoChapada;
    logoH = fitted.h;
    console.log(`[logo] redimensionada e achatada: ${fitted.w}x${fitted.h}`);
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
  const textMaxWidthDisponivel = width - textX - pad;

  const qrPng = await QRCode.toBuffer(String(qrContent), { type: 'png', margin: 1, width: qrSize });
  const qrImg = await Jimp.read(qrPng);

  // Largura do bloco = só o necessário pro conteúdo (QR + texto), não
  // a largura toda do papel — o ALIGN_CENTER já ativo no cupom quando
  // isso é impresso centraliza automaticamente um bitmap mais estreito
  // que o papel, então o bloco sai centralizado sem cálculo manual.
  const f = await getFonts();
  let maxLineWidth = 0;
  for (const line of lines || []) {
    maxLineWidth = Math.max(maxLineWidth, measureText(f[line.size || 'body'], line.text));
  }
  const textMaxWidth = Math.min(Math.max(maxLineWidth, 1), textMaxWidthDisponivel);
  const blockWidth = Math.min(textX + textMaxWidth + pad, width);

  const textHeight = await alturaLinhas(lines, textMaxWidth);

  const height = Math.max(qrSize, textHeight) + pad * 2;
  const canvas = new Jimp({ width: blockWidth, height, color: 0xffffffff });

  canvas.composite(qrImg, pad, Math.round((height - qrSize) / 2));
  if (lines?.length) await drawLines(canvas, lines, textX, Math.round((height - textHeight) / 2), textMaxWidth);

  return packRasterGSv0(canvas, TEXT_THRESHOLD);
}
