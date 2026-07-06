-- MarketMe — esquema do banco (Fase 1)
-- Núcleo do modelo de dados da pesquisa (PESQUISA_MERCADO_AUTONOMO.md, seção 5),
-- sem os módulos de antifurto e repasse (fases futuras).

BEGIN;

CREATE TABLE IF NOT EXISTS store (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  condo_id    TEXT,
  address     TEXT,
  status      TEXT NOT NULL DEFAULT 'ativa'
              CHECK (status IN ('ativa', 'inativa')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product (
  id            SERIAL PRIMARY KEY,
  ean           TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  category      TEXT,
  image_url     TEXT,
  default_price NUMERIC(10,2) NOT NULL CHECK (default_price >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Preço e estoque são POR LOJA, não globais (regra crítica da pesquisa)
CREATE TABLE IF NOT EXISTS store_product (
  store_id   INTEGER NOT NULL REFERENCES store(id),
  product_id INTEGER NOT NULL REFERENCES product(id),
  price      NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  qty        INTEGER NOT NULL DEFAULT 0,
  min_qty    INTEGER NOT NULL DEFAULT 0 CHECK (min_qty >= 0),
  PRIMARY KEY (store_id, product_id)
);

CREATE TABLE IF NOT EXISTS customer (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  email      TEXT UNIQUE,
  condo_id   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id          SERIAL PRIMARY KEY,
  store_id    INTEGER NOT NULL REFERENCES store(id),
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  status      TEXT NOT NULL DEFAULT 'aberto'
              CHECK (status IN ('aberto', 'pago', 'concluido', 'cancelado')),
  total       NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS order_item (
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES product(id),
  qty        INTEGER NOT NULL CHECK (qty > 0),
  unit_price NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
  PRIMARY KEY (order_id, product_id)
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

-- Todo movimento de estoque fica registrado (venda, reposição, quebra, ajuste)
CREATE TABLE IF NOT EXISTS stock_movement (
  id         SERIAL PRIMARY KEY,
  store_id   INTEGER NOT NULL REFERENCES store(id),
  product_id INTEGER NOT NULL REFERENCES product(id),
  type       TEXT NOT NULL CHECK (type IN ('sale', 'restock', 'loss', 'adjustment')),
  qty        INTEGER NOT NULL,
  reason     TEXT,
  order_id   INTEGER REFERENCES orders(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_store_status ON orders (store_id, status, paid_at);
CREATE INDEX IF NOT EXISTS idx_payment_order ON payment (order_id);
CREATE INDEX IF NOT EXISTS idx_stock_movement_store ON stock_movement (store_id, product_id, created_at);

COMMIT;
