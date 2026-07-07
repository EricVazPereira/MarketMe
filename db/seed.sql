-- Dados de exemplo do conector: só clientes do app.
-- (Empresa e produtos vêm do Firebird do ERP.)
BEGIN;

INSERT INTO customer (name, phone, email, condo_id) VALUES
  ('Ana Souza',  '+5511999990001', 'ana@example.com',  'JDF-001'),
  ('Bruno Lima', '+5511999990002', 'bruno@example.com','JDF-001');

COMMIT;
