// Servidor de impressão do MarketMe. Roda no PC que enxerga a
// impressora (mesma máquina do compartilhamento, ex.: \\eric\cupom).
// O tablet chama POST /imprimir depois de fechar a conta.
//
// Modo dry-run (PRINT_DRY_RUN=1): em vez de mandar pro WinSpool, grava
// os bytes num arquivo .prn em ./dry-run/ — útil para testar o layout
// do cupom em qualquer SO, sem impressora nem Windows.
import { mkdir, writeFile } from 'node:fs/promises';
import express from 'express';
import { buildCupom, buildPaginaTeste } from './cupom.js';
import { rawPrint } from './winspool.js';

const PORT = Number(process.env.PRINT_PORT ?? 8127);
const DRY_RUN = process.env.PRINT_DRY_RUN === '1' || process.platform !== 'win32';
const DRY_RUN_DIR = new URL('../dry-run/', import.meta.url);

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, dryRun: DRY_RUN }));

async function enviarParaImpressora(res, printerPath, buffer, prefixo) {
  try {
    if (DRY_RUN) {
      await mkdir(DRY_RUN_DIR, { recursive: true });
      const file = new URL(`${prefixo}-${Date.now()}.prn`, DRY_RUN_DIR);
      await writeFile(file, buffer);
      console.log(`[dry-run] gravado em ${file.pathname}`);
      return res.json({ ok: true, dryRun: true, bytes: buffer.length });
    }
    const written = rawPrint(printerPath, buffer);
    res.json({ ok: true, dryRun: false, bytes: written });
  } catch (err) {
    console.error('Falha ao imprimir:', err.message);
    res.status(502).json({ error: `falha ao imprimir: ${err.message}` });
  }
}

app.post('/imprimir', async (req, res) => {
  const { printerPath, empresa, itens, formaPagamento, total, cpf, logoBase64, fiscal, fiscalDebug } = req.body ?? {};
  if (!printerPath) return res.status(400).json({ error: 'printerPath é obrigatório' });
  if (!Array.isArray(itens) || itens.length === 0)
    return res.status(400).json({ error: 'itens deve ser uma lista não vazia' });

  let buffer;
  try {
    buffer = await buildCupom({
      empresa, itens, formaPagamento, total, cpf, logoBase64, fiscal, fiscalDebug, dataHora: new Date(),
    });
  } catch (err) {
    return res.status(500).json({ error: `falha ao montar o cupom: ${err.message}` });
  }
  await enviarParaImpressora(res, printerPath, buffer, 'cupom');
});

// Imprime uma página de teste no caminho informado — usada pelo botão
// "Imprimir página de teste" das configurações do app, pra confirmar
// que a rede encontra a impressora sem precisar fechar uma venda.
app.post('/teste', async (req, res) => {
  const { printerPath, logoBase64 } = req.body ?? {};
  if (!printerPath) return res.status(400).json({ error: 'printerPath é obrigatório' });
  const buffer = await buildPaginaTeste({ printerPath, logoBase64, dataHora: new Date() });
  await enviarParaImpressora(res, printerPath, buffer, 'teste');
});

// Imprime um cupom FISCAL de exemplo (dados reais da empresa/logo, mas
// item e número/protocolo/QR de teste) — pra validar o layout na
// impressora de verdade antes da integração com os dados reais da
// NFC-e (número, protocolo e QR ainda dependem do XML gerado no
// fechamento da venda, que o app ainda não capta).
app.post('/teste-fiscal', async (req, res) => {
  const { printerPath, empresa, logoBase64 } = req.body ?? {};
  if (!printerPath) return res.status(400).json({ error: 'printerPath é obrigatório' });
  const buffer = await buildCupom({
    empresa,
    itens: [{ id: '904329', name: 'PRODUTO DE TESTE', amount: '1', unit_price: 1, total_price: 1, unidade: 'UN' }],
    formaPagamento: 'PIX',
    total: 1,
    logoBase64,
    fiscal: {
      numeroNfce: '000001',
      protocolo: '000000000000000',
      qrCodeConteudo: 'https://www.nfce.fazenda.sp.gov.br/qrcode?chNFe=teste-marketme',
    },
    dataHora: new Date(),
  });
  await enviarParaImpressora(res, printerPath, buffer, 'teste-fiscal');
});

app.listen(PORT, () => {
  console.log(`Servidor de impressão MarketMe em http://localhost:${PORT}${DRY_RUN ? ' (modo dry-run)' : ''}`);
});
