import { Router } from 'express';
import { query } from '../db.js';
import { notFound, wrap } from '../errors.js';

export const catalogRouter = Router();

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
      `SELECT p.id, p.ean, p.name, p.category, p.image_url,
              sp.price::float AS price, sp.qty AS available
         FROM store_product sp
         JOIN product p ON p.id = sp.product_id
        WHERE sp.store_id = $1
        ORDER BY p.category, p.name`,
      [storeId],
    );
    res.json({ store: store.rows[0], products: rows });
  }),
);

// Resolve um EAN escaneado para o produto/preço da loja atual
catalogRouter.get(
  '/stores/:storeId/products/ean/:ean',
  wrap(async (req, res) => {
    const { storeId, ean } = req.params;
    const { rows } = await query(
      `SELECT p.id, p.ean, p.name, p.category, p.image_url,
              sp.price::float AS price, sp.qty AS available
         FROM store_product sp
         JOIN product p ON p.id = sp.product_id
        WHERE sp.store_id = $1 AND p.ean = $2`,
      [storeId, ean],
    );
    if (rows.length === 0) throw notFound('produto não disponível nesta loja');
    res.json(rows[0]);
  }),
);
