// Mock do servidor DataSnap (Server ZF / TSM) para desenvolvimento e
// testes do app sem o servidor real. Imita os endpoints e formatos:
//   node scripts/mock-tsm.js   → http://localhost:8125
import express from 'express';

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'content-type,authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Autenticação básica como no Server ZF real (token/senha do .ini).
// Defina MOCK_USER/MOCK_PASS para exigir; sem eles, aceita tudo.
const AUTH_USER = process.env.MOCK_USER ?? '';
const AUTH_PASS = process.env.MOCK_PASS ?? '';
app.use((req, res, next) => {
  if (!AUTH_USER) return next();
  const expected =
    'Basic ' + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');
  if (req.get('authorization') === expected) return next();
  res.status(401).json({ error: 'unauthorized' });
});

// estado do PDV
const state = {
  caixaAberto: false,
  contas: new Map(), // barcode -> [linhas]
  nextBarcode: 24,
  nextContador: {},
};

const PRODUTOS = {
  1: { cod_pro: '00000000000001', ds_pro: 'PRODUTO UM', formato_pro: '1', fl_ativo: '1', un_pro: 'KG', vl_venda: '6,90' },
  2: { cod_pro: '00000000000002', ds_pro: 'PRODUTO DOIS', formato_pro: '1', fl_ativo: '1', un_pro: 'UN', vl_venda: '20,00' },
  7894900011517: { cod_pro: '00007894900011517'.slice(-14), ds_pro: 'REFRIGERANTE COCA-COLA LATA 350ML', formato_pro: '1', fl_ativo: '1', un_pro: 'UN', vl_venda: '5,50' },
  7892840812850: { cod_pro: '00007892840812850'.slice(-14), ds_pro: 'SALGADINHO DORITOS 84G', formato_pro: '1', fl_ativo: '1', un_pro: 'UN', vl_venda: '9,90' },
};

const T = '/datasnap/rest/TSM';

app.get(`${T}/PegaDadosEmpresa`, (_req, res) => {
  res.json({
    CNPJ: '04548702000165', IE: '244880842117', Cidade: 'CAMPINAS', UF: 'SP',
    Rua: 'RUA ARNALDO BARRETO', Numero: '1050', Complemento: '', Bairro: 'SAO BERNARDO',
    Cep: '13030420', Telefone: '1932320292',
    'Nome Fantasia': 'NEWPOINTER', 'Razao Social': 'NEWPOINTER TECNOLOGIA LTDA',
  });
});

app.get(`${T}/ConsultaFormatoProduto/:cod`, (req, res) => {
  const p = PRODUTOS[Number(req.params.cod)];
  if (!p) return res.json({ cod_pro: '', ds_pro: '', fl_ativo: '0' });
  res.json(p);
});

app.post(`${T}/VerficaCXAberto`, (_req, res) => {
  res.json(
    state.caixaAberto
      ? { message_sucess: 'PDV (DEVELOP) Caixa Aberto!', sucess: true, id_sucess: 1 }
      : { message_sucess: 'PDV (DEVELOP) Operação Inválida! Este Caixa não está Aberto!', sucess: true, id_sucess: 0 },
  );
});

app.post(`${T}/AberturaCX`, (_req, res) => {
  state.caixaAberto = true;
  res.json({ message_sucess: 'PDV (DEVELOP) Caixa Aberto com Sucesso !', sucess: true, id_sucess: 0 });
});

app.post(`${T}/FechamentoCX`, (req, res) => {
  const nm = req.body?.nm_estacao ?? '?';
  if (!state.caixaAberto)
    return res.json({ message_sucess: `PDV (${nm}) Operação Inválida! Este Caixa não está Aberto!`, sucess: true, id_sucess: 0 });
  state.caixaAberto = false;
  res.json({ message_sucess: `PDV (${nm}) Caixa(${nm}) Fechado com Sucesso !`, sucess: true, id_sucess: 0 });
});

app.post(`${T}/GravaItens`, (req, res) => {
  const { cabecalho, consumo } = req.body ?? {};
  let barcode = (cabecalho?.ID || '').trim();
  if (!barcode) {
    barcode = String(state.nextBarcode++).padStart(6, '0');
    state.contas.set(barcode, []);
    state.nextContador[barcode] = 0;
  }
  const linhas = state.contas.get(barcode);
  if (!linhas) return res.status(400).json({ error: 'comanda não existe' });

  for (const c of consumo ?? []) {
    const qty = Number(c.Qtde_pro);
    const price = Number(c.Vl_Pro);
    const prod = Object.values(PRODUTOS).find((p) => p.cod_pro === c.Cod_pro);
    const name = prod ? prod.ds_pro : 'PRODUTO';
    const unidade = prod ? prod.un_pro : 'UN';
    if (qty < 0) {
      // estorno: remove linhas do produto até cobrir a quantidade
      let toRemove = -qty;
      for (let i = linhas.length - 1; i >= 0 && toRemove > 0; i--) {
        if (linhas[i].id === c.Cod_pro) {
          toRemove -= Number(linhas[i].amount);
          linhas.splice(i, 1);
        }
      }
      continue;
    }
    state.nextContador[barcode] += 1;
    linhas.push({
      name,
      total_price: Number((qty * price).toFixed(2)),
      id: c.Cod_pro,
      barcode,
      service: 0,
      amount: qty.toFixed(3),
      description: `${name}  `,
      unit_price: price,
      unidade,
      contador: String(state.nextContador[barcode]).padStart(4, '0'),
      pendente_de_confirmacao: '0',
    });
  }
  res.json(linhas);
});

// MOCK_FISCAL=1 simula uma resposta com os campos da NFC-e
// (nr_nfce, nr_protocolo_nfce, url_qrcode, chave_acesso_comanda) —
// útil pra testar o cupom fiscal fim a fim contra o mock, sem
// depender do Server ZF real ainda devolver isso.
app.post(`${T}/FechamentoComandaSmartPDV`, (req, res) => {
  const { barcode } = req.body ?? {};
  if (!state.contas.has(barcode))
    return res.json({ sucess: false, message_sucess: 'Comanda não encontrada' });
  state.contas.delete(barcode);
  const fiscal = process.env.MOCK_FISCAL === '1'
    ? {
      nr_nfce: '000123',
      nr_protocolo_nfce: '135260000000123',
      url_qrcode: 'https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode?chNFe=mock',
      chave_acesso_comanda: '35260700000000000000000000000000000000000000',
    }
    : {};
  res.json({ sucess: true, id_sucess: 0, message_sucess: 'Comanda Fechada com Sucesso !', ...fiscal });
});

app.post(`${T}/CancelarItem`, (req, res) => {
  const { nr_gerador, ordem_item } = req.body ?? {};
  const linhas = state.contas.get(nr_gerador);
  if (!linhas) return res.status(400).json({ error: 'conta não existe' });
  const idx = linhas.findIndex((l) => l.contador === ordem_item);
  if (idx >= 0) linhas.splice(idx, 1);
  res.json(linhas); // devolve os produtos ativos da conta
});

app.post(`${T}/CancelarConta`, (req, res) => {
  const { nr_gerador, nm_estacao } = req.body ?? {};
  if (!state.contas.has(nr_gerador))
    return res.json({ sucess: false, message_sucess: 'Conta não encontrada' });
  state.contas.delete(nr_gerador);
  res.json({ sucess: true, id_sucess: 0, message_sucess: `PDV (${nm_estacao}) Conta Cancelada com Sucesso !` });
});

app.post(`${T}/VerificaPermissaoUsuario`, (req, res) => {
  const { codigo, senha } = req.body ?? {};
  if (codigo === '0' && senha === '794613')
    return res.json({ Resultado: 'True', Mensagem: 'OK' });
  res.json({ Resultado: 'False', Mensagem: 'Usuário sem Permissão para esta Operação.' });
});

const port = Number(process.env.MOCK_PORT ?? 8125);
app.listen(port, () => console.log(`Mock TSM em http://localhost:${port}`));
