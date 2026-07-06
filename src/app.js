import express from 'express';
import { catalogRouter } from './routes/catalog.js';
import { ordersRouter } from './routes/orders.js';
import { webhooksRouter } from './routes/webhooks.js';
import { stockRouter } from './routes/stock.js';
import { dashboardRouter } from './routes/dashboard.js';
import { HttpError } from './errors.js';

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use(catalogRouter);
  app.use(ordersRouter);
  app.use(webhooksRouter);
  app.use(stockRouter);
  app.use(dashboardRouter);

  app.use((_req, res) => res.status(404).json({ error: 'rota não encontrada' }));

  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError)
      return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed')
      return res.status(400).json({ error: 'JSON inválido' });
    console.error(err);
    res.status(500).json({ error: 'erro interno' });
  });

  return app;
}
