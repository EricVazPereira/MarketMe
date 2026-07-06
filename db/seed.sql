-- Dados de exemplo para desenvolvimento (1 loja, catálogo típico de condomínio)
BEGIN;

INSERT INTO store (name, condo_id, address) VALUES
  ('MarketMe — Cond. Jardim das Flores', 'JDF-001', 'Rua das Acácias, 100 — São Paulo/SP');

INSERT INTO product (ean, name, category, default_price) VALUES
  ('7894900011517', 'Coca-Cola Lata 350ml',            'Bebidas',   5.50),
  ('7891000100103', 'Leite Integral Ninho 1L',         'Laticínios', 8.90),
  ('7891910000197', 'Açúcar Refinado União 1kg',       'Mercearia',  6.20),
  ('7896036090244', 'Arroz Branco Camil 1kg',          'Mercearia',  7.80),
  ('7891079000021', 'Biscoito Cream Cracker Aymoré',   'Snacks',     4.50),
  ('7892840812850', 'Salgadinho Doritos 84g',          'Snacks',     9.90),
  ('7891991010931', 'Cerveja Heineken Long Neck 330ml','Bebidas',    8.50),
  ('7896004000501', 'Papel Higiênico Neve 4un',        'Higiene',   12.90);

-- Produtos vendidos por peso (hortifruti). EAN interno na faixa "2"
-- (uso em loja, padrão brasileiro p/ pesáveis): os 7 primeiros dígitos
-- (2 + código de 6 dígitos) são o prefixo que a balança imprime na
-- etiqueta, seguido do peso em gramas — por isso cada produto pesável
-- precisa de um prefixo único.
INSERT INTO product (ean, name, category, default_price, unit_type) VALUES
  ('2000001000000', 'Banana Prata (kg)',  'Hortifruti', 6.90, 'kg'),
  ('2000002000000', 'Tomate Salada (kg)', 'Hortifruti', 8.50, 'kg');

-- Estoque e preço da loja 1 (biscoito já perto do mínimo p/ testar alerta)
INSERT INTO store_product (store_id, product_id, price, qty, min_qty)
SELECT 1, p.id, p.default_price, v.qty, v.min_qty
FROM product p
JOIN (VALUES
  ('7894900011517', 24,     6),
  ('7891000100103', 12,     4),
  ('7891910000197', 10,     3),
  ('7896036090244', 10,     3),
  ('7891079000021',  5,     4),
  ('7892840812850', 15,     5),
  ('7891991010931', 30,     8),
  ('7896004000501',  8,     2),
  ('2000001000000', 12.500, 3.000),
  ('2000002000000',  8.750, 2.000)
) AS v(ean, qty, min_qty) ON v.ean = p.ean;

INSERT INTO customer (name, phone, email, condo_id) VALUES
  ('Ana Souza',  '+5511999990001', 'ana@example.com',  'JDF-001'),
  ('Bruno Lima', '+5511999990002', 'bruno@example.com','JDF-001');

COMMIT;
