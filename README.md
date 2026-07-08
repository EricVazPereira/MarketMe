# MarketMe

PDV de autoatendimento (scan & pay) para tablet Android, integrado ao
**servidor de API do ERP** (Server ZF / DataSnap). Pesquisa de mercado
que embasa o produto: [`PESQUISA_MERCADO_AUTONOMO.md`](./PESQUISA_MERCADO_AUTONOMO.md).

## Arquitetura (fase atual — API DataSnap)

```
Tablet (APK MarketMe)
   │  HTTP na rede local
   ├──────────────────────────────► Servidor de API do ERP (Server ZF)
   │                                  └─ /datasnap/rest/TSM/…
   │                                     (banco/autenticação no .ini do servidor)
   │
   └──────────────────────────────► Servidor de impressão (printer/)
                                       └─ roda no PC com a impressora
                                          (mesma máquina que enxerga \\eric\cupom)
```

O app fala **direto com a API** — configura-se apenas o endereço base
nas configurações do app; o caminho `/datasnap/rest/TSM/...` é
completado automaticamente. O banco de dados e a autenticação ficam no
`.ini` do próprio Server ZF (nada disso fica no tablet).

A impressão do cupom é feita por um **servidor separado** (pasta
`printer/`), porque o tablet Android não enxerga caminhos de rede do
Windows (`\\eric\cupom`) — só o PC consegue. Esse servidor roda nessa
mesma máquina e escreve direto no spooler de impressão (WinSpool via
FFI), sem depender do Server ZF. Se `printServer` não for configurado
no app, a impressão simplesmente não acontece (recurso opcional).

## Fluxo do PDV (como o app funciona)

1. **Configurações** (engrenagem): endereço da API (ex.:
   `http://192.168.0.18:81`), nome da estação (`nm_estacao`) e opção de
   balança. "Testar conexão" mostra o **Nome Fantasia** da empresa
   (`PegaDadosEmpresa`).
2. Ao entrar, o app **verifica o caixa** (`VerficaCXAberto`):
   - aberto → tela **"Toque para iniciar"**;
   - fechado → botão **"Abrir caixa"** (`AberturaCX`, operador 0).
3. **Engrenagem** (⚙, topo direito): pede código+senha do operador,
   valida em `VerificaPermissaoUsuario` (`CANCEL_CONTA_CX_FUN`) e abre
   **só as Configurações**. Segurar 2s em cima do **nome da loja**
   (tela inicial) revela **Fechar caixa** (`FechamentoCX` → volta à
   abertura) e **Sair do app**.
4. **Passar produtos**: digitação ou leitor físico de código de barras
   (modo teclado — o leitor "digita" o código e um Enter; funciona no
   campo da tela de operação). Sem câmera/scanner por software: a loja
   usa um leitor físico dedicado. Cada código é
   consultado em `ConsultaFormatoProduto/{cod}` — se `un_pro = KG` o
   app pede o peso (ou lê da etiqueta de balança) — e gravado via
   **`GravaItens`** com o preço do cadastro. O `barcode` devolvido na
   primeira gravação vira o `ID` do cabeçalho nas gravações seguintes
   (mesma comanda). 1 min de inatividade sem itens volta ao início; com
   itens, cancela o cupom (`CancelarConta`) e volta ao início.
5. **Fechar conta**: CPF opcional → `FechamentoComandaSmartPDV`
   (subtotal/total/barcode/`operadora_smart_pdv = PIX|total|`). Se
   houver servidor de impressão configurado, o cupom é impresso em
   seguida (ver seção **Impressão do cupom** abaixo).
6. **Cancelamentos**:
   - cancelar item (✕ na linha) → permissão silenciosa
     (`CANCEL_ITEM_CX_FUN`, código/senha fixos) + `CancelarItem
     {nr_gerador, ordem_item}`; a linha cancelada some da comanda mas
     permanece visível na lista, em vermelho e riscada;
   - cancelar conta → confirmação na tela + permissão
     (`CANCEL_CONTA_CX_FUN`) + `CancelarConta {nr_gerador, nm_estacao,
     valor_conta, valor_acrescimo}`.

## Impressão do cupom

Servidor separado em [`printer/`](./printer), pensado para rodar **no
mesmo PC Windows que enxerga a impressora** (o mesmo caminho `\\eric\
cupom` que você usaria no Explorer). Formato do cupom espelha o do
Caixa Livre: 64 colunas, Fonte B, ESC/POS puro, impressão RAW via
WinSpool (sem passar por driver/PowerShell a cada cupom).

**Cupom não-fiscal por enquanto** — sem QR code nem protocolo de
autorização NFC-e, porque o MarketMe ainda não emite nota fiscal
eletrônica (isso depende de integração com SAT/SEFAZ, fase futura).
Imprimir uma seção "CUPOM FISCAL ELETRONICO" sem uma emissão fiscal de
verdade por trás seria enganoso, então o cabeçalho diz **"CUPOM NAO
FISCAL — COMPROVANTE DE COMPRA"**. A função `qrEscPos()` já existe em
`printer/src/escpos.js`, pronta para quando a emissão fiscal entrar.

### Rodando o servidor de impressão

```bash
cd printer
npm install
npm start                    # produção: precisa ser Windows (usa WinSpool)
PRINT_DRY_RUN=1 npm start    # desenvolvimento: grava .prn em printer/dry-run/
                              # em vez de imprimir (funciona em qualquer SO)
```

Escuta na porta **8127** (fixa — `PRINT_PORT` no ambiente muda, mas o
app sempre assume 8127). O app **não tem campo separado para o
endereço do servidor de impressão**: ele deduz automaticamente o
mesmo host configurado em "Endereço da API", na porta 8127 — ou seja,
o serviço `printer/` precisa rodar **na mesma máquina** (mesmo IP) do
Server ZF. No app, em Configurações, preencha:

- **Impressora**: o caminho/nome usado pelo Windows (`\\eric\cupom`)
  — **deixe vazio para não imprimir**;
- **Logo da loja**: escolha uma imagem (até 512KB) — é convertida em
  bitmap e impressa centralizada no topo do cupom, acima do nome/
  endereço da empresa. Fica salva no tablet; "Remover logo" tira do
  cupom sem precisar reconfigurar o resto.

Se o cupom fechar mas não sair na impressora, o app mostra um aviso
("⚠️ Cupom não impresso: …") — normalmente porque o serviço
`printer/` não está rodando naquele PC/porta, ou o Windows não
reconhece o caminho preenchido em Impressora. A venda **não é
desfeita** nesse caso.

Use o botão **"Testar impressora"** (em Configurações, logo abaixo do
campo Impressora) para checar a conexão sem precisar fechar uma venda
de verdade — ele chama `GET /health` no endereço deduzido e mostra se
respondeu ou não. Erro **"Failed to fetch" / "não respondeu"** quase
sempre significa que o `npm start` de `printer/` não está rodando
nesse momento naquele PC — ele precisa ficar de pé o tempo todo (por
exemplo, como tarefa agendada/serviço do Windows), não só durante o
teste.

### Como funciona

1. Depois que `FechamentoComandaSmartPDV` confirma o fechamento, o app
   chama `POST /imprimir` no servidor de impressão com os itens da
   comanda, os dados da empresa (guardados de `PegaDadosEmpresa` ao
   testar a conexão), a logo (se configurada), forma de pagamento,
   total e CPF.
2. `printer/src/cupom.js` monta o buffer ESC/POS (`buildCupom`); se
   houver logo, `printer/src/image.js` (via `Jimp`, puro JS) redimensiona
   e binariza a imagem e a empacota no comando de bitmap `GS v 0` antes
   do cabeçalho de texto. Logo inválida/corrompida não derruba o cupom
   — ele sai sem a imagem.
3. `printer/src/winspool.js` manda os bytes pro spooler
   (`OpenPrinterW`/`WritePrinter` via `koffi`, biblioteca FFI —
   mesmo mecanismo do Caixa Livre).
4. Falha na impressão **nunca desfaz a venda**: só mostra um aviso no
   tablet para o operador conferir a impressora.

```bash
cd printer && npm test   # valida o layout do cupom (64 colunas, bytes
                          # ESC/POS, formatação de valores/CPF/CNPJ)
```

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

O app não usa mais a câmera para escanear — passa a depender de um
**leitor físico** (mais rápido e confiável que a câmera num PDV):

1. **Leitor Bluetooth "modo HID/teclado"** (~R$ 150-400) — pareia como
   teclado; o app captura a leitura na tela de produtos e também na
   tela "Toque para iniciar" (já abre a compra com o primeiro bip).
2. **Leitor USB com adaptador OTG** — idem, via cabo.

Também dá pra digitar o código manualmente no campo da tela de
operação, útil para produtos com código de barras ilegível.
