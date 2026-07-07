// Teste de ponta a ponta do conector (fase Firebird direto):
// EMPRESA/PRODUTO vêm de um Firebird real; pedidos/pagamentos do
// PostgreSQL local. Requer os dois bancos acessíveis.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PSP_WEBHOOK_SECRET = 'segredo-de-teste';
// suíte roda com autenticação básica ligada
process.env.API_USER = 'admin-teste';
process.env.API_PASS = 'senha-teste';
// Firebird de teste (mesma estrutura do ERP: EMPRESA + PRODUTO)
process.env.FIREBIRD_DATABASE = '/var/lib/firebird/3.0/data/orestra.fdb';
process.env.FIREBIRD_HOST = '127.0.0.1';
process.env.FIREBIRD_USER = 'POINTER';
process.env.FIREBIRD_PASSWORD = 'sysadmin';

const { initDb } = await import('../scripts/init-db.js');
const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');

let server;
let baseUrl;

const AUTH =
  'Basic ' + Buffer.from('admin-teste:senha-teste').toString('base64');

const api = async (method, path, body, headers = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: AUTH, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const webhook = (body, secret = 'segredo-de-teste') =>
  api('POST', '/webhooks/psp', body, {
    'x-webhook-secret': secret,
    authorization: '',
  });

before(async () => {
  await initDb({ seed: true, reset: true });
  server = createApp().listen(0);
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  server?.close();
  await pool.end();
});

const EAN = {
  coca: '7894900011517', // R$ 5,50 no cadastro do ERP
  doritos: '7892840812850', // R$ 9,90
  banana: '2000001000000', // pesável, R$ 6,90/kg
};

test('lojas vêm da tabela EMPRESA do ERP (Nome Fantasia)', async () => {
  const { status, body } = await api('GET', '/stores');
  assert.equal(status, 200);
  assert.equal(body.stores.length, 1);
  assert.equal(body.stores[0].id, 1);
  assert.equal(body.stores[0].name, 'Mercadinho do Condominio');
});

test('catálogo lista o cadastro de produtos do ERP', async () => {
  const { status, body } = await api('GET', '/stores/1/catalog');
  assert.equal(status, 200);
  assert.equal(body.products.length, 5);
  const coca = body.products.find((p) => p.ean === EAN.coca);
  assert.equal(coca.price, 5.5);
  assert.equal(coca.name, 'REFRIGERANTE COCA-COLA LATA 350ML');
});

test('scan resolve o EAN no cadastro do ERP', async () => {
  const { status, body } = await api('GET', `/stores/1/products/ean/${EAN.doritos}`);
  assert.equal(status, 200);
  assert.equal(body.name, 'SALGADINHO DORITOS 84G');
  assert.equal(body.price, 9.9);
  const missing = await api('GET', '/stores/1/products/ean/0000000000000');
  assert.equal(missing.status, 404);
});

test('x-db-path inválido gera erro claro de conexão (502)', async () => {
  const { status, body } = await api('GET', '/stores', undefined, {
    'x-db-path': '/caminho/errado.fdb',
  });
  assert.equal(status, 502);
  assert.match(body.error, /Firebird/);
});

test('fluxo completo: carrinho → Pix → webhook → concluído', async (t) => {
  let orderId;
  let txid;

  await t.test('cria pedido validando a EMPRESA no ERP', async () => {
    const bad = await api('POST', '/orders', { store_id: 99, customer_id: 1 });
    assert.equal(bad.status, 404);
    const { status, body } = await api('POST', '/orders', {
      store_id: 1,
      customer_id: 1,
    });
    assert.equal(status, 201);
    assert.equal(body.status, 'aberto');
    orderId = body.id;
  });

  await t.test('scan grava snapshot com preço do cadastro', async () => {
    await api('POST', `/orders/${orderId}/items`, { ean: EAN.coca, qty: 2 });
    const { status, body } = await api('POST', `/orders/${orderId}/items`, {
      ean: EAN.doritos,
    });
    assert.equal(status, 201);
    assert.equal(body.total, 2 * 5.5 + 9.9); // 20.90
    const coca = body.items.find((i) => i.ean === EAN.coca);
    assert.equal(coca.unit_price, 5.5);
    assert.equal(coca.product_code, '101');
  });

  await t.test('cancela item do carrinho', async () => {
    await api('POST', `/orders/${orderId}/items`, { ean: EAN.banana, qty: 1.5 });
    const { body: withBanana } = await api('GET', `/orders/${orderId}`);
    assert.equal(withBanana.items.length, 3);

    const { status, body } = await api(
      'DELETE',
      `/orders/${orderId}/items/105`, // código da banana no ERP
    );
    assert.equal(status, 200);
    assert.equal(body.items.length, 2);
    assert.equal(body.total, 20.9);
  });

  await t.test('gera cobrança Pix dinâmica e é idempotente', async () => {
    const first = await api('POST', `/orders/${orderId}/pay`);
    assert.equal(first.status, 201);
    assert.match(first.body.qr_payload, /^000201/);
    txid = first.body.psp_txid;
    const again = await api('POST', `/orders/${orderId}/pay`);
    assert.equal(again.body.psp_txid, txid);
  });

  await t.test('webhook confirma e conclui o pedido (idempotente)', async () => {
    const bad = await webhook({ txid, status: 'pago' }, 'errado');
    assert.equal(bad.status, 401);

    const { status, body } = await webhook({ txid, status: 'pago' });
    assert.equal(status, 200);
    assert.equal(body.order_status, 'concluido');

    const dup = await webhook({ txid, status: 'pago' });
    assert.equal(dup.body.duplicate, true);

    const order = await api('GET', `/orders/${orderId}`);
    assert.equal(order.body.status, 'concluido');
  });

  await t.test('pedido concluído não aceita mais itens', async () => {
    const { status } = await api('POST', `/orders/${orderId}/items`, {
      ean: EAN.coca,
    });
    assert.equal(status, 409);
  });

  await t.test('dashboard reflete a venda', async () => {
    const { body } = await api('GET', '/stores/1/dashboard');
    assert.equal(body.orders, 1);
    assert.equal(body.revenue, 20.9);
    assert.equal(body.top_products[0].ean, EAN.coca);
    assert.equal(body.top_products[0].units_sold, 2);
  });
});

test('cancelar a conta descarta o pedido e a cobrança pendente', async () => {
  const order = await api('POST', '/orders', { store_id: 1, customer_id: 2 });
  const orderId = order.body.id;
  await api('POST', `/orders/${orderId}/items`, { ean: EAN.coca });
  const pay = await api('POST', `/orders/${orderId}/pay`);

  const { status, body } = await api('POST', `/orders/${orderId}/cancel`);
  assert.equal(status, 200);
  assert.equal(body.status, 'cancelado');

  // webhook do Pix cancelado chega depois → no-op idempotente
  const wh = await webhook({ txid: pay.body.psp_txid, status: 'pago' });
  assert.equal(wh.body.duplicate, true);
  const after = await api('GET', `/orders/${orderId}`);
  assert.equal(after.body.status, 'cancelado');
});

test('modo balança: prefixo resolve o produto pesável no ERP', async () => {
  const { status, body } = await api('GET', '/stores/1/products/scale/2000001');
  assert.equal(status, 200);
  assert.equal(body.ean, EAN.banana);
  assert.equal(body.unit_type, 'kg');
  const missing = await api('GET', '/stores/1/products/scale/2999999');
  assert.equal(missing.status, 404);
});

test('peso fracionado vira item em kg', async () => {
  const order = await api('POST', '/orders', { store_id: 1, customer_id: 1 });
  const { body } = await api('POST', `/orders/${order.body.id}/items`, {
    ean: EAN.banana,
    qty: 1.5,
  });
  const item = body.items[0];
  assert.equal(item.unit_type, 'kg');
  assert.equal(item.subtotal, 10.35); // 1,5 kg × 6,90
});

test('encerrar conta do cliente impede novos pedidos', async () => {
  const closed = await api('POST', '/customers/2/close');
  assert.equal(closed.status, 200);
  assert.equal(closed.body.status, 'encerrado');
  const order = await api('POST', '/orders', { store_id: 1, customer_id: 2 });
  assert.equal(order.status, 404);
});

test('autenticação básica: sem credenciais só passa /health e webhook', async () => {
  const noAuth = await api('GET', '/stores', undefined, { authorization: '' });
  assert.equal(noAuth.status, 401);
  const health = await api('GET', '/health', undefined, { authorization: '' });
  assert.equal(health.status, 200);
  const wh = await webhook({ txid: 'INEXISTENTE', status: 'pago' });
  assert.equal(wh.status, 200);
  assert.equal(wh.body.known, false);
});
