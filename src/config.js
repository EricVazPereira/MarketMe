import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  // PostgreSQL local do conector: guarda pedidos/pagamentos do MarketMe.
  // (Cadastros de empresa e produto vêm do Firebird do ERP — abaixo.)
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgres://marketme_app:troque-esta-senha@localhost:5432/marketme',

  // Firebird do ERP (acesso direto nesta fase; vira API na próxima).
  // O caminho do .fdb pode ser sobrescrito por requisição via header
  // x-db-path (campo "diretório do banco de dados" no app).
  firebird: {
    host: process.env.FIREBIRD_HOST ?? '127.0.0.1',
    port: Number(process.env.FIREBIRD_PORT ?? 3050),
    database: process.env.FIREBIRD_DATABASE ?? 'D:\\marketme\\bd\\orestra.fdb',
    user: process.env.FIREBIRD_USER ?? 'POINTER',
    password: process.env.FIREBIRD_PASSWORD ?? 'sysadmin',
  },

  // Mapeamento das tabelas/campos do ERP (ajuste no .env se os nomes
  // no seu orestra.fdb forem outros)
  erp: {
    empresaTable: process.env.FB_EMPRESA_TABLE ?? 'EMPRESA',
    empresaId: process.env.FB_EMPRESA_ID ?? 'CODIGO',
    empresaFantasia: process.env.FB_EMPRESA_FANTASIA ?? 'NOME_FANTASIA',
    produtoTable: process.env.FB_PRODUTO_TABLE ?? 'PRODUTO',
    produtoCodigo: process.env.FB_PRODUTO_CODIGO ?? 'CODIGO',
    produtoEan: process.env.FB_PRODUTO_EAN ?? 'CODIGO_BARRA',
    produtoNome: process.env.FB_PRODUTO_NOME ?? 'DESCRICAO',
    produtoPreco: process.env.FB_PRODUTO_PRECO ?? 'PRECO_VENDA',
  },

  pix: {
    key: process.env.PIX_KEY ?? 'marketme@example.com',
    merchantName: process.env.PIX_MERCHANT_NAME ?? 'MARKETME',
    merchantCity: process.env.PIX_MERCHANT_CITY ?? 'SAO PAULO',
  },
  pspWebhookSecret: process.env.PSP_WEBHOOK_SECRET ?? '',
  // Autenticação básica das APIs (opcional): defina API_USER e API_PASS
  // no .env do servidor para exigir usuário/senha em todas as rotas
  apiAuth: {
    user: process.env.API_USER ?? '',
    pass: process.env.API_PASS ?? '',
  },
};
