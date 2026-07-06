import { Router } from 'express';
import { withTransaction } from '../db.js';
import { badRequest, wrap } from '../errors.js';
import { config } from '../config.js';

export const webhooksRouter = Router();

// Confirmação de pagamento vinda do PSP (Pix). Regras críticas da pesquisa:
// - o pedido SÓ conclui aqui, nunca no clique do cliente;
// - idempotente: o PSP pode reenviar o evento sem cobrar/baixar duas vezes;
// - baixa de estoque atômica (mesma transação da confirmação).
webhooksRouter.post(
  '/webhooks/psp',
  wrap(async (req, res) => {
    if (
      config.pspWebhookSecret &&
      req.get('x-webhook-secret') !== config.pspWebhookSecret
    ) {
      return res.status(401).json({ error: 'assinatura inválida' });
    }

    const { txid, status } = req.body ?? {};
    if (!txid || !status) throw badRequest('txid e status são obrigatórios');
    if (!['pago', 'expirado', 'cancelado'].includes(status))
      throw badRequest('status deve ser pago, expirado ou cancelado');

    const result = await withTransaction(async (client) => {
      const { rows: payments } = await client.query(
        `SELECT id, order_id, status, amount::float AS amount
           FROM payment WHERE psp_txid = $1 FOR UPDATE`,
        [txid],
      );
      // txid desconhecido: 200 mesmo assim para o PSP não reenviar eternamente
      if (payments.length === 0) return { received: true, known: false };
      const payment = payments[0];

      // Reentrega do mesmo evento → no-op (idempotência)
      if (payment.status !== 'pendente')
        return { received: true, duplicate: true, payment_status: payment.status };

      if (status !== 'pago') {
        await client.query(`UPDATE payment SET status = $2 WHERE id = $1`, [
          payment.id,
          status,
        ]);
        return { received: true, payment_status: status };
      }

      await client.query(
        `UPDATE payment SET status = 'pago', paid_at = now() WHERE id = $1`,
        [payment.id],
      );

      const { rows: items } = await client.query(
        `SELECT oi.product_id, oi.qty, o.store_id
           FROM order_item oi
           JOIN orders o ON o.id = oi.order_id
          WHERE oi.order_id = $1`,
        [payment.order_id],
      );

      const lowStock = [];
      for (const item of items) {
        const { rows } = await client.query(
          `UPDATE store_product
              SET qty = qty - $3
            WHERE store_id = $1 AND product_id = $2
            RETURNING qty, min_qty`,
          [item.store_id, item.product_id, item.qty],
        );
        await client.query(
          `INSERT INTO stock_movement (store_id, product_id, type, qty, order_id)
           VALUES ($1, $2, 'sale', $3, $4)`,
          [item.store_id, item.product_id, -item.qty, payment.order_id],
        );
        if (rows.length > 0 && rows[0].qty <= rows[0].min_qty) {
          lowStock.push({ product_id: item.product_id, qty: rows[0].qty });
        }
      }

      await client.query(
        `UPDATE orders SET status = 'concluido', paid_at = now() WHERE id = $1`,
        [payment.order_id],
      );

      return {
        received: true,
        order_id: payment.order_id,
        order_status: 'concluido',
        low_stock_alerts: lowStock,
      };
    });

    if (result.low_stock_alerts?.length) {
      // MVP: alerta via log; a lista completa fica em GET /stores/:id/restock-list
      console.warn(
        `[estoque] loja com itens no mínimo após pedido ${result.order_id}:`,
        result.low_stock_alerts,
      );
    }
    res.json(result);
  }),
);
