# MarketMe

Mini-mercado autônomo (scan & pay) integrado ao **ERP existente**:
cadastros de empresa e produtos vêm do banco **Firebird** do ERP
(`orestra.fdb`), em acesso direto nesta fase. Pesquisa de mercado que
embasa o produto: [`PESQUISA_MERCADO_AUTONOMO.md`](./PESQUISA_MERCADO_AUTONOMO.md).

## Arquitetura (fase atual — Firebird direto)

```
Tablet (APK MarketMe)
   │  HTTP na rede local (envia o "diretório do banco" configurado no app)
   ▼
Conector no PC (Node)  ──►  Firebird do ERP (D:\marketme\bd\orestra.fdb)
   │                          • EMPRESA  → loja (Nome Fantasia)
   │                          • PRODUTO  → scan por código de barras + preço
   ▼
PostgreSQL local        ──►  pedidos, itens (snapshot), pagamentos Pix
```

- O tablet **não abre o .fdb sozinho** (o arquivo está no disco do PC);
  o conector é a ponte mínima até lá. Na próxima fase, o conector é
  substituído pelo **servidor de API** — o app já tem os campos de
  endereço/token/senha de API guardados (ainda sem uso).
- O estoque **não é movimentado** nesta fase: ele pertence ao ERP.
- Cada item vendido guarda **snapshot** de código, EAN, nome e preço do
  cadastro no momento do scan.

## O que o cliente consegue fazer no app

- Ver o catálogo (produtos com código de barras do cadastro do ERP)
- Escanear pela **câmera**, digitar o código ou usar **leitor físico**
  (Bluetooth/USB em modo teclado — o app captura a "rajada" + Enter)
- Produtos pesáveis: digitar o peso ou ler etiqueta de balança
  (modo balança nas configurações)
- **Cancelar item** do carrinho e **cancelar a conta** (pedido inteiro,
  inclusive na tela do Pix — a cobrança pendente é cancelada junto)
- Pagar com **Pix copia-e-cola** e ver a confirmação na tela

## Como rodar (no PC com o Firebird)

```bash
npm install

# PostgreSQL local (pedidos): cria usuário/banco e grava o .env
npm run db:setup

# Ajuste o .env: caminho do Firebird e credenciais (POINTER/sysadmin)
#   FIREBIRD_DATABASE=D:\marketme\bd\orestra.fdb

npm start          # conector em http://localhost:3000
npm test           # requer PostgreSQL e um Firebird de teste
```

No app (tablet): Configurações → **diretório do banco de dados**
(`D:\marketme\bd\orestra.fdb`), **endereço do conector**
(`http://IP-DO-PC:3000`) → "Buscar empresa/loja" → salvar.

### Firebird 3.0+ (se o conector não conectar)

O driver Node usa o protocolo legado. No `firebird.conf` do servidor:

```
AuthServer = Srp256, Srp, Legacy_Auth
UserManager = Srp, Legacy_UserManager
WireCrypt = Disabled
```

Reinicie o serviço do Firebird e garanta que o usuário existe também no
plugin legado: `CREATE USER POINTER PASSWORD 'sysadmin' USING PLUGIN
Legacy_UserManager;`. **Firebird 2.5 funciona sem nenhum ajuste.**

### Mapeamento de tabelas do ERP

Padrões usados (ajuste no `.env` se os nomes forem outros):

| O quê | Tabela/campo padrão | Variável |
|---|---|---|
| Loja | `EMPRESA` | `FB_EMPRESA_TABLE` |
| Nome exibido | `NOME_FANTASIA` | `FB_EMPRESA_FANTASIA` |
| Código da empresa | `CODIGO` | `FB_EMPRESA_ID` |
| Produtos | `PRODUTO` | `FB_PRODUTO_TABLE` |
| Código de barras | `CODIGO_BARRA` | `FB_PRODUTO_EAN` |
| Descrição | `DESCRICAO` | `FB_PRODUTO_NOME` |
| Preço de venda | `PRECO_VENDA` | `FB_PRODUTO_PRECO` |

## Endpoints do conector

| Método | Rota | Fonte | Descrição |
|---|---|---|---|
| GET | `/stores` | Firebird | Empresas do ERP (Nome Fantasia) |
| GET | `/stores/:id/catalog` | Firebird | Produtos com código de barras |
| GET | `/stores/:id/products/ean/:ean` | Firebird | Resolve scan |
| GET | `/stores/:id/products/scale/:prefix` | Firebird | Etiqueta de balança |
| POST | `/orders` | PostgreSQL | Abre pedido (valida EMPRESA no ERP) |
| POST | `/orders/:id/items` | ambos | Scan → snapshot com preço do cadastro |
| DELETE | `/orders/:id/items/:productCode` | PostgreSQL | Cancela item |
| POST | `/orders/:id/cancel` | PostgreSQL | Cancela a conta/pedido |
| POST | `/orders/:id/pay` | PostgreSQL | Pix dinâmico (idempotente) |
| GET | `/orders/:id` | PostgreSQL | Status (polling do app) |
| POST | `/webhooks/psp` | PostgreSQL | Confirmação Pix (idempotente) |
| POST | `/customers` / `/customers/:id/close` | PostgreSQL | Cliente do app |
| GET | `/stores/:id/dashboard` | PostgreSQL | Vendas do app por período |

Todas as rotas aceitam o header `x-db-path` (o "diretório do banco" do
app) para apontar o Firebird; sem ele vale o `FIREBIRD_DATABASE` do `.env`.

## Leitor de código de barras no tablet

Três opções, da mais simples à mais robusta:

1. **Câmera do tablet** (já funciona) — zero custo; exige boa luz e foco.
2. **Leitor Bluetooth em "modo HID/teclado"** (~R$ 150-400) — pareia como
   teclado; o app já captura a leitura em qualquer tela. Recomendado para
   balcão/totem.
3. **Leitor USB com adaptador OTG** — idem ao Bluetooth, via cabo; bom
   quando o tablet fica fixo carregando na base.

Não é preciso mudar nada no app para as opções 2 e 3 — qualquer leitor
que "digite" o código e envie Enter funciona.

## Configuração (.env do conector)

| Variável | O que configura |
|---|---|
| `FIREBIRD_DATABASE/HOST/PORT/USER/PASSWORD` | Firebird do ERP |
| `FB_*` | Nomes de tabelas/campos do ERP |
| `DATABASE_URL` | PostgreSQL local (pedidos/pagamentos) |
| `PORT` | Porta do conector |
| `PIX_KEY`, `PIX_MERCHANT_*` | Dados do recebedor Pix (BR Code) |
| `PSP_WEBHOOK_SECRET` | Segredo do webhook do PSP |
| `API_USER`, `API_PASS` | Autenticação básica das rotas (opcional) |

### Esqueci a senha do postgres

O `npm run db:setup` pede a senha do superusuário `postgres` uma única
vez. Se não lembrar: edite `pg_hba.conf` (em `C:\Program Files\
PostgreSQL\<versão>\data\`) trocando `scram-sha-256` por `trust` nas
linhas `host` de `127.0.0.1/32` e `::1/128`, reinicie o serviço
(`services.msc`), rode o setup (qualquer senha serve), e reverta a
alteração se quiser exigir senha de novo.

## Simulando a confirmação do Pix em desenvolvimento

```bash
curl -X POST http://localhost:3000/webhooks/psp \
  -H 'content-type: application/json' \
  -H 'x-webhook-secret: <PSP_WEBHOOK_SECRET do .env>' \
  -d '{"txid": "<psp_txid>", "status": "pago"}'
```

## Próxima fase

- Servidor de API próprio substituindo o acesso direto (os campos já
  existem no app); multi-loja de verdade (preço/estoque por unidade)
- Integração com PSP real de Pix (confirmação automática)
- Gravação da venda de volta no ERP (baixa de estoque/faturamento)
