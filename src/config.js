import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgres://pointer:sysadmin@localhost:5432/marketme',
  pix: {
    key: process.env.PIX_KEY ?? 'marketme@example.com',
    merchantName: process.env.PIX_MERCHANT_NAME ?? 'MARKETME',
    merchantCity: process.env.PIX_MERCHANT_CITY ?? 'SAO PAULO',
  },
  pspWebhookSecret: process.env.PSP_WEBHOOK_SECRET ?? '',
};
