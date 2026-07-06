# MarketMe

Backend de **mini-mercado autônomo de condomínio** (scan & pay, sem
funcionário no local). Baseado na pesquisa de mercado em
[`PESQUISA_MERCADO_AUTONOMO.md`](./PESQUISA_MERCADO_AUTONOMO.md).

Este repositório implementa a **Fase 1 (MVP funcional)** do roadmap:

- ✅ Catálogo por loja + resolução de EAN escaneado no app
- ✅ Carrinho → pedido → **Pix dinâmico** (BR Code copia-e-cola) com webhook
- ✅ Baixa de estoque **atômica** na confirmação do pagamento
- ✅ Alerta de estoque mínimo + lista de reposição + registro de inventário
- ✅ Dashboard simples por loja (faturamento, ticket médio, top produtos)
- ✅ Cancelamento de pedido/carrinho (com cancelamento da cobrança Pix)
- ✅ Encerramento de conta do cliente (soft-delete)
- ✅ Produtos vendidos por peso (hortifruti, açougue) — preço/kg, estoque
  fracionário e fluxo de pesagem no app
- ✅ Autenticação básica opcional das APIs (usuário/senha via `.env`)
- ✅ Modo balança: leitura do peso embutido na etiqueta EAN-13 da balança

> Fora de escopo (decisão de produto): **não** haverá desenvolvimento de
> IA/visão computacional para antifurto. Os demais itens das Fases 2 e 3
> (multi-loja avançado, repasse ao condomínio, carteira, Pix direto no
> PSP) ficam para as próximas fases.

## Stack

- **Node.js 20+** com Express
- **PostgreSQL** (SQL puro via `pg`, transações explícitas)
- Testes de ponta a ponta com `node:test` (sem framework extra)

## Como rodar

```bash
# 1. Configuração
cp .env.example .env    # ajuste DATABASE_URL se necessário

# 2. Banco (requer PostgreSQL com o banco/usuário criados)
#    CREATE ROLE pointer LOGIN PASSWORD '...';
#    CREATE DATABASE marketme OWNER pointer;
npm install
npm run db:init         # cria esquema + dados de exemplo
# npm run db:init -- --reset  # recria do zero (apaga tudo!)

# 3. API
npm start               # ou: npm run dev (com reload)

# 4. Testes (recriam o esquema no banco configurado)
npm test
```

## Fluxo da compra (o coração do sistema)

```
morador escaneia EAN ─► POST /orders/:id/items (valida estoque da loja)
        │
        ▼
POST /orders/:id/pay ─► gera Pix dinâmico (txid + copia-e-cola) — idempotente
        │
        ▼
PSP confirma ─► POST /webhooks/psp  ─┐ mesma transação:
                                     ├ payment → pago
                                     ├ baixa de estoque + stock_movement
                                     ├ pedido → concluído
                                     └ alerta se qty ≤ min_qty
```

Regras críticas seguidas (seção 6 da pesquisa):

- O pedido **só conclui após o webhook** do PSP — nunca no clique do cliente.
- `/pay` e o webhook são **idempotentes** (reenvio do PSP não baixa estoque
  nem cobra duas vezes).
- Baixa de estoque **na mesma transação** da confirmação do pagamento.
- Preço e estoque são **por loja** (`store_product`), não globais.

## Endpoints

### App do cliente

| Método | Rota | Descrição |
|---|---|---|
| GET | `/stores` | Lojas ativas (seleção no app) |
| GET | `/stores/:id/catalog` | Catálogo com preço/estoque da loja |
| GET | `/stores/:id/products/ean/:ean` | Resolve EAN escaneado |
| GET | `/stores/:id/products/scale/:prefix` | Modo balança: resolve o prefixo `2` + código (6 dígitos) da etiqueta para o produto pesável |
| POST | `/orders` | Abre pedido (`{store_id, customer_id}`) |
| POST | `/orders/:id/items` | Adiciona item (`{ean, qty?}`) — `qty` é contagem para produto por unidade, ou peso em kg para produto por peso |
| DELETE | `/orders/:id/items/:productId` | Remove item do carrinho |
| POST | `/orders/:id/cancel` | Cancela pedido aberto (e a cobrança Pix pendente) |
| POST | `/orders/:id/pay` | Gera cobrança Pix dinâmica |
| GET | `/orders/:id` | Status do pedido (polling do app) |
| POST | `/customers/:id/close` | Encerra a conta do cliente (soft-delete; recusa se houver pedido aberto) |

### Integração PSP

| Método | Rota | Descrição |
|---|---|---|
| POST | `/webhooks/psp` | Confirmação de pagamento (`{txid, status}`, header `x-webhook-secret`) |

### Operador / reposição

| Método | Rota | Descrição |
|---|---|---|
| GET | `/stores/:id/restock-list` | Itens em `qty ≤ min_qty` + sugestão |
| POST | `/stores/:id/restock` | Registra reposição (`{items: [{product_id, qty}]}`) |
| POST | `/stores/:id/inventory` | Contagem/ajuste (`{items: [{product_id, counted_qty, loss?}]}`) |

### Backoffice

| Método | Rota | Descrição |
|---|---|---|
| GET | `/stores/:id/dashboard` | Faturamento, pedidos, ticket médio, top 10 produtos (`?from&to`) |

## Modelo de dados

Núcleo da seção 5 da pesquisa (sem `theft_alert` e `payout`, que são de
fases futuras): `store`, `product`, `store_product` (preço/estoque por
loja), `customer`, `orders`/`order_item`, `payment`, `stock_movement`
(todo movimento — venda, reposição, quebra, ajuste — fica auditável).

- `product.unit_type` (`un` | `kg`) diferencia produto por unidade de
  produto por peso; `store_product.qty`/`min_qty` e `order_item.qty` são
  `NUMERIC` para suportar peso fracionário (ex.: 1,500 kg).
- `customer.status` (`ativo` | `encerrado`) é o soft-delete da conta.
- `orders.status`/`payment.status` incluem `cancelado`.

## Configuração

Toda configuração sensível do sistema fica **no servidor**, no arquivo
`.env` (veja [`.env.example`](./.env.example)):

| Variável | O que configura |
|---|---|
| `DATABASE_URL` | Caminho/credenciais do banco PostgreSQL |
| `PORT` | Porta da API |
| `PIX_KEY`, `PIX_MERCHANT_*` | Dados do recebedor Pix (BR Code) |
| `PSP_WEBHOOK_SECRET` | Segredo que autentica o webhook do PSP |
| `API_USER`, `API_PASS` | Autenticação básica das APIs (opcional) |

A tela de **Configurações do app** guarda apenas o que é do aparelho:
endereço da API, usuário/senha da API (se habilitados no servidor),
loja, cliente e **balança integrada (sim/não)**. O caminho do banco de
dados fica de fora do app de propósito: o celular nunca fala com o
PostgreSQL diretamente — expor essas credenciais em cada aparelho
permitiria a qualquer morador ler o banco inteiro.

### Modo balança

Com **balança = sim**, o app interpreta etiquetas EAN-13 de balança no
padrão brasileiro `2 CCCCCC WWWWW D` (prefixo `2`, código do produto,
peso em gramas, dígito verificador): ao escanear, o peso vem da própria
etiqueta e o item entra no carrinho sem perguntar nada. Com
**balança = não** (padrão), o app abre um campo pedindo o peso em kg.
Ex.: etiqueta `2000001015004` → produto `2000001` (banana), 1,500 kg.

Esquema em [`db/schema.sql`](./db/schema.sql), dados de exemplo em
[`db/seed.sql`](./db/seed.sql).

## Simulando um pagamento em desenvolvimento

Sem PSP real, confirme o Pix manualmente:

```bash
# 1. crie o pedido, adicione itens e chame /pay — anote o psp_txid
# 2. simule o webhook do PSP:
curl -X POST localhost:3000/webhooks/psp \
  -H 'content-type: application/json' \
  -H 'x-webhook-secret: <PSP_WEBHOOK_SECRET do .env>' \
  -d '{"txid": "<psp_txid>", "status": "pago"}'
```

## App Android (cliente scan & pay)

O diretório [`app/`](./app) contém o app do morador: uma SPA (HTML/JS)
que escaneia código de barras pela câmera, monta o carrinho e paga com
Pix copia-e-cola, embarcada em um APK Android via WebView nativo.

- **APK pronto:** [`app/releases/marketme-debug.apk`](./app/releases/marketme-debug.apk)
  (minSdk 23 / Android 6+, assinatura de debug — instale habilitando
  "fontes desconhecidas")
- **Primeiro uso:** abra o app → informe o endereço da API
  (ex.: `http://192.168.0.10:3000`, o IP da máquina que roda o backend,
  na mesma rede Wi-Fi) → toque em "Buscar lojas" → escolha a loja → salvar.
- **Recompilar o APK** (Linux, sem Gradle/Android Studio — usa as
  ferramentas do SDK empacotadas pelo Debian/Ubuntu):

```bash
sudo apt install android-sdk-build-tools android-sdk-platform-23 \
                 apksigner zipalign dalvik-exchange default-jdk
cd app && npm install && npm run build:apk
# → app/android/build/marketme-debug.apk
```

> Nota: o app usa WebView + `file://` com acesso universal liberado e
> tráfego HTTP em texto claro — adequado para o MVP em rede local. Antes
> de produção: servir a API via HTTPS e restringir essas permissões.

## Próximos passos (Fase 2)

- Cadastro/autenticação de moradores (hoje os clientes vêm do seed)
- Integração com um PSP real de Pix (Efí, Mercado Pago, PagBank…)
- Multi-loja com rota de reposição do operador
- Repasse ao condomínio (% do faturamento via Pix)
- Cartão tokenizado + carteira/saldo
