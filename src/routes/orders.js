import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { badRequest, conflict, notFound, wrap } from '../errors.js';
import { buildBrCode, generateTxid } from '../services/pix.js';

export const ordersRouter = Router();

async function loadOrder(orderId, client = { query }) {
  const { rows } = await client.query(
    `SELECT o.id, o.store_id, o.customer_id, o.status,
            o.total::float AS total, o.created_at, o.paid_at
       FROM orders o WHERE o.id = $1`,
    [orderId],
  );
  if (rows.length === 0) throw notFound('pedido não encontrado');
  return rows[0];
}

async function orderItems(orderId) {
  const { rows } = await query(
    `SELECT oi.product_id, p.ean, p.name, oi.qty,
            oi.unit_price::float AS unit_price,
            (oi.qty * oi.unit_price)::float AS subtotal
       FROM order_item oi
       JOIN product p ON p.id = oi.product_id
      WHERE oi.order_id = $1
      ORDER BY p.name`,
    [orderId],
  );
  return rows;
}

// Abre um pedido (carrinho) na loja
ordersRouter.post(
  '/orders',
  wrap(async (req, res) => {
    const { store_id, customer_id } = req.body ?? {};
    if (!store_id || !customer_id)
      throw badRequest('store_id e customer_id são obrigatórios');

    const store = await query(
      `SELECT id FROM store WHERE id = $1 AND status = 'ativa'`,
      [store_id],
    );
    if (store.rowCount === 0) throw notFound('loja não encontrada ou inativa');
    const customer = await query(`SELECT id FROM customer WHERE id = $1`, [
      customer_id,
    ]);
    if (customer.rowCount === 0) throw notFound('cliente não encontrado');

    const { rows } = await query(
      `INSERT INTO orders (store_id, customer_id)
       VALUES ($1, $2)
       RETURNING id, store_id, customer_id, status, total::float AS total, created_at`,
      [store_id, customer_id],
    );
    res.status(201).json(rows[0]);
  }),
);

// Scan de EAN: adiciona (ou incrementa) item no carrinho
ordersRouter.post(
  '/orders/:orderId/items',
  wrap(async (req, res) => {
    const { orderId } = req.params;
    const { ean, qty = 1 } = req.body ?? {};
    if (!ean) throw badRequest('ean é obrigatório');
    const addQty = Number(qty);
    if (!Number.isInteger(addQty) || addQty < 1)
      throw badRequest('qty deve ser inteiro >= 1');

    const order = await withTransaction(async (client) => {
      const ord = await loadOrder(orderId, client);
      if (ord.status !== 'aberto')
        throw conflict(`pedido não está aberto (status: ${ord.status})`);

      const { rows: found } = await client.query(
        `SELECT sp.product_id, sp.price, sp.qty AS available
           FROM store_product sp
           JOIN product p ON p.id = sp.product_id
          WHERE sp.store_id = $1 AND p.ean = $2
          FOR UPDATE OF sp`,
        [ord.store_id, ean],
      );
      if (found.length === 0)
        throw notFound('produto não disponível nesta loja');
      const { product_id, price, available } = found[0];

      const { rows: existing } = await client.query(
        `SELECT qty FROM order_item WHERE order_id = $1 AND product_id = $2`,
        [orderId, product_id],
      );
      const inCart = existing.length > 0 ? existing[0].qty : 0;
      if (inCart + addQty > available)
        throw conflict(
          `estoque insuficiente (disponível: ${available}, no carrinho: ${inCart})`,
        );

      await client.query(
        `INSERT INTO order_item (order_id, product_id, qty, unit_price)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (order_id, product_id)
         DO UPDATE SET qty = order_item.qty + EXCLUDED.qty`,
        [orderId, product_id, addQty, price],
      );
      await client.query(
        `UPDATE orders o SET total = (
           SELECT COALESCE(SUM(qty * unit_price), 0)
             FROM order_item WHERE order_id = o.id
         ) WHERE o.id = $1`,
        [orderId],
      );
      return loadOrder(orderId, client);
    });

    res.status(201).json({ ...order, items: await orderItems(orderId) });
  }),
);

// Remove um item do carrinho
ordersRouter.delete(
  '/orders/:orderId/items/:productId',
  wrap(async (req, res) => {
    const { orderId, productId } = req.params;
    const order = await withTransaction(async (client) => {
      const ord = await loadOrder(orderId, client);
      if (ord.status !== 'aberto')
        throw conflict(`pedido não está aberto (status: ${ord.status})`);
      const del = await client.query(
        `DELETE FROM order_item WHERE order_id = $1 AND product_id = $2`,
        [orderId, productId],
      );
      if (del.rowCount === 0) throw notFound('item não está no carrinho');
      await client.query(
        `UPDATE orders o SET total = (
           SELECT COALESCE(SUM(qty * unit_price), 0)
             FROM order_item WHERE order_id = o.id
         ) WHERE o.id = $1`,
        [orderId],
      );
      return loadOrder(orderId, client);
    });
    res.json({ ...order, items: await orderItems(orderId) });
  }),
);

// Inicia o pagamento: gera o Pix dinâmico (copia-e-cola) do pedido.
// Idempotente: repetir a chamada devolve a mesma cobrança ativa.
ordersRouter.post(
  '/orders/:orderId/pay',
  wrap(async (req, res) => {
    const { orderId } = req.params;
    const payment = await withTransaction(async (client) => {
      const ord = await loadOrder(orderId, client);
      if (ord.status !== 'aberto')
        throw conflict(`pedido não está aberto (status: ${ord.status})`);
      if (ord.total <= 0) throw badRequest('pedido sem itens');

      const { rows: active } = await client.query(
        `SELECT id, order_id, method, amount::float AS amount, status,
                psp_txid, qr_payload, created_at
           FROM payment
          WHERE order_id = $1 AND status IN ('pendente', 'pago')
          ORDER BY id DESC LIMIT 1`,
        [orderId],
      );
      if (active.length > 0) return active[0];

      const txid = generateTxid();
      const qrPayload = buildBrCode({ txid, amount: ord.total });
      const { rows } = await client.query(
        `INSERT INTO payment (order_id, method, amount, status, psp_txid, qr_payload)
         VALUES ($1, 'pix', $2, 'pendente', $3, $4)
         RETURNING id, order_id, method, amount::float AS amount, status,
                   psp_txid, qr_payload, created_at`,
        [orderId, ord.total, txid, qrPayload],
      );
      return rows[0];
    });
    res.status(201).json(payment);
  }),
);

// Status do pedido (app faz polling enquanto espera a confirmação do Pix)
ordersRouter.get(
  '/orders/:orderId',
  wrap(async (req, res) => {
    const order = await loadOrder(req.params.orderId);
    const { rows: payments } = await query(
      `SELECT id, method, amount::float AS amount, status, psp_txid, created_at, paid_at
         FROM payment WHERE order_id = $1 ORDER BY id`,
      [order.id],
    );
    res.json({ ...order, items: await orderItems(order.id), payments });
  }),
);
