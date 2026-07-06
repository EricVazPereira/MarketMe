import { Router } from 'express';
import { query } from '../db.js';
import { notFound, wrap } from '../errors.js';

export const catalogRouter = Router();

// Lojas ativas (o app usa para o morador escolher a sua)
catalogRouter.get(
  '/stores',
  wrap(async (_req, res) => {
    const { rows } = await query(
      `SELECT id, name, condo_id, address FROM store
        WHERE status = 'ativa' ORDER BY name`,
    );
    res.json({ stores: rows });
  }),
);

// Catálogo da loja: produtos com preço e disponibilidade daquela unidade
catalogRouter.get(
  '/stores/:storeId/catalog',
  wrap(async (req, res) => {
    const { storeId } = req.params;
    const store = await query(
      `SELECT id, name, condo_id, status FROM store WHERE id = $1`,
      [storeId],
    );
    if (store.rowCount === 0) throw notFound('loja não encontrada');

    const { rows } = await query(
      `SELECT p.id, p.ean, p.name, p.category, p.image_url, p.unit_type,
              sp.price::float AS price, sp.qty::float AS available
         FROM store_product sp
         JOIN product p ON p.id = sp.product_id
        WHERE sp.store_id = $1
        ORDER BY p.category, p.name`,
      [storeId],
    );
    res.json({ store: store.rows[0], products: rows });
  }),
);

// Modo balança: a etiqueta impressa pela balança traz "2" + código do
// produto (6 dígitos) + peso em gramas (5 dígitos) + verificador. Este
// endpoint resolve o prefixo (2 + código) para o produto pesável da loja.
catalogRouter.get(
  '/stores/:storeId/products/scale/:prefix',
  wrap(async (req, res) => {
    const { storeId, prefix } = req.params;
    if (!/^2\d{6}$/.test(prefix))
      return res
        .status(400)
        .json({ error: 'prefixo de balança deve ser 2 + 6 dígitos' });
    const { rows } = await query(
      `SELECT p.id, p.ean, p.name, p.category, p.image_url, p.unit_type,
              sp.price::float AS price, sp.qty::float AS available
         FROM store_product sp
         JOIN product p ON p.id = sp.product_id
        WHERE sp.store_id = $1 AND p.unit_type = 'kg' AND p.ean LIKE $2 || '%'
        ORDER BY p.ean LIMIT 1`,
      [storeId, prefix],
    );
    if (rows.length === 0)
      throw notFound('produto de balança não encontrado nesta loja');
    res.json(rows[0]);
  }),
);

// Resolve um EAN escaneado para o produto/preço da loja atual
catalogRouter.get(
  '/stores/:storeId/products/ean/:ean',
  wrap(async (req, res) => {
    const { storeId, ean } = req.params;
    const { rows } = await query(
      `SELECT p.id, p.ean, p.name, p.category, p.image_url, p.unit_type,
              sp.price::float AS price, sp.qty::float AS available
         FROM store_product sp
         JOIN product p ON p.id = sp.product_id
        WHERE sp.store_id = $1 AND p.ean = $2`,
      [storeId, ean],
    );
    if (rows.length === 0) throw notFound('produto não disponível nesta loja');
    res.json(rows[0]);
  }),
);
