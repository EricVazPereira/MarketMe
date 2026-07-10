// Ponte para o WinSpool do Windows via koffi (FFI), igual ao Caixa
// Livre: escreve bytes RAW direto no spooler, sem passar por
// PowerShell a cada impressão. Só funciona no Windows — em qualquer
// outro SO, rawPrint() lança um erro claro (o servidor pode rodar em
// modo dry-run para desenvolvimento/teste, ver server.js).
// koffi é CommonJS; import dinâmico compatível com ESM
import { createRequire } from 'node:module';
const requireCjs = createRequire(import.meta.url);
function require_koffi() {
  return requireCjs('koffi');
}

let ws = null;
let _OpenPrinterW, _ClosePrinter, _StartDocPrinterW, _EndDocPrinter;
let _StartPagePrinter, _EndPagePrinter, _WritePrinter;

function ensureLoaded() {
  if (ws) return;
  if (process.platform !== 'win32')
    throw new Error('WinSpool só está disponível no Windows (rode este servidor no PC com a impressora)');
  const koffi = require_koffi();
  ws = koffi.load('winspool.drv');
  // registra o struct pelo nome 'DOC_INFO_1W', usado como tipo por
  // string na assinatura da função abaixo (é assim que o koffi espera)
  koffi.struct('DOC_INFO_1W', {
    pDocName: 'str16', pOutputFile: 'str16', pDatatype: 'str16',
  });
  _OpenPrinterW = ws.func('bool OpenPrinterW(str16 pPrinterName, void** phPrinter, void* pDefault)');
  _ClosePrinter = ws.func('bool ClosePrinter(void* hPrinter)');
  _StartDocPrinterW = ws.func('int32 StartDocPrinterW(void* hPrinter, uint32 Level, DOC_INFO_1W* pDocInfo)');
  _EndDocPrinter = ws.func('bool EndDocPrinter(void* hPrinter)');
  _StartPagePrinter = ws.func('bool StartPagePrinter(void* hPrinter)');
  _EndPagePrinter = ws.func('bool EndPagePrinter(void* hPrinter)');
  _WritePrinter = ws.func('bool WritePrinter(void* hPrinter, uint8_t* pBuf, uint32 cbBuf, void* pcWritten)');
}

// printerName: nome da impressora no Windows, ou caminho de
// compartilhamento (ex.: \\eric\cupom) — o campo "Impressora" do app.
export function rawPrint(printerName, data) {
  ensureLoaded();
  const hBuf = Buffer.alloc(8);
  const koffi = require_koffi();
  if (!_OpenPrinterW(printerName, hBuf, koffi.as(0, 'void *')))
    throw new Error(`OpenPrinterW falhou para "${printerName}" — confira o nome/caminho da impressora`);
  const h = koffi.decode(hBuf, 'void *');
  try {
    const doc = { pDocName: 'CupomMarketMe', pOutputFile: '', pDatatype: 'RAW' };
    _StartDocPrinterW(h, 1, doc);
    _StartPagePrinter(h);
    const wBuf = Buffer.alloc(4);
    _WritePrinter(h, data, data.length, wBuf);
    _EndPagePrinter(h);
    _EndDocPrinter(h);
    return wBuf.readUInt32LE(0);
  } finally {
    _ClosePrinter(h);
  }
}
