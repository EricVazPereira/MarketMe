import { Router } from 'express';
import { query } from '../db.js';
import { badRequest, wrap } from '../errors.js';

export const dashboardRouter = Router();

// Dashboard por loja: faturamento, pedidos, ticket médio e top produtos
// (a partir do snapshot dos itens vendidos pelo app).
// Filtro opcional por período: ?from=2026-07-01&to=2026-07-31
dashboardRouter.get(
  '/stores/:storeId/dashboard',
  wrap(async (req, res) => {
    const { storeId } = req.params;
    const { from, to } = req.query;
    if ((from && isNaN(Date.parse(from))) || (to && isNaN(Date.parse(to))))
      throw badRequest('from/to devem ser datas válidas (ISO 8601)');

    const period = `o.paid_at >= COALESCE($2::timestamptz, '-infinity')
                AND o.paid_at <  COALESCE($3::timestamptz, 'infinity')`;

    const { rows: summary } = await query(
      `SELECT COUNT(*)::int AS orders,
              COALESCE(SUM(o.total), 0)::float AS revenue,
              COALESCE(AVG(o.total), 0)::float AS avg_ticket
         FROM orders o
        WHERE o.store_id = $1 AND o.status = 'concluido' AND ${period}`,
      [storeId, from ?? null, to ?? null],
    );

    const { rows: topProducts } = await query(
      `SELECT oi.product_code, oi.ean, oi.name, oi.unit_type,
              SUM(oi.qty)::float AS units_sold,
              SUM(oi.qty * oi.unit_price)::float AS revenue
         FROM order_item oi
         JOIN orders o ON o.id = oi.order_id
        WHERE o.store_id = $1 AND o.status = 'concluido' AND ${period}
        GROUP BY oi.product_code, oi.ean, oi.name, oi.unit_type
        ORDER BY units_sold DESC, revenue DESC
        LIMIT 10`,
      [storeId, from ?? null, to ?? null],
    );

    res.json({
      store: { id: Number(storeId) },
      period: { from: from ?? null, to: to ?? null },
      ...summary[0],
      top_products: topProducts,
    });
  }),
);
