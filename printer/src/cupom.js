// Monta o buffer ESC/POS do cupom (64 colunas, Fonte B), no mesmo
// layout usado pelo Caixa Livre.
//
// Cupom fiscal (NFC-e) só é impresso quando `fiscal` é passado com os
// dados reais da emissão (número da NFC-e, protocolo de autorização e
// o conteúdo do QR Code, que vêm do XML gerado pelo sistema fiscal no
// fechamento da venda). Sem isso, o cupom sai como "NAO FISCAL" — não
// dá pra fingir uma emissão fiscal sem os dados reais por trás.
import { CMD, COLS, t, padRight, padLeft, center, moneyBR } from './escpos.js';
import { imageToGSv0, composeHeader, composeQrFooter } from './image.js';

// larguras fixas da tabela de itens (soma = 64)
const W = { n: 3, sep: 1, codigo: 7, descricao: 29, qt: 8, vlUn: 8, total: 8 };

function onlyDigits(s) {
  return String(s ?? '').replace(/\D/g, '');
}
function formatCNPJ(v) {
  const d = onlyDigits(v).padStart(14, '0');
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}
function formatCEP(v) {
  const d = onlyDigits(v).padStart(8, '0');
  return `${d.slice(0, 5)}-${d.slice(5)}`;
}
function formatCPF(v) {
  const d = onlyDigits(v);
  if (d.length !== 11) return d;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

// código do produto encurtado para as 6 posições da coluna CODIGO
// (o ERP usa códigos de até 14 dígitos, ex.: "00000000000002")
function shortCode(id) {
  const semZeros = String(id ?? '').replace(/^0+/, '') || '0';
  return semZeros.length > 6 ? semZeros.slice(-6) : semZeros.padStart(6, '0');
}

export function itemLine({ n, codigo, descricao, qt, vlUn, total }) {
  return (
    padLeft(n, W.n) +
    ' '.repeat(W.sep) +
    padRight(`${codigo} `, W.codigo) +
    padRight(descricao, W.descricao) +
    padLeft(qt, W.qt) +
    padLeft(vlUn, W.vlUn) +
    padLeft(total, W.total)
  );
}

export function headerLine() {
  return itemLine({ n: 'N', codigo: 'CODIGO', descricao: 'DESCRICAO', qt: 'QT', vlUn: 'VL UN', total: 'TOTAL' });
}

function formatQtd(qty, unidade) {
  return unidade === 'KG' ? `${Number(qty).toFixed(3).replace('.', ',')}KG` : `${Number(qty)}UN`;
}

/**
 * @param {object} p
 * @param {object} p.empresa - retorno de PegaDadosEmpresa
 * @param {Array}  p.itens   - linhas ativas da comanda (formato GravaItens)
 * @param {string} p.formaPagamento - ex.: "PIX", "Cartao de Credito"
 * @param {number} p.total
 * @param {string} [p.cpf]
 * @param {string|Buffer} [p.logoBase64] - logo da loja (data URL ou base64 puro)
 * @param {Date}   [p.dataHora]
 * @param {object} [p.fiscal] - dados reais da emissão NFC-e (vindos do
 *   XML gerado no fechamento da venda). Sem isso, o cupom sai NAO
 *   FISCAL — nunca inventamos QR/protocolo.
 * @param {string} [p.fiscal.numeroNfce]
 * @param {string} [p.fiscal.protocolo] - protocolo de autorização
 * @param {string} [p.fiscal.qrCodeConteudo] - conteúdo/URL do QR Code da NFC-e
 */
export async function buildCupom({
  empresa, itens, formaPagamento, total, cpf, logoBase64, dataHora = new Date(), fiscal,
}) {
  const chunks = [CMD.INIT, CMD.FONT_B, CMD.LINE_SPACING_TIGHT];
  const nome = empresa?.['Nome Fantasia'] || empresa?.['Razao Social'] || '';
  const endereco = [empresa?.Rua, empresa?.Numero].filter(Boolean).join(' ');
  const bairroCidade = [empresa?.Bairro, [empresa?.Cidade, empresa?.UF].filter(Boolean).join('/')]
    .filter(Boolean).join(' - ');
  const dt = dataHora.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  // Cabeçalho: no cupom fiscal com logo, monta logo à esquerda + dados
  // da empresa à direita como uma única imagem (ESC/POS não posiciona
  // texto ao lado de bitmap nativamente). Sem dados fiscais, ou sem
  // logo, mantém o cabeçalho de texto simples e centralizado de sempre.
  let cabecalhoComposto = null;
  if (fiscal && logoBase64) {
    const linhas = [{ text: nome, size: 'title' }];
    if (endereco) linhas.push({ text: endereco, size: 'small' });
    if (bairroCidade) linhas.push({ text: bairroCidade, size: 'small' });
    if (empresa?.CNPJ) linhas.push({ text: `CNPJ: ${formatCNPJ(empresa.CNPJ)}`, size: 'small' });
    if (empresa?.Cep) linhas.push({ text: `CEP.: ${formatCEP(empresa.Cep)}`, size: 'small' });
    if (empresa?.Telefone) linhas.push({ text: `TEL.: ${empresa.Telefone}`, size: 'small' });
    if (empresa?.IE) linhas.push({ text: `IE..: ${empresa.IE}`, size: 'small' });
    try {
      cabecalhoComposto = await composeHeader({ logoBase64, lines: linhas });
    } catch (err) {
      console.error('Falha ao montar cabecalho com logo, usando texto simples:', err.message);
    }
  }

  chunks.push(CMD.ALIGN_CENTER);
  if (cabecalhoComposto) {
    chunks.push(cabecalhoComposto, t(''));
  } else {
    // logo centralizada (opcional): falha ao converter não derruba o
    // cupom inteiro — só imprime sem a logo.
    if (logoBase64) {
      try {
        chunks.push(await imageToGSv0(logoBase64));
        chunks.push(t(''));
      } catch (err) {
        console.error('Falha ao converter a logo, imprimindo sem ela:', err.message);
      }
    }
    chunks.push(CMD.BOLD_ON, t(nome), CMD.BOLD_OFF);
    if (endereco) chunks.push(t(endereco));
    if (bairroCidade) chunks.push(t(bairroCidade));
    if (empresa?.CNPJ) chunks.push(t(`CNPJ: ${formatCNPJ(empresa.CNPJ)}`));
    if (empresa?.Cep) chunks.push(t(`CEP.: ${formatCEP(empresa.Cep)}`));
    if (empresa?.Telefone) chunks.push(t(`TEL.: ${empresa.Telefone}`));
    if (empresa?.IE) chunks.push(t(`IE..: ${empresa.IE}`));
  }
  chunks.push(t(''));
  if (fiscal) {
    chunks.push(CMD.BOLD_ON, t('CUPOM FISCAL ELETRONICO - NFC-e'), CMD.BOLD_OFF);
  } else {
    chunks.push(CMD.BOLD_ON, t('CUPOM NAO FISCAL'), t('COMPROVANTE DE COMPRA'), CMD.BOLD_OFF);
  }
  chunks.push(t(''));

  // itens
  chunks.push(CMD.ALIGN_LEFT, CMD.BOLD_ON, t(headerLine()), CMD.BOLD_OFF);
  itens.forEach((it, i) => {
    const isKg = String(it.unidade).toUpperCase() === 'KG';
    chunks.push(t(itemLine({
      n: i + 1,
      codigo: shortCode(it.id),
      descricao: (it.name || it.description || '').trim(),
      qt: formatQtd(it.amount, isKg ? 'KG' : 'UN'),
      vlUn: moneyBR(it.unit_price),
      total: moneyBR(it.total_price),
    })));
  });

  chunks.push(t('-'.repeat(COLS)));
  chunks.push(CMD.BOLD_ON);
  chunks.push(t(padRight('VALOR TOTAL R$', COLS - W.total) + padLeft(moneyBR(total), W.total)));
  chunks.push(CMD.BOLD_OFF);

  // pagamento
  chunks.push(t(''));
  chunks.push(t(padRight('FORMA DE PAGAMENTO', COLS - 10) + padLeft('VALOR PAGO', 10)));
  chunks.push(t(padRight(formaPagamento || '-', COLS - 10) + padLeft(moneyBR(total), 10)));
  if (cpf) {
    chunks.push(t(''), CMD.ALIGN_CENTER, t(`CPF: ${formatCPF(cpf)}`), CMD.ALIGN_LEFT);
  } else if (fiscal) {
    chunks.push(t(''), CMD.ALIGN_CENTER, t('CONSUMIDOR NAO IDENTIFICADO'), CMD.ALIGN_LEFT);
  }

  // rodapé fiscal: QR Code à esquerda, NFC-e/protocolo/data à direita,
  // como uma única imagem (mesmo motivo do cabeçalho). Sem QR real,
  // não imprime nada aqui — cai no rodapé simples de data/hora abaixo.
  let rodapeComposto = null;
  if (fiscal?.qrCodeConteudo) {
    const linhas = [];
    // NFC-e em destaque (título, o maior tamanho que ainda cabe na
    // coluna sem quebrar linha); os demais dados, dobrados em relação
    // ao rodapé original.
    if (fiscal.numeroNfce) linhas.push({ text: `NFC-e: ${fiscal.numeroNfce}`, size: 'title' });
    linhas.push({ text: 'Protocolo de autorizacao:', size: 'medium' });
    if (fiscal.protocolo) linhas.push({ text: String(fiscal.protocolo), size: 'medium' });
    linhas.push({ text: dt, size: 'medium' });
    try {
      rodapeComposto = await composeQrFooter({ qrContent: fiscal.qrCodeConteudo, lines: linhas });
    } catch (err) {
      console.error('Falha ao montar QR fiscal, cupom sai sem ele:', err.message);
    }
  }

  chunks.push(t(''));
  chunks.push(CMD.ALIGN_CENTER);
  if (rodapeComposto) {
    chunks.push(rodapeComposto);
  } else {
    chunks.push(t(dt));
  }

  chunks.push(CMD.LINE_SPACING_DEFAULT, CMD.FEED_3, CMD.CUT);
  return Buffer.concat(chunks);
}

// Página de teste: confirma que a rede encontra a impressora, sem
// depender de dados de empresa/comanda (usada pelo botão "Imprimir
// página de teste" nas configurações do app). Inclui a logo, se
// configurada, pra dar pra validar o upload sem precisar fechar uma
// venda de verdade.
export async function buildPaginaTeste({ printerPath, logoBase64, dataHora = new Date() } = {}) {
  const dt = dataHora.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const chunks = [CMD.INIT, CMD.FONT_B, CMD.LINE_SPACING_TIGHT, CMD.ALIGN_CENTER];
  if (logoBase64) {
    try {
      chunks.push(await imageToGSv0(logoBase64));
      chunks.push(t(''));
    } catch (err) {
      console.error('Falha ao converter a logo, imprimindo sem ela:', err.message);
    }
  }
  chunks.push(CMD.BOLD_ON, t('TESTE DE IMPRESSAO'), CMD.BOLD_OFF);
  chunks.push(t('MarketMe'));
  chunks.push(t('-'.repeat(COLS)));
  if (printerPath) chunks.push(t(printerPath));
  chunks.push(t(dt));
  chunks.push(t('-'.repeat(COLS)));
  chunks.push(t('Se voce esta lendo isto,'));
  chunks.push(t('a impressora esta configurada.'));
  chunks.push(CMD.LINE_SPACING_DEFAULT, CMD.FEED_3, CMD.CUT);
  return Buffer.concat(chunks);
}
