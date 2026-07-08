// Comandos ESC/POS e helpers de texto/coluna usados na montagem do cupom.
// Mesmos bytes usados pelo Caixa Livre, para o cupom sair no formato
// já conhecido em impressoras térmicas de 80mm / Fonte B (64 colunas).

export const CMD = {
  INIT: Buffer.from([0x1b, 0x40]),
  FONT_B: Buffer.from([0x1b, 0x4d, 0x01]),
  BOLD_ON: Buffer.from([0x1b, 0x45, 0x01]),
  BOLD_OFF: Buffer.from([0x1b, 0x45, 0x00]),
  ALIGN_LEFT: Buffer.from([0x1b, 0x61, 0x00]),
  ALIGN_CENTER: Buffer.from([0x1b, 0x61, 0x01]),
  FEED_3: Buffer.from([0x0a, 0x0a, 0x0a]),
  CUT: Buffer.from([0x1d, 0x56, 0x42, 0x03]),
  LINE_SPACING_TIGHT: Buffer.from([0x1b, 0x33, 46]),
  LINE_SPACING_DEFAULT: Buffer.from([0x1b, 0x32]),
};

export const COLS = 64;

// Remove acentos/diacríticos (a impressora só entende Latin-1 puro).
// U+0300–U+036F = bloco Unicode de "Combining Diacritical Marks", que é
// o que sobra de cada letra acentuada depois do normalize('NFD').
export function da(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Texto de uma linha, em Latin-1, com quebra de linha ao final
export function t(s) {
  return Buffer.from(da(String(s)) + '\n', 'latin1');
}

// Corta ou completa uma string para caber exatamente em `n` colunas
export function padRight(s, n) {
  const clean = da(String(s ?? ''));
  return clean.length >= n ? clean.slice(0, n) : clean.padEnd(n, ' ');
}
export function padLeft(s, n) {
  const clean = da(String(s ?? ''));
  return clean.length >= n ? clean.slice(-n) : clean.padStart(n, ' ');
}
export const center = (s, width = COLS) => {
  const clean = da(String(s ?? ''));
  if (clean.length >= width) return clean.slice(0, width);
  const pad = width - clean.length;
  const left = Math.floor(pad / 2);
  return ' '.repeat(left) + clean + ' '.repeat(pad - left);
};

// Formato monetário brasileiro: 9.999,99
export function moneyBR(v) {
  return Number(v ?? 0).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// QR code nativo do ESC/POS (modelo 2, sem precisar gerar bitmap)
export function qrEscPos(data, moduleSize = 5) {
  const bytes = Buffer.from(String(data), 'ascii');
  const storeLen = bytes.length + 3;
  const pL = storeLen & 0xff;
  const pH = (storeLen >> 8) & 0xff;
  const GS = 0x1d;
  return Buffer.concat([
    Buffer.from([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]), // modelo 2
    Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, moduleSize]), // tamanho do módulo
    Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]), // correção de erro M
    Buffer.from([GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30]), // armazena dados
    bytes,
    Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]), // imprime o QR
  ]);
}
