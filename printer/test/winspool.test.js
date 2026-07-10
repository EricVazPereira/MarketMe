import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawPrint } from '../src/winspool.js';

// Regressão: require_koffi() já teve um bug de TDZ (`const require`
// sombreando o `require` usado na mesma função, "Cannot access
// 'require' before initialization") que só aparecia em Windows de
// verdade — em dry-run/Linux o guard de plataforma nunca chegava a
// executar esse trecho. Aqui garantimos que o erro que sobe é sempre o
// aviso de plataforma, nunca um erro de sintaxe/inicialização do
// módulo em si.
test('rawPrint fora do Windows lança erro claro de plataforma (não erro de módulo)', () => {
  if (process.platform === 'win32') return; // roda de verdade só no CI/dev não-Windows
  assert.throws(
    () => rawPrint('\\\\eric\\cupom', Buffer.from('teste')),
    /WinSpool só está disponível no Windows/,
  );
});
