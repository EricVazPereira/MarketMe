import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Jimp } from 'jimp';
import { da, t, padRight, padLeft, center, moneyBR, qrEscPos, COLS } from '../src/escpos.js';
import { buildCupom, buildPaginaTeste, itemLine, headerLine } from '../src/cupom.js';

test('da() remove acentos e diacríticos', () => {
  assert.equal(da('café com açúcar e pão'), 'cafe com acucar e pao');
  assert.equal(da('MAÇÃ'), 'MACA');
});

test('t() codifica em latin1 com quebra de linha', () => {
  const buf = t('café');
  assert.equal(buf.toString('latin1'), 'cafe\n');
});

test('padRight/padLeft/center respeitam a largura exata', () => {
  assert.equal(padRight('MACA FUGI', 29).length, 29);
  assert.equal(padLeft('1,5KG', 8).length, 8);
  assert.equal(center('X', 64).length, 64);
  // corta quando maior que a largura
  assert.equal(padRight('DESCRICAO MUITO MUITO MUITO LONGA DEMAIS', 29).length, 29);
});

test('moneyBR formata como 9.999,99', () => {
  assert.equal(moneyBR(8.98), '8,98');
  assert.equal(moneyBR(1234.5), '1.234,50');
  assert.equal(moneyBR(0), '0,00');
});

test('qrEscPos gera os blocos de comando GS ( k esperados', () => {
  const buf = qrEscPos('12345');
  // 5 comandos GS(k + os 5 bytes de dados ascii "12345"
  assert.ok(buf.includes(Buffer.from([0x1d, 0x28, 0x6b])));
  assert.ok(buf.includes(Buffer.from('12345', 'ascii')));
});

const EMPRESA = {
  CNPJ: '04548702000165', IE: '244880842117', Cidade: 'CAMPINAS', UF: 'SP',
  Rua: 'RUA ARNALDO BARRETO', Numero: '1050', Bairro: 'SAO BERNARDO',
  Cep: '13030420', Telefone: '1932320292',
  'Nome Fantasia': 'NEWPOINTER', 'Razao Social': 'NEWPOINTER TECNOLOGIA LTDA',
};

const ITENS = [
  { id: '00000000000001', name: 'MACA FUGI', amount: '1.500', unit_price: 5.99, total_price: 8.98, unidade: 'KG' },
  { id: '00000000000002', name: 'REFRIGERANTE LATA', amount: '2', unit_price: 4.5, total_price: 9.0, unidade: 'UN' },
];

test('buildCupom monta um Buffer com os comandos ESC/POS essenciais', async () => {
  const buf = await buildCupom({ empresa: EMPRESA, itens: ITENS, formaPagamento: 'Cartao de Credito', total: 17.98, cpf: '12345678900' });
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.includes(Buffer.from([0x1b, 0x40]))); // INIT
  assert.ok(buf.includes(Buffer.from([0x1b, 0x4d, 0x01]))); // FONT_B
  assert.ok(buf.includes(Buffer.from([0x1d, 0x56, 0x42, 0x03]))); // CUT
  const texto = buf.toString('latin1');
  assert.ok(texto.includes('NEWPOINTER'));
  assert.ok(texto.includes('CUPOM NAO FISCAL'));
  assert.ok(texto.includes('MACA FUGI'));
  assert.ok(texto.includes('8,98'));
  assert.ok(texto.includes('17,98'));
  assert.ok(texto.includes('123.456.789-00')); // CPF formatado
  // não deve conter menção a fiscal eletrônico/NFC-e (ainda não emitimos)
  assert.ok(!texto.includes('NFC-e'));
});

// Largura testada na função que MONTA o texto da linha, não no fluxo
// de bytes final — comandos ESC/POS multi-byte usam letras ASCII como
// seletor (ex.: ESC 'a' = alinhar, ESC 'E' = negrito) e ficam
// grudados no início da linha de texto seguinte no stream bruto,
// então dividir por '\n' e medir ali não é confiável.
test('itemLine() e headerLine() têm exatamente 64 colunas', () => {
  assert.equal(headerLine().length, COLS);
  assert.equal(
    itemLine({ n: 1, codigo: '000001', descricao: 'MACA FUGI', qt: '1,500KG', vlUn: '5,99', total: '8,98' }).length,
    COLS,
  );
  // descrição maior que 29 colunas é cortada, não estoura a linha
  assert.equal(
    itemLine({ n: 1, codigo: '000001', descricao: 'DESCRICAO MUITO MUITO MUITO LONGA DEMAIS', qt: '1UN', vlUn: '1,00', total: '1,00' }).length,
    COLS,
  );
});

test('formata quantidade em kg com 3 casas e unidade em UN sem decimais', async () => {
  const buf = await buildCupom({ empresa: EMPRESA, itens: ITENS, formaPagamento: 'PIX', total: 17.98 });
  const texto = buf.toString('latin1');
  assert.ok(texto.includes('1,500KG'));
  assert.ok(texto.includes('2UN'));
});

test('CPF ausente não aparece no cupom', async () => {
  const buf = await buildCupom({ empresa: EMPRESA, itens: ITENS, formaPagamento: 'PIX', total: 17.98 });
  assert.ok(!buf.toString('latin1').includes('CPF:'));
});

test('logo ausente não altera o cupom (comportamento atual, sem regressão)', async () => {
  const buf = await buildCupom({ empresa: EMPRESA, itens: ITENS, formaPagamento: 'PIX', total: 17.98 });
  assert.ok(!buf.includes(Buffer.from([0x1d, 0x76, 0x30]))); // sem comando GS v 0
});

test('logo inválida não derruba o cupom — imprime sem ela', async () => {
  const buf = await buildCupom({
    empresa: EMPRESA, itens: ITENS, formaPagamento: 'PIX', total: 17.98,
    logoBase64: 'isso-nao-e-uma-imagem-valida',
  });
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.toString('latin1').includes('NEWPOINTER'));
});

async function logoTeste() {
  const png = await new Jimp({ width: 40, height: 40, color: 0x000000ff }).getBuffer('image/png');
  return `data:image/png;base64,${png.toString('base64')}`;
}

// Cabeçalho e rodapé fiscais (lado a lado) são renderizados como
// bitmap (GS v 0) — o texto vira pixel, não sobra como bytes ASCII no
// buffer. Então a única forma confiável de verificar que cada bloco
// foi montado é contar quantos comandos GS v 0 existem no cupom.
function contarGSv0(buf) {
  const comando = Buffer.from([0x1d, 0x76, 0x30]);
  let count = 0;
  let idx = 0;
  while ((idx = buf.indexOf(comando, idx)) !== -1) { count++; idx += 1; }
  return count;
}

const FISCAL = {
  numeroNfce: '001242',
  protocolo: '135264431671342',
  qrCodeConteudo: 'https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode?chNFe=exemplo',
};

test('sem `fiscal`, cupom continua NAO FISCAL (sem regressão)', async () => {
  const buf = await buildCupom({ empresa: EMPRESA, itens: ITENS, formaPagamento: 'PIX', total: 17.98 });
  const texto = buf.toString('latin1');
  assert.ok(texto.includes('CUPOM NAO FISCAL'));
  assert.ok(!texto.includes('NFC-e'));
  assert.ok(!texto.includes('CONSUMIDOR NAO IDENTIFICADO'));
});

test('com `fiscal` + logo, monta cabeçalho e rodapé compostos (lado a lado)', async () => {
  const buf = await buildCupom({
    empresa: EMPRESA, itens: ITENS, formaPagamento: 'PIX', total: 17.98,
    logoBase64: await logoTeste(), fiscal: FISCAL,
  });
  const texto = buf.toString('latin1');
  assert.ok(texto.includes('CUPOM FISCAL ELETRONICO - NFC-e'));
  assert.ok(!texto.includes('CUPOM NAO FISCAL'));
  assert.ok(texto.includes('CONSUMIDOR NAO IDENTIFICADO')); // sem CPF informado
  // dois blocos GS v 0 compostos: cabeçalho (logo+empresa) e rodapé (QR+dados)
  assert.equal(contarGSv0(buf), 2);
});

test('com `fiscal` + CPF, mostra o CPF em vez de "consumidor não identificado"', async () => {
  const buf = await buildCupom({
    empresa: EMPRESA, itens: ITENS, formaPagamento: 'PIX', total: 17.98,
    logoBase64: await logoTeste(), fiscal: FISCAL, cpf: '12345678900',
  });
  const texto = buf.toString('latin1');
  assert.ok(texto.includes('123.456.789-00'));
  assert.ok(!texto.includes('CONSUMIDOR NAO IDENTIFICADO'));
});

test('com `fiscal` mas sem logo, cai no cabeçalho de texto simples (ainda fiscal)', async () => {
  const buf = await buildCupom({
    empresa: EMPRESA, itens: ITENS, formaPagamento: 'PIX', total: 17.98, fiscal: FISCAL,
  });
  const texto = buf.toString('latin1');
  assert.ok(texto.includes('CUPOM FISCAL ELETRONICO - NFC-e'));
  assert.ok(texto.includes('NEWPOINTER')); // cabeçalho de texto simples, sem logo
  assert.equal(contarGSv0(buf), 1); // só o rodapé com QR (sem logo não há cabeçalho composto)
});

test('com `fiscal` mas sem qrCodeConteudo, não imprime rodapé de QR', async () => {
  const buf = await buildCupom({
    empresa: EMPRESA, itens: ITENS, formaPagamento: 'PIX', total: 17.98,
    logoBase64: await logoTeste(), fiscal: { numeroNfce: '001242' },
  });
  const texto = buf.toString('latin1');
  assert.ok(texto.includes('CUPOM FISCAL ELETRONICO - NFC-e'));
  assert.equal(contarGSv0(buf), 1); // só o cabeçalho (logo+empresa); sem QR não monta o rodapé
});

test('buildPaginaTeste monta uma página de teste com o caminho da impressora', async () => {
  const buf = await buildPaginaTeste({ printerPath: '\\\\eric\\cupom' });
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.includes(Buffer.from([0x1b, 0x40]))); // INIT
  assert.ok(buf.includes(Buffer.from([0x1d, 0x56, 0x42, 0x03]))); // CUT
  const texto = buf.toString('latin1');
  assert.ok(texto.includes('TESTE DE IMPRESSAO'));
  assert.ok(texto.includes('\\\\eric\\cupom'));
});

test('buildPaginaTeste funciona sem printerPath', async () => {
  const buf = await buildPaginaTeste();
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.toString('latin1').includes('TESTE DE IMPRESSAO'));
});

test('buildPaginaTeste inclui a logo quando configurada', async () => {
  const semLogo = await buildPaginaTeste({ printerPath: '\\\\eric\\cupom' });
  assert.ok(!semLogo.includes(Buffer.from([0x1d, 0x76, 0x30]))); // sem GS v 0

  const png = await new Jimp({ width: 8, height: 8, color: 0x000000ff }).getBuffer('image/png');
  const comLogo = await buildPaginaTeste({
    printerPath: '\\\\eric\\cupom',
    logoBase64: `data:image/png;base64,${png.toString('base64')}`,
  });
  assert.ok(comLogo.includes(Buffer.from([0x1d, 0x76, 0x30]))); // com GS v 0
});

test('buildPaginaTeste não quebra com logo inválida', async () => {
  const buf = await buildPaginaTeste({ printerPath: '\\\\eric\\cupom', logoBase64: 'nao-e-imagem' });
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.toString('latin1').includes('TESTE DE IMPRESSAO'));
});
