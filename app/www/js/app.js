/* MarketMe — PDV de autoatendimento integrado ao servidor de API
 * DataSnap (Server ZF / TSM). Fluxo: verificar caixa → abrir caixa →
 * toque para iniciar → passar produtos (GravaItens) → fechar conta
 * (FechamentoComandaSmartPDV). Roda no WebView do APK Android. */
(() => {
  'use strict';

  // Credenciais padrão de operação do caixa (definidas pelo lojista);
  // usadas na abertura/fechamento de caixa e nas permissões de cancelar
  const OPERADOR = { codigo: '0', senha: '794613' };
  const PERMISSAO_METODO = 'VerificaPermissaoUsuario';

  // ---------- configuração ----------
  // Valores padrão do ambiente do lojista — evitam ter que redigitar
  // tudo a cada reinstalação do APK de teste. Continuam editáveis nas
  // Configurações; o que for salvo ali tem prioridade.
  const PADRAO_API_URL = 'http://192.168.0.130:81';
  const PADRAO_API_USER = 'TOKEN_AUTENTICACAO_API';
  const PADRAO_API_PASS = '123';

  const cfg = {
    get apiUrl() { return localStorage.getItem('mm.apiUrl') || PADRAO_API_URL; },
    set apiUrl(v) { localStorage.setItem('mm.apiUrl', v.replace(/\/+$/, '')); },
    get estacao() { return localStorage.getItem('mm.estacao') || 'DEVELOP'; },
    set estacao(v) { localStorage.setItem('mm.estacao', v); },
    // credenciais da API (as mesmas do .ini do Server ZF)
    get apiUser() { return localStorage.getItem('mm.apiUser') || PADRAO_API_USER; },
    set apiUser(v) { localStorage.setItem('mm.apiUser', v); },
    get apiPass() { return localStorage.getItem('mm.apiPass') || PADRAO_API_PASS; },
    set apiPass(v) { localStorage.setItem('mm.apiPass', v); },
    get empresa() { return localStorage.getItem('mm.empresa') || ''; },
    set empresa(v) { localStorage.setItem('mm.empresa', v); },
    // dados completos da empresa (PegaDadosEmpresa), para o cabeçalho do cupom
    get empresaDados() {
      try { return JSON.parse(localStorage.getItem('mm.empresaDados')) || null; }
      catch { return null; }
    },
    set empresaDados(v) { localStorage.setItem('mm.empresaDados', JSON.stringify(v || {})); },
    // caminho/compartilhamento da impressora (ex.: \\eric\cupom)
    get impressora() { return localStorage.getItem('mm.impressora') || ''; },
    set impressora(v) { localStorage.setItem('mm.impressora', v); },
    // logo da loja (data URL), impressa no topo do cupom
    get logo() { return localStorage.getItem('mm.logo') || ''; },
    set logo(v) { v ? localStorage.setItem('mm.logo', v) : localStorage.removeItem('mm.logo'); },
    get scale() { return localStorage.getItem('mm.scale') === '1'; },
    set scale(v) { localStorage.setItem('mm.scale', v ? '1' : '0'); },
    get conta() {
      try {
        const c = JSON.parse(localStorage.getItem('mm.conta')) || {};
        return { barcode: c.barcode || '', linhas: c.linhas || [], canceladas: c.canceladas || [] };
      } catch { return { barcode: '', linhas: [], canceladas: [] }; }
    },
    set conta(v) {
      if (v && (v.barcode || v.linhas.length || (v.canceladas || []).length))
        localStorage.setItem('mm.conta', JSON.stringify(v));
      else localStorage.removeItem('mm.conta');
    },
  };

  let screen = 'boot';
  let lastScan = { code: '', at: 0 };

  const $ = (sel) => document.querySelector(sel);
  const view = $('#view');
  const money = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // preços do ERP vêm como "1,00" (vírgula decimal)
  const parseBR = (v) => Number(String(v ?? '0').replace(/\./g, '').replace(',', '.'));

  // O único campo de impressão é "Impressora" (caminho de rede, ex.:
  // \\eric\cupom ou \\192.168.1.50\cupom). O serviço que efetivamente
  // imprime (printer/) roda nessa mesma máquina identificada no
  // caminho, numa porta fixa que o operador não precisa saber — o app
  // extrai o host direto do \\HOST\compartilhamento digitado.
  const PRINT_PORT = 8127;
  function impressoraHost(caminho) {
    const m = String(caminho || '').trim().match(/^\\{2}([^\\/]+)/);
    return m ? m[1] : '';
  }
  function printServerUrl() {
    const host = impressoraHost(cfg.impressora);
    return host ? `http://${host}:${PRINT_PORT}` : '';
  }

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

  // Interpreta o retorno de VerficaCXAberto. Regra: só é considerado
  // FECHADO quando há sinal explícito disso (mensagem de "não está
  // aberto"/"operação inválida"/"fechado"); qualquer outra resposta de
  // sucesso é tratada como caixa ABERTO.
  function caixaEstaAberto(resp) {
    const texto = JSON.stringify(resp ?? {}).toLowerCase();
    if (/n[ãa]o est[áa] aberto|opera[çc][ãa]o inv[áa]lida|fechado|caixa fechado/.test(texto))
      return false;
    return true;
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
  function showBack(handler) {
    const b = $('#btn-back');
    if (handler) { b.classList.remove('hidden'); b.onclick = handler; }
    else { b.classList.add('hidden'); b.onclick = null; }
  }

  // ---------- inatividade (só na tela de operação) ----------
  // 1 min parado: sem itens → volta ao início; com itens → cancela o
  // cupom (CancelarConta) e volta ao início.
  const INATIVIDADE_MS = window.__INATIVIDADE_TEST || 60000;
  let inatividadeTimer = null;
  function pararInatividade() { clearTimeout(inatividadeTimer); inatividadeTimer = null; }
  function armarInatividade() {
    pararInatividade();
    inatividadeTimer = setTimeout(async () => {
      if (screen !== 'shop') return;
      const conta = cfg.conta;
      if (conta.linhas.length > 0 && conta.barcode) {
        try {
          await tsm('POST', 'CancelarConta', {
            nr_gerador: conta.barcode, nm_estacao: cfg.estacao,
            valor_conta: '0', valor_acrescimo: '0',
          });
        } catch { /* segue para o início mesmo se falhar */ }
        toast('Compra cancelada por inatividade');
      }
      cfg.conta = { barcode: '', linhas: [], canceladas: [] };
      renderStart();
    }, INATIVIDADE_MS);
  }
  const resetarInatividade = () => { if (screen === 'shop') armarInatividade(); };

  function openModal(html) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-card">${html}</div>`;
    document.body.appendChild(overlay);
    return overlay;
  }
  const closeModal = (o) => o.remove();

  // ---------- conta (carrinho espelhando a comanda do PDV) ----------
  // As linhas vêm do retorno do GravaItens (uma por unidade/pesagem);
  // para exibir, agrupa por produto.
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

  function agrupar(linhas) {
    const map = new Map();
    for (const l of linhas) {
      const g = map.get(l.id) || {
        id: l.id, name: (l.name || l.description || '').trim(),
        unidade: (l.unidade || 'UN').toUpperCase(), unit_price: num(l.unit_price),
        qty: 0, total: 0,
      };
      g.qty += num(l.amount);
      g.total += num(l.total_price);
      map.set(l.id, g);
    }
    return [...map.values()];
  }
  const totalConta = (linhas) =>
    linhas.reduce((s, l) => s + num(l.total_price), 0);

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
    cfg.conta = { barcode, linhas, canceladas: conta.canceladas };
    return linhas;
  }

  // Cancela UMA linha da comanda (a última passada do produto) via API
  // própria do PDV (CancelarItem). Quem altera o banco é a API; o app só
  // reflete a mudança localmente, movendo aquela linha — que ele já
  // conhece pelo retorno do GravaItens — para a lista de canceladas
  // (exibida em vermelho). Não interpreta o corpo do retorno, evitando
  // linhas "NaN" quando o formato difere do esperado.
  async function cancelarItem(productId) {
    await checkPermission('CANCEL_ITEM_CX_FUN');
    const conta = cfg.conta;
    const doProduto = conta.linhas.filter((l) => l.id === productId);
    if (doProduto.length === 0) return;
    // cancela a última unidade passada desse produto (maior contador)
    const alvo = doProduto.reduce((a, b) =>
      (String(a.contador) > String(b.contador) ? a : b));
    await tsm('POST', 'CancelarItem', {
      nr_gerador: conta.barcode,
      ordem_item: alvo.contador,
    });
    cfg.conta = {
      barcode: conta.barcode,
      linhas: conta.linhas.filter((l) => l.contador !== alvo.contador),
      canceladas: [...conta.canceladas, alvo],
    };
  }

  // ---------- produto / scan ----------
  // O código escaneado é consultado no ERP; etiqueta de balança
  // (2 CCCCCC WWWWW D) traz o código do produto e o peso embutidos.
  async function processCode(raw) {
    const code = raw.trim();
    if (!code) return;
    resetarInatividade(); // leitura pela câmera também conta como interação
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
  // Valida uma permissão no servidor. Por padrão usa as credenciais
  // fixas do caixa (0/794613); código/senha podem ser informados (ex.:
  // o acesso ao menu da engrenagem). Lança erro com a Mensagem quando negado.
  async function checkPermission(funcao, codigo = OPERADOR.codigo, senha = OPERADOR.senha) {
    const r = await tsm('POST', PERMISSAO_METODO, { funcao, codigo, senha });
    const ok =
      String(r?.Resultado ?? r?.resultado).toLowerCase() === 'true' ||
      r?.Resultado === true || r?.resultado === true;
    if (!ok)
      throw new Error(r?.Mensagem || 'Usuário sem permissão para esta operação.');
  }

  // Engrenagem: pede código+senha (numéricos), valida na API
  // (CANCEL_CONTA_CX_FUN) e abre APENAS as Configurações. Se a API
  // estiver inacessível (ex.: endereço errado), libera as Configurações
  // mesmo assim, para não travar o operador fora do ajuste de conexão.
  function openGearMenu() {
    if (!cfg.apiUrl) return renderSettings(); // 1ª configuração: sem o que validar
    const overlay = openModal(`
      <h3>Configurações</h3>
      <p class="muted">Informe código e senha do operador.</p>
      <label>Código</label>
      <input id="gear-cod" type="text" inputmode="numeric" pattern="[0-9]*">
      <label>Senha</label>
      <input id="gear-senha" type="password" inputmode="numeric" pattern="[0-9]*">
      <button id="modal-confirm" class="primary" style="margin-top:14px">Entrar</button>
      <button id="modal-back" class="link" style="width:100%;margin-top:8px">Voltar</button>`);
    const soNumeros = (el) => el.addEventListener('input', () => {
      el.value = el.value.replace(/\D/g, '');
    });
    soNumeros(overlay.querySelector('#gear-cod'));
    soNumeros(overlay.querySelector('#gear-senha'));
    overlay.querySelector('#modal-confirm').onclick = async () => {
      const codigo = overlay.querySelector('#gear-cod').value.trim();
      const senha = overlay.querySelector('#gear-senha').value.trim();
      try {
        await checkPermission('CANCEL_CONTA_CX_FUN', codigo, senha);
        closeModal(overlay);
        renderSettings();
      } catch (e) {
        if (/sem conex/i.test(e.message)) {
          closeModal(overlay);
          toast('Sem conexão — abrindo Configurações para ajustar o endereço.');
          renderSettings();
        } else {
          toast(e.message);
        }
      }
    };
    overlay.querySelector('#modal-back').onclick = () => closeModal(overlay);
  }

  // Segurar 2s em cima do nome da loja (título) revela estas operações
  function showCaixaMenu() {
    const overlay = openModal(`
      <h3>Operações do caixa</h3>
      <button id="op-fechar" class="secondary" style="margin-top:12px">Fechar caixa</button>
      <button id="op-sair" class="secondary" style="margin-top:8px">Sair do app</button>
      <button id="modal-back" class="link" style="width:100%;margin-top:8px">Voltar</button>`);
    overlay.querySelector('#op-fechar').onclick = () => { closeModal(overlay); renderFecharCaixa(); };
    overlay.querySelector('#op-sair').onclick = () => {
      if (window.MMNative && window.MMNative.exitApp) window.MMNative.exitApp();
      else window.close();
    };
    overlay.querySelector('#modal-back').onclick = () => closeModal(overlay);
  }

  // ---------- telas ----------
  async function renderSettings() {
    screen = 'settings';
    pararInatividade(); showBack(null);
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
        <label>Impressora (caminho de rede; vazio = não imprime)</label>
        <input id="in-impressora" type="text" autocapitalize="off"
               placeholder="\\\\eric\\cupom" value="${esc(cfg.impressora)}">
        <button id="btn-test-print" class="secondary" style="margin-top:8px">Imprimir página de teste</button>
        <label>Logo da loja (impressa no topo do cupom)</label>
        <div class="row" style="margin-top:4px;gap:10px">
          <img id="logo-preview" src="${esc(cfg.logo)}" class="${cfg.logo ? '' : 'hidden'}"
               style="width:44px;height:44px;object-fit:contain;border:1px solid #d4dcd7;border-radius:8px;background:#fff">
          <input id="in-logo" type="file" accept="image/*" class="grow">
        </div>
        <button id="btn-logo-remove" class="link ${cfg.logo ? '' : 'hidden'}" style="width:100%">Remover logo</button>
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
      cfg.impressora = $('#in-impressora').value.trim();
      cfg.scale = $('#in-scale').value === '1';
    };
    $('#in-logo').onchange = () => {
      const file = $('#in-logo').files[0];
      if (!file) return;
      if (file.size > 512 * 1024) return toast('Imagem muito grande (máx. 512KB)');
      const reader = new FileReader();
      reader.onload = () => {
        cfg.logo = reader.result;
        $('#logo-preview').src = reader.result;
        $('#logo-preview').classList.remove('hidden');
        $('#btn-logo-remove').classList.remove('hidden');
        toast('Logo salva');
      };
      reader.onerror = () => toast('Não foi possível ler a imagem');
      reader.readAsDataURL(file);
    };
    $('#btn-logo-remove').onclick = () => {
      cfg.logo = '';
      $('#in-logo').value = '';
      $('#logo-preview').classList.add('hidden');
      $('#btn-logo-remove').classList.add('hidden');
      toast('Logo removida');
    };
    $('#btn-test').onclick = async () => {
      saveFields();
      try {
        const emp = await tsm('GET', 'PegaDadosEmpresa');
        const nome = emp['Nome Fantasia'] || emp['Razao Social'] || '?';
        cfg.empresa = nome;
        cfg.empresaDados = emp; // guardado inteiro p/ o cabeçalho do cupom
        $('#empresa-info').textContent = `✔ Conectado: ${nome}`;
        toast(`Empresa: ${nome}`);
      } catch (e) { toast(`Erro: ${e.message}`); }
    };
    // Manda imprimir mesmo uma página de teste no caminho digitado —
    // prova real de que a rede encontra a impressora, sem precisar
    // fechar uma venda pra descobrir que não vai funcionar.
    $('#btn-test-print').onclick = async () => {
      saveFields();
      if (!cfg.impressora) return toast('Informe o caminho da impressora primeiro');
      const base = printServerUrl();
      if (!base)
        return toast('Caminho inválido — use um endereço de rede, ex.: \\\\eric\\cupom');
      try {
        const res = await fetch(`${base}/teste`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ printerPath: cfg.impressora, logoBase64: cfg.logo || undefined }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `respondeu ${res.status}`);
        toast(`✔ Página de teste enviada para ${cfg.impressora}`);
      } catch (e) {
        const msg = e.message === 'Failed to fetch' ? `não respondeu em ${base}` : e.message;
        toast(`⚠️ Não imprimiu: ${msg}`);
      }
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
    pararInatividade(); showBack(null);
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
    pararInatividade(); showBack(null);
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

  // Tela inicial (antes da operação). Fechar caixa e Sair ficam no menu
  // protegido da engrenagem (topo direito), não mais num botão escondido.
  function renderStart() {
    screen = 'start';
    pararInatividade(); showBack(null);
    setTitle(cfg.empresa || 'MarketMe');
    view.innerHTML = `
      <div id="start-screen" class="start-screen">
        <div class="big-emoji" style="font-size:4.5rem">🛒</div>
        <h2>Toque para iniciar</h2>
        <p class="muted" style="margin-top:8px">Passe seus produtos e pague sem filas</p>
      </div>`;
    $('#start-screen').onclick = () => renderShop();
  }

  function renderFecharCaixa() {
    screen = 'fechar-caixa';
    pararInatividade(); showBack(null);
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
    setTitle('Passe seus produtos');
    view.innerHTML = `
      <div class="card">
        <div class="shop-headline">Passe o produto no leitor</div>
        <div class="row" style="margin-top:4px">
          <input id="in-ean" class="grow" type="text" inputmode="numeric" autofocus>
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
    $('#in-ean').focus();

    refreshCart();
    armarInatividade(); // conta 1 min de inatividade nesta tela
  }

  const cartRow = (g, n, cancelada) => `
    <div class="cart-row${cancelada ? ' cancelada' : ''}">
      <span class="muted">${cancelada ? '✕' : n}</span>
      <span class="cart-name" title="${esc(g.name)}">${esc(g.name)}</span>
      <span class="cart-qtd">${g.unidade === 'KG' ? `${g.qty.toFixed(3)}kg` : g.qty}</span>
      <span class="cart-un">${money(g.unit_price)}${g.unidade === 'KG' ? '/kg' : ''}</span>
      <span class="cart-total">${money(g.total)}</span>
      ${cancelada ? '<span></span>' : `<button class="link" data-del="${esc(g.id)}">✕</button>`}
    </div>`;

  function refreshCart() {
    const area = $('#cart-area');
    if (!area) return;
    const { barcode, linhas, canceladas } = cfg.conta;
    // botão "voltar" no topo só enquanto nada foi passado (comanda não
    // aberta no servidor); depois disso o usuário finaliza ou cancela
    if (!barcode && linhas.length === 0)
      showBack(() => { pararInatividade(); renderStart(); });
    else showBack(null);
    if (linhas.length === 0 && canceladas.length === 0) {
      area.innerHTML = '<p class="center muted" style="padding:16px">Nenhum item ainda — passe o primeiro produto.</p>';
      return;
    }
    const grupos = agrupar(linhas);
    const gruposCancelados = agrupar(canceladas);
    const total = totalConta(linhas);
    area.innerHTML = `
      <div class="cart-head">
        <span>N</span><span>Descrição</span><span>Qtd</span><span>R$UN</span><span>R$ Total</span><span></span>
      </div>
      ${grupos.map((g, i) => cartRow(g, i + 1, false)).join('')}
      ${gruposCancelados.map((g) => cartRow(g, 0, true)).join('')}
      <div class="total-bar"><span>Total</span><span>${money(total)}</span></div>
      ${linhas.length === 0 ? '' : `<button id="btn-fechar-conta" class="primary">Fechar conta — ${money(total)}</button>`}
      <button id="btn-cancelar-conta" class="danger">Cancelar conta</button>`;

    // cancelar item: permissão silenciosa + API CancelarItem (uma
    // unidade por toque — a última passada do produto)
    area.querySelectorAll('[data-del]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          await cancelarItem(btn.dataset.del);
          toast('Item cancelado');
          refreshCart();
        } catch (e) { toast(`⚠️ ${e.message}`); }
      };
    });

    // cancelar a conta: confirmação + permissão + API CancelarConta
    $('#btn-cancelar-conta').onclick = () => {
      const overlay = openModal(`
        <h3>Cancelar conta?</h3>
        <p class="muted">Todos os itens serão descartados.</p>
        <button id="modal-confirm" class="danger">Sim, cancelar a conta</button>
        <button id="modal-back" class="link" style="width:100%;margin-top:8px">Voltar</button>`);
      overlay.querySelector('#modal-confirm').onclick = async () => {
        try {
          await checkPermission('CANCEL_CONTA_CX_FUN');
          if (cfg.conta.barcode) {
            await tsm('POST', 'CancelarConta', {
              nr_gerador: cfg.conta.barcode,
              nm_estacao: cfg.estacao,
              valor_conta: '0',
              valor_acrescimo: '0',
            });
          }
          closeModal(overlay);
          cfg.conta = { barcode: '', linhas: [], canceladas: [] };
          toast('Conta cancelada');
          renderStart();
        } catch (e) { toast(`⚠️ ${e.message}`); }
      };
      overlay.querySelector('#modal-back').onclick = () => closeModal(overlay);
    };

    $('#btn-fechar-conta').onclick = () => renderPayment();
  }

  const FORMA_PAGAMENTO = 'PIX'; // usada no fechamento e no cupom impresso

  // Pede ao servidor de impressão (mesmo host da API, porta 8127) para
  // imprimir o cupom. Opcional: sem cfg.impressora configurado, não faz
  // nada. Falha na impressão nunca desfaz a venda — só avisa o operador.
  async function imprimirCupom({ linhas, total, cpf }) {
    if (!cfg.impressora) return;
    const base = printServerUrl();
    if (!base)
      return toast('⚠️ Cupom não impresso: caminho da impressora inválido (use \\\\host\\compartilhamento)');
    try {
      const res = await fetch(`${base}/imprimir`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          printerPath: cfg.impressora,
          empresa: cfg.empresaDados,
          logoBase64: cfg.logo || undefined,
          itens: linhas,
          formaPagamento: FORMA_PAGAMENTO,
          total,
          cpf,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `impressora respondeu ${res.status}`);
    } catch (e) {
      // "Failed to fetch" é o TypeError genérico do fetch quando a
      // conexão nem chega a acontecer (serviço parado, IP/porta errados,
      // firewall) — mostra o endereço tentado pra dar pra diagnosticar.
      const msg = e.message === 'Failed to fetch' ? `não respondeu em ${base}` : e.message;
      toast(`⚠️ Cupom não impresso: ${msg}`);
    }
  }

  async function renderPayment() {
    screen = 'payment';
    pararInatividade(); showBack(null);
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
      const cpf = $('#in-cpf').value.replace(/\D/g, '');
      try {
        const r = await tsm('POST', 'FechamentoComandaSmartPDV', {
          subtotal: total.toFixed(2),
          total: total.toFixed(2),
          barcode,
          discount: '0',
          cpf,
          add_service: '0',
          operadora_smart_pdv: `${FORMA_PAGAMENTO}|${total.toFixed(2)}|`,
          nm_estacao: cfg.estacao,
        });
        if (r && r.sucess === false)
          return toast(r.message_sucess || 'não foi possível fechar a conta');
        await imprimirCupom({ linhas, total, cpf });
        cfg.conta = { barcode: '', linhas: [], canceladas: [] };
        renderSuccess(total, r?.message_sucess);
      } catch (e) { toast(`⚠️ ${e.message}`); }
    };
  }

  function renderSuccess(total, msg) {
    screen = 'success';
    pararInatividade(); showBack(null);
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

  // qualquer toque/tecla reinicia a contagem de inatividade na operação
  document.addEventListener('pointerdown', resetarInatividade, true);
  document.addEventListener('keydown', resetarInatividade, true);

  // ---------- navegação ----------
  // engrenagem → Configurações (protegida por código+senha)
  $('#btn-settings').onclick = () => openGearMenu();

  // segurar 2s em cima do nome da loja (título) → Fechar caixa / Sair do app
  (() => {
    const title = $('#title');
    let holdTimer = null;
    const start = () => {
      if (screen !== 'start') return; // só na tela inicial (nome da loja)
      holdTimer = setTimeout(showCaixaMenu, 2000);
    };
    const cancel = () => clearTimeout(holdTimer);
    title.addEventListener('pointerdown', start);
    title.addEventListener('pointerup', cancel);
    title.addEventListener('pointerleave', cancel);
    title.addEventListener('pointercancel', cancel);
  })();
  window.MM = {
    settings: () => renderSettings(),
    retry: () => renderCaixaCheck(),
    start: () => renderStart(),
  };

  // início: sem API configurada → configurações; senão → verificar caixa
  if (!cfg.apiUrl) renderSettings();
  else renderCaixaCheck();
})();
