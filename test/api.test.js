// Teste de ponta a ponta do fluxo da Fase 1:
// catálogo → scan → pedido → Pix → webhook → baixa de estoque → dashboard.
// Requer PostgreSQL acessível (DATABASE_URL); recria o esquema ao iniciar.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PSP_WEBHOOK_SECRET = 'segredo-de-teste';

const { initDb } = await import('../scripts/init-db.js');
const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');

let server;
let baseUrl;

const api = async (method, path, body, headers = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const webhook = (body, secret = 'segredo-de-teste') =>
  api('POST', '/webhooks/psp', body, { 'x-webhook-secret': secret });

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
  coca: '7894900011517', // qty 24, min 6, R$ 5,50
  doritos: '7892840812850', // qty 15, min 5, R$ 9,90
  biscoito: '7891079000021', // qty 5, min 4, R$ 4,50 → 1 venda dispara alerta
  papel: '7896004000501', // qty 8, min 2
  banana: '2000000000017', // kg, qty 12.5, min 3, R$ 6,90/kg
};

test('catálogo da loja lista produtos com preço e disponibilidade', async () => {
  const { status, body } = await api('GET', '/stores/1/catalog');
  assert.equal(status, 200);
  assert.equal(body.products.length, 10);
  const coca = body.products.find((p) => p.ean === EAN.coca);
  assert.equal(coca.price, 5.5);
  assert.equal(coca.available, 24);
  assert.equal(coca.unit_type, 'un');
  const banana = body.products.find((p) => p.ean === EAN.banana);
  assert.equal(banana.unit_type, 'kg');
  assert.equal(banana.available, 12.5);
});

test('scan de EAN resolve produto na loja', async () => {
  const { status, body } = await api('GET', `/stores/1/products/ean/${EAN.doritos}`);
  assert.equal(status, 200);
  assert.equal(body.name, 'Salgadinho Doritos 84g');
  const missing = await api('GET', '/stores/1/products/ean/0000000000000');
  assert.equal(missing.status, 404);
});

let orderId;
let txid;

test('fluxo completo: carrinho → Pix → webhook → estoque → dashboard', async (t) => {
  await t.test('cria pedido aberto', async () => {
    const { status, body } = await api('POST', '/orders', {
      store_id: 1,
      customer_id: 1,
    });
    assert.equal(status, 201);
    assert.equal(body.status, 'aberto');
    orderId = body.id;
  });

  await t.test('adiciona itens por scan e calcula total', async () => {
    await api('POST', `/orders/${orderId}/items`, { ean: EAN.coca, qty: 2 });
    await api('POST', `/orders/${orderId}/items`, { ean: EAN.doritos });
    const { status, body } = await api('POST', `/orders/${orderId}/items`, {
      ean: EAN.biscoito,
    });
    assert.equal(status, 201);
    assert.equal(body.total, 2 * 5.5 + 9.9 + 4.5); // 25.40
    assert.equal(body.items.length, 3);
  });

  await t.test('gera cobrança Pix dinâmica e é idempotente', async () => {
    const first = await api('POST', `/orders/${orderId}/pay`);
    assert.equal(first.status, 201);
    assert.equal(first.body.status, 'pendente');
    assert.match(first.body.qr_payload, /^000201/);
    assert.ok(first.body.qr_payload.includes('br.gov.bcb.pix'));
    txid = first.body.psp_txid;

    const again = await api('POST', `/orders/${orderId}/pay`);
    assert.equal(again.body.psp_txid, txid, 'repetir /pay não cria nova cobrança');
  });

  await t.test('webhook sem segredo é rejeitado', async () => {
    const { status } = await webhook({ txid, status: 'pago' }, 'errado');
    assert.equal(status, 401);
  });

  await t.test('webhook confirma pagamento e baixa estoque atomicamente', async () => {
    const { status, body } = await webhook({ txid, status: 'pago' });
    assert.equal(status, 200);
    assert.equal(body.order_status, 'concluido');
    // biscoito caiu para 4 (== min_qty) → entra no alerta de reposição
    assert.ok(body.low_stock_alerts.length >= 1);

    const order = await api('GET', `/orders/${orderId}`);
    assert.equal(order.body.status, 'concluido');
    assert.equal(order.body.payments[0].status, 'pago');

    const coca = await api('GET', `/stores/1/products/ean/${EAN.coca}`);
    assert.equal(coca.body.available, 22);
  });

  await t.test('reentrega do webhook não baixa estoque de novo', async () => {
    const { body } = await webhook({ txid, status: 'pago' });
    assert.equal(body.duplicate, true);
    const coca = await api('GET', `/stores/1/products/ean/${EAN.coca}`);
    assert.equal(coca.body.available, 22);
  });

  await t.test('pedido concluído não aceita mais itens', async () => {
    const { status } = await api('POST', `/orders/${orderId}/items`, {
      ean: EAN.coca,
    });
    assert.equal(status, 409);
  });

  await t.test('restock-list aponta o biscoito e reposição o remove', async () => {
    const list = await api('GET', '/stores/1/restock-list');
    const alert = list.body.items.find((i) => i.ean === EAN.biscoito);
    assert.ok(alert, 'biscoito deveria estar na lista de reposição');
    assert.equal(alert.qty, 4);

    const restock = await api('POST', '/stores/1/restock', {
      items: [{ product_id: alert.product_id, qty: 10 }],
    });
    assert.equal(restock.status, 201);
    assert.equal(restock.body.updated[0].qty, 14);

    const after = await api('GET', '/stores/1/restock-list');
    assert.ok(!after.body.items.some((i) => i.ean === EAN.biscoito));
  });

  await t.test('dashboard reflete a venda', async () => {
    const { body } = await api('GET', '/stores/1/dashboard');
    assert.equal(body.orders, 1);
    assert.equal(body.revenue, 25.4);
    assert.equal(body.avg_ticket, 25.4);
    assert.equal(body.top_products[0].ean, EAN.coca);
    assert.equal(body.top_products[0].units_sold, 2);
  });
});

test('não deixa adicionar além do estoque disponível', async () => {
  const order = await api('POST', '/orders', { store_id: 1, customer_id: 2 });
  const { status, body } = await api('POST', `/orders/${order.body.id}/items`, {
    ean: EAN.papel,
    qty: 9, // só há 8
  });
  assert.equal(status, 409);
  assert.match(body.error, /estoque insuficiente/);
});

test('pagar pedido vazio é rejeitado', async () => {
  const order = await api('POST', '/orders', { store_id: 1, customer_id: 2 });
  const { status } = await api('POST', `/orders/${order.body.id}/pay`);
  assert.equal(status, 400);
});

test('inventário ajusta estoque e registra a diferença', async () => {
  const doritos = await api('GET', `/stores/1/products/ean/${EAN.doritos}`);
  const { status, body } = await api('POST', '/stores/1/inventory', {
    items: [{ product_id: doritos.body.id, counted_qty: 10, loss: true }],
    reason: 'quebra identificada na contagem',
  });
  assert.equal(status, 201);
  assert.equal(body.adjustments[0].delta, 10 - doritos.body.available);
  const after = await api('GET', `/stores/1/products/ean/${EAN.doritos}`);
  assert.equal(after.body.available, 10);
});

test('produto pesável: compra por peso baixa estoque em kg', async () => {
  const order = await api('POST', '/orders', { store_id: 1, customer_id: 2 });
  const orderId = order.body.id;

  const add = await api('POST', `/orders/${orderId}/items`, {
    ean: EAN.banana,
    qty: 1.5,
  });
  assert.equal(add.status, 201);
  const item = add.body.items.find((i) => i.ean === EAN.banana);
  assert.equal(item.unit_type, 'kg');
  assert.equal(item.qty, 1.5);
  assert.equal(item.subtotal, 10.35);

  const pay = await api('POST', `/orders/${orderId}/pay`);
  const wh = await webhook({ txid: pay.body.psp_txid, status: 'pago' });
  assert.equal(wh.body.order_status, 'concluido');

  const banana = await api('GET', `/stores/1/products/ean/${EAN.banana}`);
  assert.equal(banana.body.available, 12.5 - 1.5);
});

test('produto por unidade rejeita peso fracionário', async () => {
  const order = await api('POST', '/orders', { store_id: 1, customer_id: 2 });
  const { status, body } = await api('POST', `/orders/${order.body.id}/items`, {
    ean: EAN.coca,
    qty: 1.5,
  });
  assert.equal(status, 400);
  assert.match(body.error, /unidade/);
});

test('cancela pedido aberto e a cobrança Pix pendente', async () => {
  const order = await api('POST', '/orders', { store_id: 1, customer_id: 2 });
  const orderId = order.body.id;
  await api('POST', `/orders/${orderId}/items`, { ean: EAN.coca, qty: 1 });
  const pay = await api('POST', `/orders/${orderId}/pay`);
  const txid = pay.body.psp_txid;

  const cancel = await api('POST', `/orders/${orderId}/cancel`);
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.status, 'cancelado');

  const check = await api('GET', `/orders/${orderId}`);
  assert.equal(check.body.status, 'cancelado');
  assert.equal(check.body.payments[0].status, 'cancelado');

  // pedido cancelado não aceita mais itens
  const addAfter = await api('POST', `/orders/${orderId}/items`, { ean: EAN.coca });
  assert.equal(addAfter.status, 409);

  // não pode cancelar de novo
  const cancelAgain = await api('POST', `/orders/${orderId}/cancel`);
  assert.equal(cancelAgain.status, 409);

  // um webhook atrasado do PSP não revive o pedido cancelado
  const wh = await webhook({ txid, status: 'pago' });
  assert.equal(wh.body.duplicate, true);
  const stillCancelled = await api('GET', `/orders/${orderId}`);
  assert.equal(stillCancelled.body.status, 'cancelado');
});

test('encerra conta do cliente (soft-delete)', async () => {
  // usa o cliente 1: seu único pedido em testes anteriores já foi concluído,
  // então ele começa esta suíte sem carrinhos abertos pendentes.
  const openOrder = await api('POST', '/orders', { store_id: 1, customer_id: 1 });

  const blocked = await api('POST', '/customers/1/close');
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /pedido em aberto/);

  await api('POST', `/orders/${openOrder.body.id}/cancel`);

  const closed = await api('POST', '/customers/1/close');
  assert.equal(closed.status, 200);
  assert.equal(closed.body.status, 'encerrado');

  // idempotente: encerrar de novo não dá erro
  const closedAgain = await api('POST', '/customers/1/close');
  assert.equal(closedAgain.status, 200);
  assert.equal(closedAgain.body.status, 'encerrado');

  // conta encerrada não consegue abrir pedido novo
  const newOrder = await api('POST', '/orders', { store_id: 1, customer_id: 1 });
  assert.equal(newOrder.status, 404);

  const missing = await api('POST', '/customers/9999/close');
  assert.equal(missing.status, 404);
});
