-- MarketMe — esquema local do conector (v2, fase Firebird direto)
--
-- Cadastros (empresa/loja, produtos, preços) vêm do Firebird do ERP em
-- tempo real; aqui ficam só os dados operacionais do MarketMe: clientes
-- do app, pedidos (com snapshot de nome/preço no momento do scan) e
-- pagamentos Pix. Estoque é responsabilidade do ERP nesta fase.

BEGIN;

CREATE TABLE IF NOT EXISTS customer (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  email      TEXT UNIQUE,
  condo_id   TEXT,
  status     TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo', 'encerrado')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id          SERIAL PRIMARY KEY,
  -- código da EMPRESA no ERP (sem FK: a tabela mora no Firebird)
  store_id    INTEGER NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  status      TEXT NOT NULL DEFAULT 'aberto'
              CHECK (status IN ('aberto', 'pago', 'concluido', 'cancelado')),
  total       NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at     TIMESTAMPTZ
);

-- Item do pedido com SNAPSHOT do produto (código, EAN, nome e preço do
-- cadastro no momento do scan): o pedido continua íntegro mesmo que o
-- preço mude no ERP depois. qty em NUMERIC p/ peso (ex.: 1,500 kg).
CREATE TABLE IF NOT EXISTS order_item (
  order_id     INTEGER NOT NULL REFERENCES orders(id),
  product_code TEXT NOT NULL,
  ean          TEXT NOT NULL,
  name         TEXT NOT NULL,
  unit_type    TEXT NOT NULL DEFAULT 'un' CHECK (unit_type IN ('un', 'kg')),
  qty          NUMERIC(10,3) NOT NULL CHECK (qty > 0),
  unit_price   NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
  PRIMARY KEY (order_id, product_code)
);

CREATE TABLE IF NOT EXISTS payment (
  id         SERIAL PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  method     TEXT NOT NULL DEFAULT 'pix' CHECK (method IN ('pix')),
  amount     NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  status     TEXT NOT NULL DEFAULT 'pendente'
             CHECK (status IN ('pendente', 'pago', 'expirado', 'cancelado')),
  psp_txid   TEXT NOT NULL UNIQUE,
  qr_payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_orders_store_status ON orders (store_id, status, paid_at);
CREATE INDEX IF NOT EXISTS idx_payment_order ON payment (order_id);

COMMIT;
