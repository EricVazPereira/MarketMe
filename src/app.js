import express from 'express';
import { catalogRouter } from './routes/catalog.js';
import { ordersRouter } from './routes/orders.js';
import { webhooksRouter } from './routes/webhooks.js';
import { stockRouter } from './routes/stock.js';
import { dashboardRouter } from './routes/dashboard.js';
import { customersRouter } from './routes/customers.js';
import { HttpError } from './errors.js';
import { config } from './config.js';

export function createApp() {
  const app = express();
  app.use(express.json());

  // CORS liberado: o app Android/PWA acessa a API de outra origem
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.set(
      'Access-Control-Allow-Headers',
      'content-type,x-webhook-secret,authorization',
    );
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Autenticação básica opcional (API_USER/API_PASS no .env). Isentos:
  // /health (monitoramento) e /webhooks/psp (o PSP autentica pelo
  // segredo próprio x-webhook-secret, não por usuário/senha).
  if (config.apiAuth.user) {
    const expected =
      'Basic ' +
      Buffer.from(`${config.apiAuth.user}:${config.apiAuth.pass}`).toString(
        'base64',
      );
    app.use((req, res, next) => {
      if (req.path === '/health' || req.path === '/webhooks/psp') return next();
      if (req.get('authorization') === expected) return next();
      res.set('WWW-Authenticate', 'Basic realm="MarketMe"');
      res.status(401).json({ error: 'autenticação necessária' });
    });
  }

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
