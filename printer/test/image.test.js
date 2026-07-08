import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Jimp } from 'jimp';
import { imageToGSv0 } from '../src/image.js';

// Gera um PNG sintético 8x2: linha de cima toda preta, linha de baixo
// toda branca — dá pra prever exatamente os bytes empacotados.
async function pngPretoBranco() {
  const img = new Jimp({ width: 8, height: 2, color: 0xffffffff });
  for (let x = 0; x < 8; x++) img.setPixelColor(0x000000ff, x, 0);
  return img.getBuffer('image/png');
}

test('imageToGSv0 gera o cabeçalho GS v 0 correto para 8x2 dots', async () => {
  const png = await pngPretoBranco();
  const buf = await imageToGSv0(png, { maxWidth: 8 });
  // GS v 0 m xL xH yL yH — 1 byte por linha (8 dots / 8), 2 linhas
  assert.deepEqual(
    [...buf.subarray(0, 8)],
    [0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 0x02, 0x00],
  );
});

test('imageToGSv0 empacota linha preta como 0xFF e branca como 0x00', async () => {
  const png = await pngPretoBranco();
  const buf = await imageToGSv0(png, { maxWidth: 8, threshold: 150 });
  const raster = buf.subarray(8); // após o cabeçalho de 8 bytes
  assert.equal(raster.length, 2); // 1 byte/linha × 2 linhas
  assert.equal(raster[0], 0xff); // linha de cima: toda preta
  assert.equal(raster[1], 0x00); // linha de baixo: toda branca
});

test('imageToGSv0 respeita maxWidth (redimensiona mantendo proporção)', async () => {
  const img = new Jimp({ width: 800, height: 400, color: 0x000000ff });
  const png = await img.getBuffer('image/png');
  const buf = await imageToGSv0(png, { maxWidth: 384 });
  const bytesPerRow = buf[4] | (buf[5] << 8);
  assert.equal(bytesPerRow, Math.ceil(384 / 8));
});

test('imageToGSv0 aceita data URL (data:image/png;base64,...)', async () => {
  const png = await pngPretoBranco();
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  const buf = await imageToGSv0(dataUrl, { maxWidth: 8 });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf[0], 0x1d);
});

test('imageToGSv0 rejeita entrada que não é imagem', async () => {
  await assert.rejects(() => imageToGSv0(Buffer.from('nao e imagem'), { maxWidth: 8 }));
});
