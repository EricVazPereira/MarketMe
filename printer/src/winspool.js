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
  // HANDLE como ponteiro opaco nomeado (padrão recomendado pelo koffi
  // para tipos tipo-HANDLE do Win32) — vira reutilizável por nome
  // ('HANDLE') nas assinaturas abaixo, igual ao struct 'DOC_INFO_1W'.
  koffi.pointer('HANDLE', koffi.opaque());
  koffi.struct('DOC_INFO_1W', {
    pDocName: 'str16', pOutputFile: 'str16', pDatatype: 'str16',
  });
  // _Out_ nos parâmetros de saída (phPrinter, pcWritten) é obrigatório
  // pro koffi marshalar de volta pro JS — sem isso ele tenta ler o
  // buffer como um valor de entrada e a chamada nativa falha com
  // "Invalid argument". __stdcall é a convenção de chamada do Win32.
  _OpenPrinterW = ws.func('bool __stdcall OpenPrinterW(str16 pPrinterName, _Out_ HANDLE *phPrinter, void *pDefault)');
  _ClosePrinter = ws.func('bool __stdcall ClosePrinter(HANDLE hPrinter)');
  _StartDocPrinterW = ws.func('int32 __stdcall StartDocPrinterW(HANDLE hPrinter, uint32 Level, DOC_INFO_1W *pDocInfo)');
  _EndDocPrinter = ws.func('bool __stdcall EndDocPrinter(HANDLE hPrinter)');
  _StartPagePrinter = ws.func('bool __stdcall StartPagePrinter(HANDLE hPrinter)');
  _EndPagePrinter = ws.func('bool __stdcall EndPagePrinter(HANDLE hPrinter)');
  _WritePrinter = ws.func('bool __stdcall WritePrinter(HANDLE hPrinter, uint8_t *pBuf, uint32 cbBuf, _Out_ uint32 *pcWritten)');
}

// printerName: nome da impressora no Windows, ou caminho de
// compartilhamento (ex.: \\eric\cupom) — o campo "Impressora" do app.
export function rawPrint(printerName, data) {
  ensureLoaded();
  const hOut = [null]; // saída de HANDLE* vem como array de 1 posição (padrão koffi)
  if (!_OpenPrinterW(printerName, hOut, null))
    throw new Error(`OpenPrinterW falhou para "${printerName}" — confira o nome/caminho da impressora`);
  const h = hOut[0];
  try {
    const doc = { pDocName: 'CupomMarketMe', pOutputFile: '', pDatatype: 'RAW' };
    _StartDocPrinterW(h, 1, doc);
    _StartPagePrinter(h);
    const wOut = [0];
    _WritePrinter(h, data, data.length, wOut);
    _EndPagePrinter(h);
    _EndDocPrinter(h);
    return wOut[0];
  } finally {
    _ClosePrinter(h);
  }
}
