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
| GET | `/stores/:id/catalog` | Catálogo com preço/estoque da loja |
| GET | `/stores/:id/products/ean/:ean` | Resolve EAN escaneado |
| POST | `/orders` | Abre pedido (`{store_id, customer_id}`) |
| POST | `/orders/:id/items` | Adiciona item (`{ean, qty?}`) |
| DELETE | `/orders/:id/items/:productId` | Remove item do carrinho |
| POST | `/orders/:id/pay` | Gera cobrança Pix dinâmica |
| GET | `/orders/:id` | Status do pedido (polling do app) |

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

## Próximos passos (Fase 2)

- Cadastro/autenticação de moradores (hoje os clientes vêm do seed)
- Integração com um PSP real de Pix (Efí, Mercado Pago, PagBank…)
- Multi-loja com rota de reposição do operador
- Repasse ao condomínio (% do faturamento via Pix)
- Cartão tokenizado + carteira/saldo
