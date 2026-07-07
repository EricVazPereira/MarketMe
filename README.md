# MarketMe

PDV de autoatendimento (scan & pay) para tablet Android, integrado ao
**servidor de API do ERP** (Server ZF / DataSnap). Pesquisa de mercado
que embasa o produto: [`PESQUISA_MERCADO_AUTONOMO.md`](./PESQUISA_MERCADO_AUTONOMO.md).

## Arquitetura (fase atual — API DataSnap)

```
Tablet (APK MarketMe)
   │  HTTP na rede local
   ▼
Servidor de API do ERP (Server ZF, ex.: http://192.168.0.18:81)
   └─ /datasnap/rest/TSM/…  → banco do ERP (configurado no .ini do servidor)
```

O app fala **direto com a API** — configura-se apenas o endereço base
nas configurações do app; o caminho `/datasnap/rest/TSM/...` é
completado automaticamente. O banco de dados e a autenticação ficam no
`.ini` do próprio Server ZF (nada disso fica no tablet).

## Fluxo do PDV (como o app funciona)

1. **Configurações** (engrenagem): endereço da API (ex.:
   `http://192.168.0.18:81`), nome da estação (`nm_estacao`) e opção de
   balança. "Testar conexão" mostra o **Nome Fantasia** da empresa
   (`PegaDadosEmpresa`).
2. Ao entrar, o app **verifica o caixa** (`VerficaCXAberto`):
   - aberto → tela **"Toque para iniciar"**;
   - fechado → botão **"Abrir caixa"** (`AberturaCX`, operador 0).
3. Na tela inicial há **botões escondidos**: segure o dedo ~1s no canto
   superior direito para revelar **Fechar caixa** e **Sair**.
   - Fechar caixa → tela "Fechar caixa?" com [Voltar] e
     [Sim, fechar o caixa] (`FechamentoCX`) → volta à abertura de caixa.
   - Sair → encerra o aplicativo.
4. **Passar produtos**: câmera, digitação ou leitor físico (modo
   teclado). Cada código é consultado em `ConsultaFormatoProduto/{cod}`
   — se `un_pro = KG` o app pede o peso (ou lê da etiqueta de balança) —
   e gravado via **`GravaItens`** com o preço do cadastro. O `barcode`
   devolvido na primeira gravação vira o `ID` do cabeçalho nas
   gravações seguintes (mesma comanda).
5. **Fechar conta**: CPF opcional → `FechamentoComandaSmartPDV`
   (subtotal/total/barcode/`operadora_smart_pdv = PIX|total|`).
6. **Cancelamentos** exigem autorização de operador via API de permissão:
   - cancelar item → `funcao: CANCEL_ITEM_CX_FUN` (estorno enviado como
     `GravaItens` com quantidade negativa);
   - cancelar conta → `funcao: CANCEL_CONTA_CX_FUN`.

## Endpoints usados (base configurável no app)

| Método | Rota (`/datasnap/rest/TSM/…`) | Uso no app |
|---|---|---|
| GET | `PegaDadosEmpresa` | Nome Fantasia na configuração/título |
| GET | `ConsultaFormatoProduto/{cod}` | Resolve produto no scan (UN/KG, preço) |
| POST | `GravaItens` | Grava cada produto passado (comanda) |
| POST | `FechamentoComandaSmartPDV` | Fecha a conta |
| POST | `VerficaCXAberto` | Decide entre iniciar e abrir caixa |
| POST | `AberturaCX` | Botão "Abrir caixa" |
| POST | `FechamentoCX` | Menu escondido → "Fechar caixa" |
| POST | `VerificaPermissao`* | Autoriza cancelamento de item/conta |

\* Nome do método configurado em `PERMISSAO_METODO` no topo de
`app/www/js/app.js` — ajuste se no seu servidor for outro.

## Desenvolvimento e testes

```bash
npm install
node scripts/mock-tsm.js   # mock do Server ZF em http://localhost:8125
# abra app/www/index.html apontando a API para http://127.0.0.1:8125
```

O mock (`scripts/mock-tsm.js`) imita todos os endpoints acima com o
mesmo formato de resposta (inclusive `vl_venda` com vírgula decimal e o
encadeamento `barcode → ID` do `GravaItens`).

O diretório `src/` contém o conector Node da fase anterior (acesso
direto Firebird + Pix próprio). Não é mais usado pelo app; fica como
referência (`npm test` continua validando-o).

## APK

APK pronto em [`app/releases/marketme-debug.apk`](./app/releases/marketme-debug.apk)
(build manual com aapt/dx/apksigner — sem Gradle; ver
`app/android/build.sh`). Recompilar exige Linux: `npm run build:apk`
dentro de `app/`.

## Leitor de código de barras no tablet

1. **Câmera do tablet** (já funciona) — zero custo; exige boa luz.
2. **Leitor Bluetooth "modo HID/teclado"** (~R$ 150-400) — pareia como
   teclado; o app captura a leitura na tela de produtos e também na
   tela "Toque para iniciar" (já abre a compra com o primeiro bip).
3. **Leitor USB com adaptador OTG** — idem, via cabo.

Nada precisa ser reconfigurado no app para as opções 2 e 3.
