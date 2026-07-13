import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { config } from '../config.js';
import { fbQuery, fbText, ident } from '../firebird.js';
import { badRequest, conflict, notFound, wrap } from '../errors.js';
import { buildBrCode, generateTxid } from '../services/pix.js';

export const ordersRouter = Router();

const erp = config.erp;
const dbPath = (req) => req.get('x-db-path') || undefined;

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
    `SELECT oi.product_code, oi.ean, oi.name, oi.unit_type,
            oi.qty::float AS qty, oi.unit_price::float AS unit_price,
            (oi.qty * oi.unit_price)::float AS subtotal
       FROM order_item oi
      WHERE oi.order_id = $1
      ORDER BY oi.name`,
    [orderId],
  );
  return rows;
}

const recomputeTotal = (client, orderId) =>
  client.query(
    `UPDATE orders o SET total = (
       SELECT COALESCE(SUM(qty * unit_price), 0)
         FROM order_item WHERE order_id = o.id
     ) WHERE o.id = $1`,
    [orderId],
  );

// Abre um pedido (carrinho) na loja (= EMPRESA do ERP)
ordersRouter.post(
  '/orders',
  wrap(async (req, res) => {
    const { store_id, customer_id } = req.body ?? {};
    if (!store_id || !customer_id)
      throw badRequest('store_id e customer_id são obrigatórios');

    const empresa = await fbQuery(
      `SELECT FIRST 1 ${ident(erp.empresaId)} AS ID
         FROM ${ident(erp.empresaTable)} WHERE ${ident(erp.empresaId)} = ?`,
      [store_id],
      dbPath(req),
    );
    if (empresa.length === 0)
      throw notFound('empresa não encontrada no banco do ERP');

    const customer = await query(
      `SELECT id FROM customer WHERE id = $1 AND status = 'ativo'`,
      [customer_id],
    );
    if (customer.rowCount === 0)
      throw notFound('cliente não encontrado ou conta encerrada');

    const { rows } = await query(
      `INSERT INTO orders (store_id, customer_id)
       VALUES ($1, $2)
       RETURNING id, store_id, customer_id, status, total::float AS total, created_at`,
      [store_id, customer_id],
    );
    res.status(201).json(rows[0]);
  }),
);

// Scan de EAN: busca o produto no cadastro do ERP (Firebird) e grava o
// item com o preço do cadastro (snapshot). qty inteira para unidade;
// fracionada quando vem de balança/pesagem (tratada como kg).
ordersRouter.post(
  '/orders/:orderId/items',
  wrap(async (req, res) => {
    const { orderId } = req.params;
    const { ean, qty = 1 } = req.body ?? {};
    if (!ean) throw badRequest('ean é obrigatório');
    const addQty = Number(qty);
    if (!Number.isFinite(addQty) || addQty <= 0)
      throw badRequest('qty deve ser um número > 0');

    const found = await fbQuery(
      `SELECT FIRST 1 ${ident(erp.produtoCodigo)} AS CODE,
              ${ident(erp.produtoEan)} AS EAN,
              ${ident(erp.produtoNome)} AS PNAME,
              ${ident(erp.produtoPreco)} AS PRICE
         FROM ${ident(erp.produtoTable)}
        WHERE ${ident(erp.produtoEan)} = ?`,
      [ean],
      dbPath(req),
    );
    if (found.length === 0)
      throw notFound('produto não encontrado no cadastro do ERP');
    const product = {
      code: String(found[0].CODE),
      ean: fbText(found[0].EAN),
      name: fbText(found[0].PNAME),
      price: Number(found[0].PRICE),
    };
    if (!(product.price >= 0))
      throw conflict('produto sem preço de venda no cadastro do ERP');

    const order = await withTransaction(async (client) => {
      const ord = await loadOrder(orderId, client);
      if (ord.status !== 'aberto')
        throw conflict(`pedido não está aberto (status: ${ord.status})`);

      await client.query(
        `INSERT INTO order_item (order_id, product_code, ean, name, unit_type, qty, unit_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (order_id, product_code)
         DO UPDATE SET qty = order_item.qty + EXCLUDED.qty`,
        [
          orderId,
          product.code,
          product.ean,
          product.name,
          Number.isInteger(addQty) ? 'un' : 'kg',
          addQty,
          product.price,
        ],
      );
      await recomputeTotal(client, orderId);
      return loadOrder(orderId, client);
    });

    res.status(201).json({ ...order, items: await orderItems(orderId) });
  }),
);

// Cancela (remove) um item do carrinho
ordersRouter.delete(
  '/orders/:orderId/items/:productCode',
  wrap(async (req, res) => {
    const { orderId, productCode } = req.params;
    const order = await withTransaction(async (client) => {
      const ord = await loadOrder(orderId, client);
      if (ord.status !== 'aberto')
        throw conflict(`pedido não está aberto (status: ${ord.status})`);
      const del = await client.query(
        `DELETE FROM order_item WHERE order_id = $1 AND product_code = $2`,
        [orderId, productCode],
      );
      if (del.rowCount === 0) throw notFound('item não está no carrinho');
      await recomputeTotal(client, orderId);
      return loadOrder(orderId, client);
    });
    res.json({ ...order, items: await orderItems(orderId) });
  }),
);

// Cancela a conta/pedido inteiro (e a cobrança Pix pendente, se houver).
// A checagem final é condicional (WHERE status = 'aberto') para não
// sobrescrever um pedido que a confirmação do PSP tenha concluído
// concorrentemente enquanto o cliente cancelava.
ordersRouter.post(
  '/orders/:orderId/cancel',
  wrap(async (req, res) => {
    const { orderId } = req.params;
    const order = await withTransaction(async (client) => {
      const ord = await loadOrder(orderId, client);
      if (ord.status !== 'aberto')
        throw conflict(`só é possível cancelar pedido aberto (status: ${ord.status})`);

      await client.query(
        `UPDATE payment SET status = 'cancelado'
          WHERE order_id = $1 AND status = 'pendente'`,
        [orderId],
      );
      const { rowCount } = await client.query(
        `UPDATE orders SET status = 'cancelado' WHERE id = $1 AND status = 'aberto'`,
        [orderId],
      );
      if (rowCount === 0)
        throw conflict('pedido foi confirmado por um pagamento durante o cancelamento');
      return loadOrder(orderId, client);
    });
    res.json({ ...order, items: await orderItems(order.id) });
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
