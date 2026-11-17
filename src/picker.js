// Barra flutuante + seletor de elemento, injetados na própria página.
// Vive dentro de um shadow root para o CSS do site não encostar nela.
(() => {
  if (self.__clonasitePicker) {
    self.__clonasitePicker.show();
    return;
  }

  const HOST_ID = 'clonasite-overlay';
  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .layer {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        pointer-events: none;
        font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      }
      .bar {
        position: fixed;
        left: 50%;
        top: 18px;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 6px 7px;
        border-radius: 14px;
        background: linear-gradient(180deg, #171d2c, #10141f);
        border: 1px solid #2a3550;
        box-shadow: 0 12px 34px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(22, 163, 74, 0.14);
        pointer-events: auto;
        user-select: none;
        animation: descer 0.34s cubic-bezier(0.22, 1, 0.36, 1) both;
      }
      @keyframes descer {
        from { opacity: 0; transform: translateX(-50%) translateY(-14px); }
        to   { opacity: 1; transform: translateX(-50%) translateY(0); }
      }
      .grip {
        display: flex;
        padding: 0 3px;
        color: #6b7686;
        cursor: grab;
      }
      .marca {
        width: 19px;
        height: 19px;
        border-radius: 5px;
        flex: none;
        margin-right: 2px;
      }
      .grip:active { cursor: grabbing; }
      button {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 7px 11px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: #e9eef5;
        font: inherit;
        font-weight: 550;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.15s, color 0.15s, transform 0.12s;
      }
      button:hover { background: #222b42; transform: translateY(-1px); }
      button.on {
        background: linear-gradient(135deg, #22c55e, #16a34a 60%, #166534);
        color: #fff;
        box-shadow: 0 3px 12px rgba(22, 163, 74, 0.45);
      }
      button.on:hover { filter: brightness(1.1); }
      button.icon { padding: 7px 8px; color: #8b97a8; }
      svg { width: 14px; height: 14px; flex: none; }

      /* realce do elemento sob o cursor */
      .hl {
        position: fixed;
        pointer-events: none;
        border: 2px solid #22c55e;
        background: rgba(22, 163, 74, 0.16);
        border-radius: 4px;
        display: none;
        transition: left 0.09s ease, top 0.09s ease, width 0.09s ease, height 0.09s ease;
        animation: pulsar 1.6s ease-in-out infinite;
      }
      @keyframes pulsar {
        0%, 100% { box-shadow: 0 0 0 0 rgba(22, 163, 74, 0.42); }
        50%      { box-shadow: 0 0 0 5px rgba(22, 163, 74, 0); }
      }
      .tip {
        position: fixed;
        pointer-events: none;
        padding: 3px 7px;
        border-radius: 5px;
        background: linear-gradient(135deg, #22c55e, #16a34a);
        color: #fff;
        font-size: 11px;
        font-weight: 620;
        white-space: nowrap;
        display: none;
      }
      .hint {
        position: fixed;
        left: 50%;
        bottom: 22px;
        transform: translateX(-50%);
        padding: 7px 13px;
        border-radius: 9px;
        background: linear-gradient(180deg, #171d2c, #10141f);
        border: 1px solid #2a3550;
        color: #b9c3d0;
        font-size: 12px;
        display: none;
      }
      .hint b { color: #e9eef5; }
      .picking .hl, .picking .tip, .picking .hint { display: block; }
    </style>
    <div class="layer">
      <div class="bar">
        <span class="grip" title="Arrastar">
          <svg viewBox="0 0 16 16" fill="currentColor"><circle cx="6" cy="4" r="1.1"/><circle cx="10" cy="4" r="1.1"/><circle cx="6" cy="8" r="1.1"/><circle cx="10" cy="8" r="1.1"/><circle cx="6" cy="12" r="1.1"/><circle cx="10" cy="12" r="1.1"/></svg>
        </span>
        <img class="marca" alt="" src="" />
        <button id="pick">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><rect x="8" y="8" width="8" height="8" rx="1"/></svg>
          Clonar componente
        </button>
        <button id="full">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>
          Página inteira
        </button>
        <button id="close" class="icon" title="Fechar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="hl"></div>
      <div class="tip"></div>
      <div class="hint">Clique no elemento que você quer copiar · <b>Esc</b> cancela</div>
    </div>
  `;

  // O <img> só carrega da extensão porque icons/ está em web_accessible_resources.
  shadow.querySelector('.marca').src = chrome.runtime.getURL('icons/icon48.png');

  document.documentElement.appendChild(host);

  const layer = shadow.querySelector('.layer');
  const bar = shadow.querySelector('.bar');
  const hl = shadow.querySelector('.hl');
  const tip = shadow.querySelector('.tip');
  const btnPick = shadow.getElementById('pick');

  let picking = false;
  let hovered = null;

  const describe = (el) => {
    let name = el.tagName.toLowerCase();
    if (el.id) name += '#' + el.id;
    else if (el.classList.length) name += '.' + [...el.classList].slice(0, 2).join('.');
    const r = el.getBoundingClientRect();
    return name.slice(0, 44) + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
  };

  const paintHighlight = (el) => {
    const r = el.getBoundingClientRect();
    hl.style.left = r.left + 'px';
    hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px';
    hl.style.height = r.height + 'px';
    tip.textContent = describe(el);
    // Etiqueta acima do elemento; se não couber, vai para dentro.
    tip.style.left = Math.max(4, r.left) + 'px';
    tip.style.top = (r.top > 24 ? r.top - 22 : r.top + 4) + 'px';
  };

  const onMove = (e) => {
    if (!picking) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === host || el === document.documentElement) return;
    hovered = el;
    paintHighlight(el);
  };

  const onClick = (e) => {
    if (!picking) return;
    if (e.target === host) return; // clique na própria barra
    e.preventDefault();
    e.stopPropagation();
    const el = hovered || document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === host) return;
    self.__clonasitePicked = el;
    setPicking(false);
    chrome.runtime.sendMessage({ type: 'clonasite:pick', mode: 'component', label: describe(el) });
  };

  const onKey = (e) => {
    if (e.key === 'Escape' && picking) {
      e.preventDefault();
      setPicking(false);
    }
  };

  function setPicking(on) {
    picking = on;
    hovered = null;
    layer.classList.toggle('picking', on);
    btnPick.classList.toggle('on', on);
    document.documentElement.style.cursor = on ? 'crosshair' : '';
  }

  btnPick.addEventListener('click', () => setPicking(!picking));

  shadow.getElementById('full').addEventListener('click', () => {
    setPicking(false);
    chrome.runtime.sendMessage({ type: 'clonasite:pick', mode: 'page' });
  });

  shadow.getElementById('close').addEventListener('click', () => api.destroy());

  // Arrastar a barra pelo grip.
  const grip = shadow.querySelector('.grip');
  grip.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const start = bar.getBoundingClientRect();
    const dx = e.clientX - start.left;
    const dy = e.clientY - start.top;
    const drag = (ev) => {
      bar.style.transform = 'none';
      bar.style.left = Math.max(4, Math.min(innerWidth - start.width - 4, ev.clientX - dx)) + 'px';
      bar.style.top = Math.max(4, Math.min(innerHeight - start.height - 4, ev.clientY - dy)) + 'px';
    };
    const drop = () => {
      removeEventListener('mousemove', drag, true);
      removeEventListener('mouseup', drop, true);
    };
    addEventListener('mousemove', drag, true);
    addEventListener('mouseup', drop, true);
  });

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  addEventListener('scroll', () => hovered && picking && paintHighlight(hovered), true);

  const api = {
    show: () => {
      host.style.display = '';
    },
    pick: () => setPicking(true),
    destroy: () => {
      setPicking(false);
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      host.remove();
      self.__clonasitePicker = null;
    },
  };
  self.__clonasitePicker = api;
  setPicking(true);
})();
