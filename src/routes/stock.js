import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { badRequest, notFound, wrap } from '../errors.js';

export const stockRouter = Router();

async function assertStore(storeId, client = { query }) {
  const { rowCount } = await client.query(
    `SELECT 1 FROM store WHERE id = $1`,
    [storeId],
  );
  if (rowCount === 0) throw notFound('loja não encontrada');
}

// Lista de reposição: itens no mínimo ou abaixo dele (rota do repositor)
stockRouter.get(
  '/stores/:storeId/restock-list',
  wrap(async (req, res) => {
    const { storeId } = req.params;
    await assertStore(storeId);
    const { rows } = await query(
      `SELECT p.id AS product_id, p.ean, p.name, p.category,
              sp.qty, sp.min_qty, GREATEST(sp.min_qty * 2 - sp.qty, 0) AS suggested_qty
         FROM store_product sp
         JOIN product p ON p.id = sp.product_id
        WHERE sp.store_id = $1 AND sp.qty <= sp.min_qty
        ORDER BY sp.qty - sp.min_qty, p.name`,
      [storeId],
    );
    res.json({ store_id: Number(storeId), items: rows });
  }),
);

// Registra uma reposição feita pelo operador
stockRouter.post(
  '/stores/:storeId/restock',
  wrap(async (req, res) => {
    const { storeId } = req.params;
    const { items } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0)
      throw badRequest('items deve ser uma lista não vazia de {product_id, qty}');

    const updated = await withTransaction(async (client) => {
      await assertStore(storeId, client);
      const out = [];
      for (const { product_id, qty } of items) {
        const addQty = Number(qty);
        if (!product_id || !Number.isInteger(addQty) || addQty < 1)
          throw badRequest('cada item precisa de product_id e qty inteiro >= 1');
        const { rows } = await client.query(
          `UPDATE store_product SET qty = qty + $3
            WHERE store_id = $1 AND product_id = $2
            RETURNING product_id, qty`,
          [storeId, product_id, addQty],
        );
        if (rows.length === 0)
          throw notFound(`produto ${product_id} não cadastrado nesta loja`);
        await client.query(
          `INSERT INTO stock_movement (store_id, product_id, type, qty, reason)
           VALUES ($1, $2, 'restock', $3, 'reposição do operador')`,
          [storeId, product_id, addQty],
        );
        out.push(rows[0]);
      }
      return out;
    });
    res.status(201).json({ store_id: Number(storeId), updated });
  }),
);

// Contagem de inventário: ajusta o estoque para a quantidade contada,
// registrando a diferença como ajuste (ou quebra, se informado)
stockRouter.post(
  '/stores/:storeId/inventory',
  wrap(async (req, res) => {
    const { storeId } = req.params;
    const { items, reason = 'contagem de inventário' } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0)
      throw badRequest(
        'items deve ser uma lista não vazia de {product_id, counted_qty}',
      );

    const adjustments = await withTransaction(async (client) => {
      await assertStore(storeId, client);
      const out = [];
      for (const { product_id, counted_qty, loss = false } of items) {
        const counted = Number(counted_qty);
        if (!product_id || !Number.isInteger(counted) || counted < 0)
          throw badRequest(
            'cada item precisa de product_id e counted_qty inteiro >= 0',
          );
        const { rows: current } = await client.query(
          `SELECT qty FROM store_product
            WHERE store_id = $1 AND product_id = $2 FOR UPDATE`,
          [storeId, product_id],
        );
        if (current.length === 0)
          throw notFound(`produto ${product_id} não cadastrado nesta loja`);
        const delta = counted - current[0].qty;
        await client.query(
          `UPDATE store_product SET qty = $3
            WHERE store_id = $1 AND product_id = $2`,
          [storeId, product_id, counted],
        );
        if (delta !== 0) {
          await client.query(
            `INSERT INTO stock_movement (store_id, product_id, type, qty, reason)
             VALUES ($1, $2, $3, $4, $5)`,
            [storeId, product_id, loss ? 'loss' : 'adjustment', delta, reason],
          );
        }
        out.push({ product_id, counted_qty: counted, delta, loss });
      }
      return out;
    });
    res.status(201).json({ store_id: Number(storeId), adjustments });
  }),
);
