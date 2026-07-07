import { Router } from 'express';
import { withTransaction } from '../db.js';
import { badRequest, wrap } from '../errors.js';
import { config } from '../config.js';

export const webhooksRouter = Router();

// Confirmação de pagamento vinda do PSP (Pix). Regras críticas:
// - o pedido SÓ conclui aqui, nunca no clique do cliente;
// - idempotente: o PSP pode reenviar o evento sem concluir duas vezes.
// Baixa de estoque não acontece aqui nesta fase: o estoque é do ERP.
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
        `SELECT id, order_id, status FROM payment WHERE psp_txid = $1 FOR UPDATE`,
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
      await client.query(
        `UPDATE orders SET status = 'concluido', paid_at = now() WHERE id = $1`,
        [payment.order_id],
      );
      return {
        received: true,
        order_id: payment.order_id,
        order_status: 'concluido',
      };
    });

    res.json(result);
  }),
);
