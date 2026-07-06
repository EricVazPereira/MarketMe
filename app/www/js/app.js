/* MarketMe — app do cliente (scan & pay)
 * SPA vanilla que consome a API do backend. Roda no WebView do APK
 * Android (file://) ou em qualquer navegador moderno. */
(() => {
  'use strict';

  // ---------- estado ----------
  const cfg = {
    get server() { return localStorage.getItem('mm.server') || ''; },
    set server(v) { localStorage.setItem('mm.server', v.replace(/\/+$/, '')); },
    get storeId() { return Number(localStorage.getItem('mm.store')) || 0; },
    set storeId(v) { localStorage.setItem('mm.store', v); },
    get storeName() { return localStorage.getItem('mm.storeName') || ''; },
    set storeName(v) { localStorage.setItem('mm.storeName', v); },
    get customerId() { return Number(localStorage.getItem('mm.customer')) || 0; },
    set customerId(v) { localStorage.setItem('mm.customer', v); },
    get apiUser() { return localStorage.getItem('mm.apiUser') || ''; },
    set apiUser(v) { localStorage.setItem('mm.apiUser', v); },
    get apiPass() { return localStorage.getItem('mm.apiPass') || ''; },
    set apiPass(v) { localStorage.setItem('mm.apiPass', v); },
    get scale() { return localStorage.getItem('mm.scale') === '1'; },
    set scale(v) { localStorage.setItem('mm.scale', v ? '1' : '0'); },
    get orderId() { return Number(localStorage.getItem('mm.order')) || 0; },
    set orderId(v) {
      if (v) localStorage.setItem('mm.order', v);
      else localStorage.removeItem('mm.order');
    },
  };

  let currentView = 'catalog';
  let scanner = null;
  let pollTimer = null;
  let lastScan = { ean: '', at: 0 };

  const $ = (sel) => document.querySelector(sel);
  const view = $('#view');
  const money = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- API ----------
  async function api(method, path, body) {
    if (!cfg.server) throw new Error('configure o endereço do servidor');
    const headers = {};
    if (body) headers['content-type'] = 'application/json';
    if (cfg.apiUser)
      headers.authorization = 'Basic ' + btoa(`${cfg.apiUser}:${cfg.apiPass}`);
    let res;
    try {
      res = await fetch(cfg.server + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error('sem conexão com o servidor');
    }
    if (res.status === 401)
      throw new Error('usuário/senha da API inválidos (veja Configurações)');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `erro ${res.status}`);
    return data;
  }

  // ---------- UI helpers ----------
  let toastTimer;
  function toast(msg, ms = 2200) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  }

  function setTitle(t) { $('#title').textContent = t; }

  // Modal em HTML puro: o WebView do APK não trata window.alert/confirm/
  // prompt (WebChromeClient não os sobrescreve), então essas chamadas
  // nativas não exibem nada — toda confirmação usa este overlay.
  function openModal(html) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-card">${html}</div>`;
    document.body.appendChild(overlay);
    return overlay;
  }
  const closeModal = (overlay) => overlay.remove();

  function formatPrice(p) {
    return p.unit_type === 'kg' ? `${money(p.price)}/kg` : money(p.price);
  }
  function formatAvailable(p) {
    return p.unit_type === 'kg'
      ? `${Number(p.available).toFixed(3)} kg disponíveis`
      : `${p.available} disponíveis`;
  }

  function updateBadge(order) {
    // conta produtos distintos no carrinho, não a soma das quantidades —
    // somar unidades com quilos (produto pesável) não faria sentido
    const badge = $('#cart-badge');
    const count = (order?.items || []).length;
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
  }

  async function stopScanner() {
    if (scanner) {
      try { await scanner.stop(); } catch { /* já parado */ }
      try { scanner.clear(); } catch { /* sem elemento */ }
      scanner = null;
    }
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // ---------- pedido ----------
  async function ensureOrder() {
    if (cfg.orderId) {
      try {
        const order = await api('GET', `/orders/${cfg.orderId}`);
        if (order.status === 'aberto') return order;
      } catch { /* pedido sumiu; cria outro */ }
      cfg.orderId = 0;
    }
    const order = await api('POST', '/orders', {
      store_id: cfg.storeId,
      customer_id: cfg.customerId,
    });
    cfg.orderId = order.id;
    return order;
  }

  async function currentOrder() {
    if (!cfg.orderId) return null;
    try {
      const order = await api('GET', `/orders/${cfg.orderId}`);
      if (order.status !== 'aberto') { cfg.orderId = 0; return null; }
      return order;
    } catch { cfg.orderId = 0; return null; }
  }

  async function addByEan(ean, qty = 1) {
    const order = await ensureOrder();
    const updated = await api('POST', `/orders/${order.id}/items`, { ean, qty });
    updateBadge(updated);
    const item = updated.items.find((i) => i.ean === ean);
    if (navigator.vibrate) navigator.vibrate(80);
    toast(`✔ ${item ? item.name : 'item'} — total ${money(updated.total)}`);
    return updated;
  }

  async function cancelOrder(orderId) {
    await api('POST', `/orders/${orderId}/cancel`);
    stopPolling();
    cfg.orderId = 0;
    updateBadge(null);
    toast('Pedido cancelado');
    switchView('catalog');
  }

  function confirmCancelOrder(orderId) {
    const overlay = openModal(`
      <h3>Cancelar pedido?</h3>
      <p class="muted">Os itens do carrinho serão descartados.</p>
      <button id="modal-confirm" class="primary" style="background:var(--danger);margin-top:14px">Sim, cancelar</button>
      <button id="modal-back" class="link" style="width:100%;margin-top:8px">Voltar</button>`);
    overlay.querySelector('#modal-confirm').onclick = async () => {
      closeModal(overlay);
      try { await cancelOrder(orderId); } catch (e) { toast(`⚠️ ${e.message}`); }
    };
    overlay.querySelector('#modal-back').onclick = () => closeModal(overlay);
  }

  function openWeightModal(product) {
    const overlay = openModal(`
      <h3>${esc(product.name)}</h3>
      <p class="muted">${money(product.price)} / kg</p>
      <label>Peso (kg)</label>
      <input id="modal-weight" type="number" inputmode="decimal" step="0.001" min="0.001" value="0.500">
      <button id="modal-confirm" class="primary" style="margin-top:14px">Adicionar ao carrinho</button>
      <button id="modal-back" class="link" style="width:100%;margin-top:8px">Cancelar</button>`);
    overlay.querySelector('#modal-confirm').onclick = async () => {
      const weight = Number(overlay.querySelector('#modal-weight').value);
      if (!(weight > 0)) return toast('Informe um peso válido');
      closeModal(overlay);
      try { await addByEan(product.ean, weight); } catch (e) { toast(`⚠️ ${e.message}`); }
    };
    overlay.querySelector('#modal-back').onclick = () => closeModal(overlay);
  }

  // ---------- telas ----------
  async function renderSettings(firstRun = false) {
    stopPolling();
    await stopScanner();
    setTitle('Configurações');
    view.innerHTML = `
      <div class="card">
        <label>Endereço do servidor (API)</label>
        <input id="in-server" type="url" placeholder="http://192.168.0.10:3000"
               value="${esc(cfg.server)}" autocapitalize="off">
        <label>Usuário da API (se o servidor exigir)</label>
        <input id="in-api-user" type="text" autocapitalize="off"
               placeholder="deixe vazio se não usar" value="${esc(cfg.apiUser)}">
        <label>Senha da API</label>
        <input id="in-api-pass" type="password" value="${esc(cfg.apiPass)}">
        <button id="btn-test" class="secondary" style="margin-top:12px">Buscar lojas</button>
        <label>Loja</label>
        <select id="in-store"><option value="">— busque as lojas acima —</option></select>
        <label>Nº do cliente (morador)</label>
        <input id="in-customer" type="number" min="1" value="${cfg.customerId || 1}">
        <label>Balança integrada (etiqueta com peso no código de barras)</label>
        <select id="in-scale">
          <option value="0" ${cfg.scale ? '' : 'selected'}>Não — pedir o peso na tela</option>
          <option value="1" ${cfg.scale ? 'selected' : ''}>Sim — ler o peso da etiqueta da balança</option>
        </select>
        <button id="btn-save" class="primary" style="margin-top:16px">Salvar e começar</button>
        ${firstRun ? '' : '<button id="btn-clear-order" class="link" style="margin-top:10px;width:100%">Abandonar carrinho atual</button>'}
      </div>
      <p class="muted center">MarketMe v0.1 — mercado autônomo do seu condomínio</p>
      <p class="muted center" style="margin-top:6px">O banco de dados é configurado no
        servidor (arquivo .env), nunca no app.</p>`;

    const storeSel = $('#in-store');
    const saveConn = () => {
      cfg.server = $('#in-server').value.trim();
      cfg.apiUser = $('#in-api-user').value.trim();
      cfg.apiPass = $('#in-api-pass').value;
    };
    const loadStores = async () => {
      saveConn();
      try {
        const { stores } = await api('GET', '/stores');
        storeSel.innerHTML = stores
          .map((s) => `<option value="${s.id}" ${s.id === cfg.storeId ? 'selected' : ''}>${esc(s.name)}</option>`)
          .join('');
        toast(`${stores.length} loja(s) encontrada(s)`);
      } catch (e) { toast(`Erro: ${e.message}`); }
    };
    $('#btn-test').onclick = loadStores;
    if (cfg.server) loadStores();

    $('#btn-save').onclick = () => {
      saveConn();
      const opt = storeSel.selectedOptions[0];
      if (!cfg.server || !opt || !opt.value) return toast('Informe servidor e loja');
      if (Number(opt.value) !== cfg.storeId) cfg.orderId = 0;
      cfg.storeId = opt.value;
      cfg.storeName = opt.textContent;
      cfg.customerId = $('#in-customer').value || 1;
      cfg.scale = $('#in-scale').value === '1';
      switchView('catalog');
    };
    const clearBtn = $('#btn-clear-order');
    if (clearBtn) clearBtn.onclick = () => { cfg.orderId = 0; updateBadge(null); toast('Carrinho abandonado'); };
  }

  async function renderCatalog() {
    stopPolling();
    await stopScanner();
    if (!cfg.server || !cfg.storeId) return renderSettings(true);
    setTitle(cfg.storeName || 'Loja');
    view.innerHTML = '<p class="center" style="padding:30px"><span class="spinner"></span></p>';
    try {
      const [data, order] = await Promise.all([
        api('GET', `/stores/${cfg.storeId}/catalog`),
        currentOrder(),
      ]);
      updateBadge(order);
      const cats = {};
      for (const p of data.products) (cats[p.category || 'Outros'] ||= []).push(p);
      view.innerHTML = Object.entries(cats)
        .map(([cat, prods]) => `
          <p class="muted" style="margin:8px 4px 6px">${esc(cat)}</p>
          ${prods.map((p) => `
            <div class="card row">
              <div class="grow">
                <div>${esc(p.name)}</div>
                <div class="muted">${p.available > 0 ? formatAvailable(p) : 'esgotado'}</div>
              </div>
              <span class="price">${formatPrice(p)}</span>
            </div>`).join('')}`)
        .join('') || '<p class="center muted" style="padding:30px">Catálogo vazio</p>';
    } catch (e) {
      view.innerHTML = `<div class="card center">
        <p>⚠️ ${esc(e.message)}</p>
        <button class="secondary" style="margin-top:12px" onclick="MM.settings()">Abrir configurações</button>
      </div>`;
    }
  }

  async function renderScan() {
    stopPolling();
    await stopScanner();
    if (!cfg.server || !cfg.storeId) return renderSettings(true);
    setTitle('Escanear produto');
    view.innerHTML = `
      <div id="reader"></div>
      <p class="muted center" style="margin:10px 0">Aponte a câmera para o código de barras</p>
      <div class="card">
        <label>Ou digite o código (EAN)</label>
        <div class="row" style="margin-top:4px">
          <input id="in-ean" class="grow" type="text" inputmode="numeric" placeholder="789...">
          <button id="btn-add-ean" class="primary" style="width:110px">Adicionar</button>
        </div>
      </div>`;

    const handleEan = async (ean) => {
      const now = Date.now();
      if (ean === lastScan.ean && now - lastScan.at < 2500) return; // anti-duplo-scan
      lastScan = { ean, at: now };
      try {
        // Modo balança: etiqueta EAN-13 "2 CCCCCC WWWWW D" — o peso em
        // gramas vem impresso no próprio código, sem perguntar ao cliente
        if (cfg.scale && /^2\d{12}$/.test(ean)) {
          const prefix = ean.slice(0, 7);
          const grams = Number(ean.slice(7, 12));
          const product = await api(
            'GET', `/stores/${cfg.storeId}/products/scale/${prefix}`,
          );
          if (grams > 0) await addByEan(product.ean, grams / 1000);
          else openWeightModal(product); // etiqueta sem peso → pergunta
          return;
        }
        const product = await api('GET', `/stores/${cfg.storeId}/products/ean/${ean}`);
        if (product.unit_type === 'kg') openWeightModal(product);
        else await addByEan(ean);
      } catch (e) { toast(`⚠️ ${e.message}`); }
    };

    $('#btn-add-ean').onclick = () => {
      const ean = $('#in-ean').value.trim();
      if (ean) { handleEan(ean); $('#in-ean').value = ''; }
    };

    try {
      scanner = new Html5Qrcode('reader');
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 240, height: 150 } },
        (text) => handleEan(text.trim()),
        () => {}, // frames sem código: ignora
      );
    } catch {
      $('#reader').outerHTML =
        '<div class="card center muted">Câmera indisponível — use o campo abaixo para digitar o código.</div>';
    }
  }

  async function renderCart() {
    stopPolling();
    await stopScanner();
    if (!cfg.server || !cfg.storeId) return renderSettings(true);
    setTitle('Carrinho');
    const order = await currentOrder();
    updateBadge(order);
    if (!order || order.items.length === 0) {
      view.innerHTML = `<div class="card center">
        <div class="big-emoji">🛒</div>
        <p>Seu carrinho está vazio.</p>
        <p class="muted" style="margin-top:6px">Escaneie um produto para começar.</p>
        <button class="primary" style="margin-top:14px" onclick="MM.go('scan')">📷 Escanear</button>
      </div>`;
      return;
    }
    view.innerHTML = `
      ${order.items.map((i) => `
        <div class="card row">
          <div class="grow">
            <div>${esc(i.name)}</div>
            <div class="muted">${
              i.unit_type === 'kg'
                ? `${i.qty.toFixed(3)} kg × ${money(i.unit_price)}/kg`
                : `${i.qty} × ${money(i.unit_price)}`
            }</div>
          </div>
          <span class="price">${money(i.subtotal)}</span>
          <button class="link" data-del="${i.product_id}">✕</button>
        </div>`).join('')}
      <div class="total-bar"><span>Total</span><span>${money(order.total)}</span></div>
      <button id="btn-pay" class="primary">Pagar com Pix — ${money(order.total)}</button>
      <button id="btn-cancel-order" class="link" style="width:100%;margin-top:10px">Cancelar pedido</button>`;

    view.querySelectorAll('[data-del]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          const updated = await api('DELETE', `/orders/${order.id}/items/${btn.dataset.del}`);
          updateBadge(updated);
          renderCart();
        } catch (e) { toast(`⚠️ ${e.message}`); }
      };
    });
    $('#btn-pay').onclick = () => renderPayment(order.id);
    $('#btn-cancel-order').onclick = () => confirmCancelOrder(order.id);
  }

  async function renderPayment(orderId) {
    await stopScanner();
    setTitle('Pagamento Pix');
    view.innerHTML = '<p class="center" style="padding:30px"><span class="spinner"></span></p>';
    let payment;
    try {
      payment = await api('POST', `/orders/${orderId}/pay`);
    } catch (e) {
      toast(`⚠️ ${e.message}`);
      return renderCart();
    }
    view.innerHTML = `
      <div class="card center">
        <div class="big-emoji">💠</div>
        <p><b>${money(payment.amount)}</b></p>
        <p class="muted" style="margin-top:4px">Copie o código abaixo e pague no app do seu banco.</p>
        <div class="pix-code" id="pix-code">${esc(payment.qr_payload)}</div>
        <button id="btn-copy" class="primary">Copiar código Pix</button>
        <p class="muted" style="margin-top:14px"><span class="spinner"></span>&nbsp; Aguardando confirmação do pagamento…</p>
        <button id="btn-cancel-order" class="link" style="width:100%;margin-top:10px">Cancelar pedido</button>
      </div>`;

    $('#btn-cancel-order').onclick = () => confirmCancelOrder(orderId);

    $('#btn-copy').onclick = async () => {
      const text = payment.qr_payload;
      try {
        await navigator.clipboard.writeText(text);
        toast('Código copiado! Cole no app do banco.');
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        toast('Código copiado! Cole no app do banco.');
      }
    };

    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const order = await api('GET', `/orders/${orderId}`);
        if (order.status === 'concluido' || order.status === 'pago') {
          stopPolling();
          cfg.orderId = 0;
          updateBadge(null);
          renderSuccess(order);
        }
      } catch { /* tenta de novo no próximo tick */ }
    }, 3000);
  }

  function renderSuccess(order) {
    setTitle('Compra concluída');
    view.innerHTML = `
      <div class="card center">
        <div class="big-emoji">✅</div>
        <p><b>Pagamento confirmado!</b></p>
        <p class="muted" style="margin:8px 0">Pedido #${order.id} — ${money(order.total)}</p>
        ${order.items.map((i) => `<p class="muted">${
          i.unit_type === 'kg' ? `${i.qty.toFixed(3)} kg` : `${i.qty}×`
        } ${esc(i.name)}</p>`).join('')}
        <button class="primary" style="margin-top:16px" onclick="MM.go('catalog')">Voltar à loja</button>
      </div>`;
  }

  // ---------- navegação ----------
  const views = { catalog: renderCatalog, scan: renderScan, cart: renderCart };

  function switchView(name) {
    currentView = name;
    document.querySelectorAll('.tab').forEach((t) =>
      t.classList.toggle('active', t.dataset.view === name));
    (views[name] || renderCatalog)();
  }

  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => switchView(t.dataset.view);
  });
  $('#btn-settings').onclick = () => renderSettings();

  // usado nos onclick inline
  window.MM = { go: switchView, settings: () => renderSettings() };

  // início
  if (!cfg.server || !cfg.storeId) renderSettings(true);
  else switchView('catalog');
})();
