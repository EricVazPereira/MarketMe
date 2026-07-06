# Pesquisa: Sistemas de Mini-Mercado Autônomo de Condomínio

> Relatório de pesquisa (deep-research) para embasar o **MarketMe**.
> Objetivo: entender como funcionam os sistemas dos players do mercado
> autônomo brasileiro e extrair o que dá pra copiar/adaptar ao banco de
> dados e APIs que você já tem.
> Data: 2026-07-06.

---

## 1. Resumo (TL;DR)

Um **mercado autônomo de condomínio** é uma loja de autoatendimento 24h,
sem funcionário no local, instalada dentro do prédio. O morador entra,
pega o produto, **escaneia o código de barras no app (ou totem)** e paga
por **Pix / cartão / QR**. Câmeras + IA monitoram furto, e o estoque é
reposto por um operador com base em alertas do sistema.

O software se divide sempre nos mesmos **5 módulos**:

1. **App do cliente** (scan & pay)
2. **Totem/PDV de autoatendimento** (alternativa ao app)
3. **Motor de pagamento** (Pix dinâmico, cartão, carteira/saldo)
4. **Antifurto / visão computacional** (câmeras + IA)
5. **Backoffice** (estoque, reposição, multi-loja, relatórios, franqueado)

Esse é o esqueleto que vale a pena copiar. As seções 4–7 traduzem isso
em módulos, modelo de dados e API pra adaptar ao MarketMe.

---

## 2. Como funciona (fluxo do modelo de negócio)

```
Morador entra na loja (porta 24h, às vezes com QR/biometria de acesso)
        │
        ▼
Pega produtos das prateleiras / geladeiras abertas
        │
        ▼
Abre o APP  ──►  escaneia código de barras de cada item
        │              (ou usa o totem de autoatendimento)
        ▼
Confere carrinho ──► paga (Pix dinâmico / cartão salvo / saldo)
        │
        ▼
Recebe comprovante ── câmeras + IA cruzam venda x itens retirados
        │
        ▼
Backoffice baixa estoque ──► gera alerta de reposição quando baixo
        │
        ▼
Operador/repositor faz a rota e reabastece
```

**Pontos-chave do modelo:**
- Loja **não tem caixa nem funcionário**; confiança + monitoramento.
- Perda por furto ("quebra") é tratada como custo operacional; a IA e as
  câmeras servem pra reduzir, não eliminar.
- Modelo comum é **franquia** ou **parceria com o condomínio** (repasse de
  % do faturamento via Pix pro condomínio).

---

## 3. Comparativo dos players (Brasil)

| Player | Escala | Diferencial de sistema | O que copiar |
|---|---|---|---|
| **Market4u** | ~2.500 lojas, maior da América Latina | App próprio, reposição inteligente, antifraude | App scan&pay + reposição por IA |
| **InHouse Market** | +1.800 lojas, +340 cidades | Foco em condomínios/empresas 24h | Onboarding de condomínio + repasse |
| **SmartStore (BR)** | ~2.000 lojas | Escala de contratos/franquia | Gestão multi-loja / franqueado |
| **Mikro Market** | ~300 unidades (meta 2025) | Expansão via franquia | Playbook de franquia |
| **Mercatus / Equattro** | Sistema white-label | **IA antifurto** analisa câmera em tempo real, multi-loja, indicadores por loja | Módulo antifurto + dashboards |
| **PocketMarket** | Lojas p/ condomínio | Câmeras integradas + rastreio de produto; quebra absorvida pela plataforma; repasse via Pix | Rastreio de inventário + repasse |
| **Linvix** | Software autoatendimento | **Hub Pix próprio** sem operadora (evita taxa), analytics de produto | Pix direto (economia de taxa) |
| **SmartPOS** | PDV PMEs | Estoque + vendas + QR Pix + cartão | Base de PDV/estoque |

**Leitura estratégica:** os "grandes" (Market4u, InHouse, SmartStore)
vendem **rede/franquia**; os "de software" (Mercatus/Equattro, Linvix,
PocketMarket) vendem a **plataforma**. Pra você, que já tem DB+API, o
alvo de cópia são os **de software** — principalmente Mercatus (antifurto)
e Linvix (Pix direto).

---

## 4. Arquitetura do sistema (o esqueleto pra copiar)

```
┌─────────────────┐   ┌─────────────────┐   ┌──────────────────┐
│  App Cliente    │   │  Totem / PDV    │   │  Painel Admin    │
│  (mobile)       │   │  (loja)         │   │  (web/franqueado)│
└────────┬────────┘   └────────┬────────┘   └────────┬─────────┘
         │                     │                      │
         └──────────── API Gateway (REST/JSON) ───────┘
                              │
     ┌───────────┬───────────┼───────────┬────────────┐
     ▼           ▼           ▼           ▼            ▼
 Catálogo    Carrinho/    Pagamento   Estoque/     Antifurto
 & Loja      Pedido       (Pix/cartão) Reposição   (câmera+IA)
     │           │           │           │            │
     └───────────┴───────────┴───────────┴────────────┘
                              │
                     Banco de Dados (o seu)
```

### Módulos e o que cada um faz

**A) Catálogo & Loja**
- Cadastro de produtos (EAN/código de barras, preço, categoria, foto).
- Cada **loja/condomínio** é uma unidade com estoque e preço próprios.
- Geolocalização/identificação da loja (QR na parede, ou seleção no app).

**B) Carrinho & Pedido (self-checkout)**
- Scan do código de barras → resolve produto pela loja atual → adiciona.
- Carrinho local, total em tempo real, confirmação → cria **pedido**.
- Estados do pedido: `aberto → pago → concluído / cancelado`.

**C) Pagamento**
- **Pix dinâmico** (gera QR/copia-e-cola por pedido, confirma via webhook).
  → Linvix mostra que Pix direto no PSP evita taxa de adquirente.
- **Cartão salvo** (tokenizado) e/ou **saldo/carteira** do usuário.
- Idempotência + webhook de confirmação antes de liberar o pedido.

**D) Estoque & Reposição**
- Baixa de estoque no pagamento confirmado.
- **Alerta de reposição** por estoque mínimo → gera lista/rota do repositor.
- Inventário/contagem, ajuste de quebra (perda), reposição registrada.
- "Reposição inteligente": prever consumo por histórico (fase 2).

**E) Antifurto / Visão computacional**
- Câmeras por loja; IA analisa imagem e cruza com vendas.
- Detecta **retirada sem pagamento** / comportamento suspeito → alerta.
- MVP: só câmera + alerta manual; IA de imagem entra depois.

**F) Backoffice / Multi-loja**
- Dashboard por loja e consolidado (faturamento, ticket, top produtos).
- Gestão de franqueado/parceiro e **repasse ao condomínio** (% via Pix).
- Relatórios de venda, quebra, reposição, inadimplência.

---

## 5. Modelo de dados sugerido (adapte ao seu DB)

> Só o núcleo — mapeie pros nomes/tabelas que você já tem.

```sql
-- Lojas (cada condomínio = 1 loja)
store(id, name, condo_id, address, revenue_share_pct, status)

-- Produtos (catálogo global)
product(id, ean, name, category, image_url, default_price)

-- Estoque por loja (preço e quantidade específicos)
store_product(store_id, product_id, price, qty, min_qty)   -- PK composta

-- Usuários (moradores)
customer(id, name, phone, email, condo_id, wallet_balance)

-- Pedidos (uma compra)
order(id, store_id, customer_id, status, total, created_at, paid_at)
order_item(order_id, product_id, qty, unit_price)

-- Pagamentos
payment(id, order_id, method, amount, status, psp_txid, qr_payload)

-- Reposição / movimentos de estoque
stock_movement(id, store_id, product_id, type, qty, reason, created_at)
-- type: sale | restock | loss(quebra) | adjustment

-- Antifurto
theft_alert(id, store_id, order_id?, camera_id, severity, snapshot_url, status)

-- Repasse ao condomínio
payout(id, store_id, period, gross, share_pct, amount, status)
```

---

## 6. API sugerida (adapte aos seus endpoints existentes)

```
# App cliente
GET  /stores/{id}/catalog                 # catálogo + preço da loja
POST /orders                              # cria pedido (carrinho)
POST /orders/{id}/items                   # add item (scan de EAN)
POST /orders/{id}/pay                     # inicia pagamento (Pix/cartão)
GET  /orders/{id}                         # status do pedido
POST /webhooks/psp                        # confirmação Pix/cartão (idempotente)

# Estoque / reposição (operador)
GET  /stores/{id}/restock-list            # itens abaixo do mínimo
POST /stores/{id}/restock                 # registra reposição
POST /stores/{id}/inventory               # contagem/ajuste

# Antifurto
POST /theft-alerts                        # ingestão de evento da câmera/IA
GET  /stores/{id}/theft-alerts            # fila de alertas

# Backoffice
GET  /stores/{id}/dashboard               # faturamento, ticket, top produtos
GET  /stores/{id}/payouts                 # repasse ao condomínio
```

**Regras críticas que os players seguem (copie):**
- Pedido **só conclui após webhook de pagamento confirmado** (nunca no
  clique do cliente).
- **Idempotência** em `/pay` e no webhook (evita cobrança/baixa dupla).
- Baixa de estoque **atômica** com a confirmação do pagamento.
- Preço e estoque **por loja**, não global.

---

## 7. Roadmap de adaptação ao MarketMe

Como o repo está vazio e você já tem DB + APIs, sugestão de fases:

**Fase 1 — MVP funcional (copiar o núcleo)**
- [ ] Catálogo por loja + scan de EAN no app
- [ ] Carrinho → pedido → **Pix dinâmico** com webhook
- [ ] Baixa de estoque atômica + alerta de estoque mínimo
- [ ] Dashboard simples por loja (faturamento/top produtos)

**Fase 2 — Operação de rede**
- [ ] Multi-loja + gestão de repositor (rota de reposição)
- [ ] Repasse ao condomínio (% via Pix) — modelo InHouse/PocketMarket
- [ ] Cartão tokenizado + carteira/saldo

**Fase 3 — Inteligência (diferencial dos grandes)**
- [ ] Antifurto: câmeras + alerta manual → IA de imagem (modelo Mercatus)
- [ ] Reposição preditiva por histórico de consumo (modelo Market4u)
- [ ] Pix direto no PSP pra cortar taxa de adquirente (modelo Linvix)

**Próximo passo prático no Claude Code:** me diga o **stack** do seu
backend (linguagem/framework) e o **formato do seu DB/APIs atuais**, que
eu já mapeio esse modelo pros seus nomes reais e começo a Fase 1.

---

## Fontes

- [market4u — Instalar mercado no condomínio](https://market4u.com.br/blog/instalar-mercado-no-condominio/)
- [InHouse Market](https://inhousemarket.com.br/)
- [uCondo — Mercado em condomínio: guia completo](https://www.ucondo.com.br/blog/mercado-em-condominio-o-guia-completo)
- [SuperVarejo — Mercados autônomos: ainda há muito o que crescer](https://www.supervarejo.com.br/varejo/mercados-autonomos-ainda-ha-muito-o-que-crescer)
- [Avalyst — Mercados autônomos em condomínios](https://www.avalyst.com.br/blog/mercados-autonomos-condominios/)
- [Exame — Empresa brasileira exportou o "mercado de condomínio" para os EUA](https://exame.com/negocios/essa-empresa-brasileira-exportou-o-mercado-de-condominio-para-os-eua-e-hoje-fatura-milhoes/)
- [Portal do Franchising — Mikro Market expansão 2025](https://www.portaldofranchising.com.br/noticias/mikro-market-expansao-nacional-e-metas-ambiciosas-para-2025/)
- [Equattro / Mercatus — Sistema para mercados autônomos](https://mercadoautonomo.e4sistemas.com.br/)
- [PocketMarket — Lojas autônomas para condomínios](https://pocketmarket.com.br/)
- [Linvix — Self-checkout / Hub Pix](https://linvix.com.br/self-checkout/)
- [SmartPOS — Gestão de estoque, vendas e Pix](https://www.smartpos.net.br/)
- [SAX — O que é self-checkout](https://saxbr.com/blog/o-que-e-self-checkout/)
- [Smartstore — Smart Stores 24/7](https://smartstore.com/en/smart-stores-24/7-the-future-of-retail/)
