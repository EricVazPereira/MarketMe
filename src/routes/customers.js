import { Router } from 'express';
import { withTransaction } from '../db.js';
import { conflict, notFound, wrap } from '../errors.js';

export const customersRouter = Router();

// Encerra a conta do morador (soft-delete). Recusa se houver pedido em
// aberto — o cliente precisa finalizar ou cancelar o carrinho primeiro.
// Idempotente: encerrar uma conta já encerrada só devolve o estado atual.
customersRouter.post(
  '/customers/:id/close',
  wrap(async (req, res) => {
    const { id } = req.params;
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT id, name, status FROM customer WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (rows.length === 0) throw notFound('cliente não encontrado');
      if (rows[0].status === 'encerrado') return rows[0];

      const { rows: openOrders } = await client.query(
        `SELECT id FROM orders WHERE customer_id = $1 AND status = 'aberto'`,
        [id],
      );
      if (openOrders.length > 0)
        throw conflict(
          'cancele ou finalize o pedido em aberto antes de encerrar a conta',
        );

      const { rows: updated } = await client.query(
        `UPDATE customer SET status = 'encerrado' WHERE id = $1
         RETURNING id, name, status`,
        [id],
      );
      return updated[0];
    });
    res.json(result);
  }),
);
