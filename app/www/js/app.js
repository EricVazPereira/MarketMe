/* MarketMe — PDV de autoatendimento integrado ao servidor de API
 * DataSnap (Server ZF / TSM). Fluxo: verificar caixa → abrir caixa →
 * toque para iniciar → passar produtos (GravaItens) → fechar conta
 * (FechamentoComandaSmartPDV). Roda no WebView do APK Android. */
(() => {
  'use strict';

  // Credenciais padrão de operação do caixa (definidas pelo lojista)
  const OPERADOR = { codigo: '0', senha: '794613' };
  // Nome do método DataSnap de verificação de permissão — ajuste aqui
  // se no seu servidor o método tiver outro nome
  const PERMISSAO_METODO = 'VerificaPermissao';

  // ---------- configuração ----------
  const cfg = {
    get apiUrl() { return localStorage.getItem('mm.apiUrl') || ''; },
    set apiUrl(v) { localStorage.setItem('mm.apiUrl', v.replace(/\/+$/, '')); },
    get estacao() { return localStorage.getItem('mm.estacao') || 'DEVELOP'; },
    set estacao(v) { localStorage.setItem('mm.estacao', v); },
    // credenciais da API (as mesmas do .ini do Server ZF)
    get apiUser() { return localStorage.getItem('mm.apiUser') || ''; },
    set apiUser(v) { localStorage.setItem('mm.apiUser', v); },
    get apiPass() { return localStorage.getItem('mm.apiPass') || ''; },
    set apiPass(v) { localStorage.setItem('mm.apiPass', v); },
    get empresa() { return localStorage.getItem('mm.empresa') || ''; },
    set empresa(v) { localStorage.setItem('mm.empresa', v); },
    get scale() { return localStorage.getItem('mm.scale') === '1'; },
    set scale(v) { localStorage.setItem('mm.scale', v ? '1' : '0'); },
    get conta() {
      try { return JSON.parse(localStorage.getItem('mm.conta')) || { barcode: '', linhas: [] }; }
      catch { return { barcode: '', linhas: [] }; }
    },
    set conta(v) {
      if (v && (v.barcode || v.linhas.length)) localStorage.setItem('mm.conta', JSON.stringify(v));
      else localStorage.removeItem('mm.conta');
    },
  };

  let screen = 'boot';
  let scanner = null;
  let lastScan = { code: '', at: 0 };

  const $ = (sel) => document.querySelector(sel);
  const view = $('#view');
  const money = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // preços do ERP vêm como "1,00" (vírgula decimal)
  const parseBR = (v) => Number(String(v ?? '0').replace(/\./g, '').replace(',', '.'));

  // ---------- API DataSnap ----------
  async function tsm(method, path, body) {
    if (!cfg.apiUrl) throw new Error('configure o endereço da API');
    const headers = {};
    if (body) headers['content-type'] = 'application/json';
    // DataSnap autentica por HTTP Basic (usuário/senha do .ini do servidor)
    if (cfg.apiUser || cfg.apiPass)
      headers.authorization = 'Basic ' + btoa(`${cfg.apiUser}:${cfg.apiPass}`);
    let res;
    try {
      res = await fetch(`${cfg.apiUrl}/datasnap/rest/TSM/${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error('sem conexão com o servidor de API');
    }
    if (res.status === 401)
      throw new Error(
        'API recusou as credenciais (401) — confira o usuário e a senha ' +
        'da API nas Configurações (os mesmos do .ini do Server ZF)',
      );
    if (!res.ok) throw new Error(`API respondeu ${res.status} em ${path}`);
    let data = await res.json().catch(() => ({}));
    // DataSnap clássico embrulha o retorno em {"result":[...]}
    if (data && data.result && Array.isArray(data.result) && data.result.length === 1)
      data = data.result[0];
    return data;
  }

  // O retorno de VerficaCXAberto não tem um campo booleano único —
  // interpreta pela mensagem/id (tolerante a variações do servidor)
  function caixaEstaAberto(resp) {
    const texto = JSON.stringify(resp).toLowerCase();
    if (/n[ãa]o est[áa] aberto|opera[çc][ãa]o inv[áa]lida|fechado/.test(texto)) return false;
    if (Number(resp?.id_sucess) === 1) return true;
    return /aberto/.test(texto);
  }

  // ---------- UI helpers ----------
  let toastTimer;
  function toast(msg, ms = 2600) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  }
  const setTitle = (t) => { $('#title').textContent = t; };

  function openModal(html) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-card">${html}</div>`;
    document.body.appendChild(overlay);
    return overlay;
  }
  const closeModal = (o) => o.remove();

  async function stopScanner() {
    if (scanner) {
      try { await scanner.stop(); } catch { /* já parado */ }
      try { scanner.clear(); } catch { /* sem elemento */ }
      scanner = null;
    }
  }

  // ---------- conta (carrinho espelhando a comanda do PDV) ----------
  // As linhas vêm do retorno do GravaItens (uma por unidade/pesagem);
  // para exibir, agrupa por produto.
  function agrupar(linhas) {
    const map = new Map();
    for (const l of linhas) {
      const g = map.get(l.id) || {
        id: l.id, name: (l.name || l.description || '').trim(),
        unidade: l.unidade || 'UN', unit_price: Number(l.unit_price),
        qty: 0, total: 0,
      };
      g.qty += Number(l.amount);
      g.total += Number(l.total_price);
      map.set(l.id, g);
    }
    return [...map.values()];
  }
  const totalConta = (linhas) =>
    linhas.reduce((s, l) => s + Number(l.total_price), 0);

  async function gravaItens(consumo) {
    const conta = cfg.conta;
    const linhas = await tsm('POST', 'GravaItens', {
      cabecalho: { ID: conta.barcode, nm_estacao: cfg.estacao, NrMesa: '' },
      consumo,
    });
    if (!Array.isArray(linhas))
      throw new Error(linhas?.error || 'retorno inesperado do GravaItens');
    // regra do PDV: a partir da 2ª inserção o ID é o barcode devolvido
    const barcode = linhas.length > 0 ? linhas[0].barcode : conta.barcode;
    cfg.conta = { barcode, linhas };
    return linhas;
  }

  // ---------- produto / scan ----------
  // O código escaneado é consultado no ERP; etiqueta de balança
  // (2 CCCCCC WWWWW D) traz o código do produto e o peso embutidos.
  async function processCode(raw) {
    const code = raw.trim();
    if (!code) return;
    const now = Date.now();
    if (code === lastScan.code && now - lastScan.at < 2500) return; // anti-duplo-scan
    lastScan = { code, at: now };
    try {
      let lookup = code;
      let pesoEtiqueta = 0;
      if (cfg.scale && /^2\d{12}$/.test(code)) {
        lookup = String(Number(code.slice(1, 7)));
        pesoEtiqueta = Number(code.slice(7, 12)) / 1000;
      }
      const p = await tsm('GET', `ConsultaFormatoProduto/${encodeURIComponent(lookup)}`);
      if (!p || !p.cod_pro) throw new Error(`produto ${lookup} não encontrado no ERP`);
      if (p.fl_ativo !== '1') throw new Error(`${(p.ds_pro || 'produto').trim()} está inativo`);
      const price = parseBR(p.vl_venda);
      const isKg = String(p.un_pro).toUpperCase() === 'KG';

      if (isKg && pesoEtiqueta > 0) return addItem(p, price, pesoEtiqueta);
      if (isKg) return openWeightModal(p, price);
      return addItem(p, price, 1);
    } catch (e) { toast(`⚠️ ${e.message}`); }
  }

  async function addItem(p, price, qty) {
    await gravaItens([{
      Cod_pro: p.cod_pro,
      Obs_pro: '',
      Qtde_pro: Number.isInteger(qty) ? String(qty) : qty.toFixed(3),
      Vl_Pro: price.toFixed(2),
      Acomp_Pro: '',
    }]);
    if (navigator.vibrate) navigator.vibrate(80);
    toast(`✔ ${(p.ds_pro || '').trim()} — total ${money(totalConta(cfg.conta.linhas))}`);
    if (screen === 'shop') refreshCart();
  }

  function openWeightModal(p, price) {
    const overlay = openModal(`
      <h3>${esc((p.ds_pro || '').trim())}</h3>
      <p class="muted">${money(price)} / kg</p>
      <label>Peso (kg)</label>
      <input id="modal-weight" type="number" inputmode="decimal" step="0.001" min="0.001" value="0.500">
      <button id="modal-confirm" class="primary" style="margin-top:14px">Adicionar</button>
      <button id="modal-back" class="link" style="width:100%;margin-top:8px">Cancelar</button>`);
    overlay.querySelector('#modal-confirm').onclick = async () => {
      const w = Number(overlay.querySelector('#modal-weight').value);
      if (!(w > 0)) return toast('Informe um peso válido');
      closeModal(overlay);
      try { await addItem(p, price, w); } catch (e) { toast(`⚠️ ${e.message}`); }
    };
    overlay.querySelector('#modal-back').onclick = () => closeModal(overlay);
  }

  // ---------- permissão (cancelamentos) ----------
  function askPermission(funcao, titulo, onOk) {
    const overlay = openModal(`
      <h3>${esc(titulo)}</h3>
      <p class="muted">Peça a um operador autorizado.</p>
      <label>Código do operador</label>
      <input id="perm-cod" type="text" inputmode="numeric" value="">
      <label>Senha</label>
      <input id="perm-senha" type="password">
      <button id="modal-confirm" class="primary" style="margin-top:14px">Autorizar</button>
      <button id="modal-back" class="link" style="width:100%;margin-top:8px">Voltar</button>`);
    overlay.querySelector('#modal-confirm').onclick = async () => {
      const codigo = overlay.querySelector('#perm-cod').value.trim();
      const senha = overlay.querySelector('#perm-senha').value;
      try {
        const r = await tsm('POST', PERMISSAO_METODO, { funcao, codigo, senha });
        if (String(r?.Resultado).toLowerCase() !== 'true')
          return toast(r?.Mensagem || 'Usuário sem permissão para esta operação.');
        closeModal(overlay);
        onOk();
      } catch (e) { toast(`⚠️ ${e.message}`); }
    };
    overlay.querySelector('#modal-back').onclick = () => closeModal(overlay);
  }

  // ---------- telas ----------
  async function renderSettings() {
    screen = 'settings';
    await stopScanner();
    setTitle('Configurações');
    view.innerHTML = `
      <div class="card">
        <label>Endereço da API (servidor Server ZF)</label>
        <input id="in-api" type="url" placeholder="http://192.168.0.18:81"
               value="${esc(cfg.apiUrl)}" autocapitalize="off">
        <p class="muted" style="margin-top:4px">O app completa com /datasnap/rest/TSM/…</p>
        <label>Token Autenticação API</label>
        <input id="in-api-user" type="text" autocapitalize="off"
               placeholder="usuário/token do .ini do Server ZF" value="${esc(cfg.apiUser)}">
        <label>Senha</label>
        <input id="in-api-pass" type="password" value="${esc(cfg.apiPass)}">
        <label>Nome da estação (nm_estacao)</label>
        <input id="in-estacao" type="text" autocapitalize="characters" value="${esc(cfg.estacao)}">
        <label>Balança integrada (etiqueta com peso no código de barras)</label>
        <select id="in-scale">
          <option value="0" ${cfg.scale ? '' : 'selected'}>Não — pedir o peso na tela</option>
          <option value="1" ${cfg.scale ? 'selected' : ''}>Sim — ler o peso da etiqueta</option>
        </select>
        <button id="btn-test" class="secondary" style="margin-top:12px">Testar conexão</button>
        <p id="empresa-info" class="muted center" style="margin-top:8px">${esc(cfg.empresa)}</p>
        <button id="btn-save" class="primary" style="margin-top:8px">Salvar e continuar</button>
      </div>
      <p class="muted center">MarketMe v0.4 — PDV autoatendimento</p>`;

    const saveFields = () => {
      cfg.apiUrl = $('#in-api').value.trim();
      cfg.apiUser = $('#in-api-user').value.trim();
      cfg.apiPass = $('#in-api-pass').value;
      cfg.estacao = $('#in-estacao').value.trim() || 'DEVELOP';
      cfg.scale = $('#in-scale').value === '1';
    };
    $('#btn-test').onclick = async () => {
      saveFields();
      try {
        const emp = await tsm('GET', 'PegaDadosEmpresa');
        const nome = emp['Nome Fantasia'] || emp['Razao Social'] || '?';
        cfg.empresa = nome;
        $('#empresa-info').textContent = `✔ Conectado: ${nome}`;
        toast(`Empresa: ${nome}`);
      } catch (e) { toast(`Erro: ${e.message}`); }
    };
    $('#btn-save').onclick = async () => {
      saveFields();
      if (!cfg.apiUrl) return toast('Informe o endereço da API');
      renderCaixaCheck();
    };
  }

  // Verifica caixa aberto ao entrar (regra do fluxo)
  async function renderCaixaCheck() {
    screen = 'caixa-check';
    await stopScanner();
    setTitle(cfg.empresa || 'MarketMe');
    view.innerHTML = '<p class="center" style="padding:40px"><span class="spinner"></span><br><br>Verificando caixa…</p>';
    try {
      const r = await tsm('POST', 'VerficaCXAberto', { nm_estacao: cfg.estacao });
      if (caixaEstaAberto(r)) renderStart();
      else renderAbrirCaixa();
    } catch (e) {
      view.innerHTML = `<div class="card center">
        <p>⚠️ ${esc(e.message)}</p>
        <button class="secondary" style="margin-top:12px" onclick="MM.retry()">Tentar de novo</button>
        <button class="link" style="margin-top:8px" onclick="MM.settings()">Configurações</button>
      </div>`;
    }
  }

  function renderAbrirCaixa() {
    screen = 'abrir-caixa';
    setTitle(cfg.empresa || 'MarketMe');
    view.innerHTML = `
      <div class="card center" style="margin-top:30px">
        <div class="big-emoji">🔒</div>
        <p><b>Caixa fechado</b></p>
        <p class="muted" style="margin:8px 0">Estação ${esc(cfg.estacao)}</p>
        <button id="btn-abrir" class="primary" style="margin-top:10px">Abrir caixa</button>
      </div>`;
    $('#btn-abrir').onclick = async () => {
      try {
        const r = await tsm('POST', 'AberturaCX', {
          nm_estacao: cfg.estacao,
          cod_operador: OPERADOR.codigo,
          cod_executor: OPERADOR.codigo,
        });
        toast(r?.message_sucess || 'Caixa aberto');
        renderStart();
      } catch (e) { toast(`⚠️ ${e.message}`); }
    };
  }

  // Tela inicial (antes da operação) com botões escondidos no canto
  // superior direito: segurar o dedo ~1s revela "Fechar caixa" e "Sair"
  function renderStart() {
    screen = 'start';
    stopScanner();
    setTitle(cfg.empresa || 'MarketMe');
    view.innerHTML = `
      <div id="start-screen" class="start-screen">
        <div class="big-emoji" style="font-size:4.5rem">🛒</div>
        <h2>Toque para iniciar</h2>
        <p class="muted" style="margin-top:8px">Passe seus produtos e pague sem filas</p>
      </div>
      <div id="corner-hot"></div>`;

    $('#start-screen').onclick = () => renderShop();

    // botões escondidos: pressionar e segurar o canto superior direito
    const hot = $('#corner-hot');
    let holdTimer = null;
    const startHold = (ev) => {
      ev.preventDefault();
      holdTimer = setTimeout(showHiddenMenu, 900);
    };
    const cancelHold = () => clearTimeout(holdTimer);
    hot.addEventListener('pointerdown', startHold);
    hot.addEventListener('pointerup', cancelHold);
    hot.addEventListener('pointerleave', cancelHold);
  }

  function showHiddenMenu() {
    const overlay = openModal(`
      <h3>Operações do caixa</h3>
      <button id="menu-fechar" class="secondary" style="margin-top:12px">Fechar caixa</button>
      <button id="menu-sair" class="secondary" style="margin-top:8px">Sair</button>
      <button id="modal-back" class="link" style="width:100%;margin-top:8px">Voltar</button>`);
    overlay.querySelector('#menu-fechar').onclick = () => {
      closeModal(overlay);
      renderFecharCaixa();
    };
    overlay.querySelector('#menu-sair').onclick = () => {
      // sai do aplicativo (ponte nativa do APK; fallback fecha a página)
      if (window.MMNative && window.MMNative.exitApp) window.MMNative.exitApp();
      else window.close();
    };
    overlay.querySelector('#modal-back').onclick = () => closeModal(overlay);
  }

  function renderFecharCaixa() {
    screen = 'fechar-caixa';
    setTitle('Fechar caixa');
    view.innerHTML = `
      <div class="card center" style="margin-top:30px">
        <div class="big-emoji">🔐</div>
        <p><b>Fechar caixa?</b></p>
        <p class="muted" style="margin:8px 0">Estação ${esc(cfg.estacao)}</p>
        <button id="btn-fechar-sim" class="primary" style="background:var(--danger);margin-top:10px">Sim, fechar o caixa</button>
        <button id="btn-voltar" class="secondary" style="margin-top:8px">Voltar</button>
      </div>`;
    $('#btn-voltar').onclick = () => renderStart();
    $('#btn-fechar-sim').onclick = async () => {
      try {
        const r = await tsm('POST', 'FechamentoCX', {
          nm_estacao: cfg.estacao,
          cod_executor: OPERADOR.codigo,
        });
        toast(r?.message_sucess || 'Caixa fechado');
        renderAbrirCaixa(); // regra: após fechar, volta à abertura de caixa
      } catch (e) { toast(`⚠️ ${e.message}`); }
    };
  }

  // Tela de operação: câmera + código manual + conta em andamento
  async function renderShop() {
    screen = 'shop';
    await stopScanner();
    setTitle('Passe seus produtos');
    view.innerHTML = `
      <div id="reader"></div>
      <div class="card" style="margin-top:10px">
        <div class="row">
          <input id="in-ean" class="grow" type="text" inputmode="numeric" placeholder="ou digite o código">
          <button id="btn-add-ean" class="primary" style="width:110px">Adicionar</button>
        </div>
      </div>
      <div id="cart-area"></div>`;

    $('#btn-add-ean').onclick = () => {
      const code = $('#in-ean').value.trim();
      if (code) { processCode(code); $('#in-ean').value = ''; }
    };
    $('#in-ean').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); $('#btn-add-ean').click(); }
    });

    refreshCart();

    try {
      scanner = new Html5Qrcode('reader');
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 240, height: 150 } },
        (text) => processCode(text),
        () => {}, // frames sem código: ignora
      );
    } catch {
      $('#reader').outerHTML =
        '<div class="card center muted">Câmera indisponível — digite o código ou use o leitor.</div>';
    }
  }

  function refreshCart() {
    const area = $('#cart-area');
    if (!area) return;
    const { linhas } = cfg.conta;
    if (linhas.length === 0) {
      area.innerHTML = '<p class="center muted" style="padding:16px">Nenhum item ainda — passe o primeiro produto.</p>';
      return;
    }
    const grupos = agrupar(linhas);
    const total = totalConta(linhas);
    area.innerHTML = `
      <div class="cart-head">
        <span>N</span><span>Descrição</span><span>Qtd</span><span>R$UN</span><span>R$ Total</span><span></span>
      </div>
      ${grupos.map((g, i) => `
        <div class="cart-row">
          <span class="muted">${i + 1}</span>
          <span>${esc(g.name)}</span>
          <span class="cart-qtd">${g.unidade === 'KG' ? `${g.qty.toFixed(3)}kg` : g.qty}</span>
          <span class="cart-un">${money(g.unit_price)}${g.unidade === 'KG' ? '/kg' : ''}</span>
          <span class="cart-total">${money(g.total)}</span>
          <button class="link" data-del="${esc(g.id)}">✕</button>
        </div>`).join('')}
      <div class="total-bar"><span>Total</span><span>${money(total)}</span></div>
      <button id="btn-fechar-conta" class="primary">Fechar conta — ${money(total)}</button>
      <button id="btn-cancelar-conta" class="danger">Cancelar conta</button>`;

    // cancelar item: direto, sem senha (decisão de produto)
    area.querySelectorAll('[data-del]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          const g = grupos.find((x) => x.id === btn.dataset.del);
          await gravaItens([{
            Cod_pro: g.id, Obs_pro: 'CANCELAMENTO',
            Qtde_pro: `-${g.qty}`, Vl_Pro: g.unit_price.toFixed(2), Acomp_Pro: '',
          }]);
          toast('Item cancelado');
          refreshCart();
        } catch (e) { toast(`⚠️ ${e.message}`); }
      };
    });

    // cancelar a conta inteira exige permissão CANCEL_CONTA_CX_FUN
    $('#btn-cancelar-conta').onclick = () =>
      askPermission('CANCEL_CONTA_CX_FUN', 'Cancelar conta', () => {
        cfg.conta = { barcode: '', linhas: [] };
        toast('Conta cancelada');
        renderStart();
      });

    $('#btn-fechar-conta').onclick = () => renderPayment();
  }

  async function renderPayment() {
    screen = 'payment';
    await stopScanner();
    setTitle('Fechar conta');
    const { linhas, barcode } = cfg.conta;
    const total = totalConta(linhas);
    view.innerHTML = `
      <div class="card">
        <div class="total-bar"><span>Total a pagar</span><span>${money(total)}</span></div>
        <label>CPF na nota (opcional)</label>
        <input id="in-cpf" type="text" inputmode="numeric" placeholder="somente números">
        <button id="btn-confirmar" class="primary" style="margin-top:14px">Confirmar pagamento</button>
        <button id="btn-voltar" class="secondary" style="margin-top:8px">Voltar</button>
      </div>`;
    $('#btn-voltar').onclick = () => renderShop();
    $('#btn-confirmar').onclick = async () => {
      try {
        const r = await tsm('POST', 'FechamentoComandaSmartPDV', {
          subtotal: total.toFixed(2),
          total: total.toFixed(2),
          barcode,
          discount: '0',
          cpf: $('#in-cpf').value.replace(/\D/g, ''),
          add_service: '0',
          operadora_smart_pdv: `PIX|${total.toFixed(2)}|`,
          nm_estacao: cfg.estacao,
        });
        if (r && r.sucess === false)
          return toast(r.message_sucess || 'não foi possível fechar a conta');
        cfg.conta = { barcode: '', linhas: [] };
        renderSuccess(total, r?.message_sucess);
      } catch (e) { toast(`⚠️ ${e.message}`); }
    };
  }

  function renderSuccess(total, msg) {
    screen = 'success';
    setTitle('Conta fechada');
    view.innerHTML = `
      <div class="card center">
        <div class="big-emoji">✅</div>
        <p><b>Conta fechada!</b></p>
        <p class="muted" style="margin:8px 0">${esc(msg || '')} — ${money(total)}</p>
        <button class="primary" style="margin-top:16px" onclick="MM.start()">Concluir</button>
      </div>`;
    setTimeout(() => { if (screen === 'success') renderStart(); }, 8000);
  }

  // ---------- leitor físico (Bluetooth/USB modo teclado) ----------
  (() => {
    let buf = '';
    let lastKey = 0;
    document.addEventListener('keydown', (ev) => {
      const tag = (ev.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      const now = Date.now();
      if (now - lastKey > 250) buf = '';
      lastKey = now;
      if (ev.key === 'Enter') {
        if (buf.length >= 4 && (screen === 'shop' || screen === 'start')) {
          if (screen === 'start') renderShop().then(() => processCode(buf));
          else processCode(buf);
        }
        buf = '';
      } else if (/^[\dA-Za-z]$/.test(ev.key)) {
        buf += ev.key;
      } else {
        buf = '';
      }
    });
  })();

  // ---------- navegação ----------
  $('#btn-settings').onclick = () => renderSettings();
  window.MM = {
    settings: () => renderSettings(),
    retry: () => renderCaixaCheck(),
    start: () => renderStart(),
  };

  // início: sem API configurada → configurações; senão → verificar caixa
  if (!cfg.apiUrl) renderSettings();
  else renderCaixaCheck();
})();
