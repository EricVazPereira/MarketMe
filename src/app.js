import express from 'express';
import { catalogRouter } from './routes/catalog.js';
import { ordersRouter } from './routes/orders.js';
import { webhooksRouter } from './routes/webhooks.js';
import { stockRouter } from './routes/stock.js';
import { dashboardRouter } from './routes/dashboard.js';
import { customersRouter } from './routes/customers.js';
import { HttpError } from './errors.js';

export function createApp() {
  const app = express();
  app.use(express.json());

  // CORS liberado: o app Android/PWA acessa a API de outra origem
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'content-type,x-webhook-secret');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use(catalogRouter);
  app.use(ordersRouter);
  app.use(webhooksRouter);
  app.use(stockRouter);
  app.use(dashboardRouter);
  app.use(customersRouter);

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
