// Gravador de rede e destravador de 3D.
//
// Roda no MUNDO PRINCIPAL da página, em document_start, em todo frame. Tem que
// ser antes de tudo: o que este arquivo faz só funciona se ele chegar primeiro.
//
// Três coisas que nenhuma cópia estática consegue fazer depois do fato:
//
//  1. RECURSO QUE O JAVASCRIPT BUSCA. Modelo .glb, textura .ktx2, mapa .hdr,
//     JSON do Lottie, .wasm, pedaço de bundle carregado por import() — nada
//     disso aparece no HTML nem no CSS. Só existe como uma chamada de rede.
//     Aqui a gente anota TODAS elas.
//
//  2. CANVAS 3D EM BRANCO. WebGL apaga o buffer de desenho depois de cada
//     quadro, a menos que o contexto tenha nascido com preserveDrawingBuffer.
//     Sem isso, canvas.toDataURL() devolve um retângulo preto — que é
//     exatamente o que a versão antiga salvava no lugar da cena 3D. Como o
//     atributo só pode ser pedido na CRIAÇÃO do contexto, tem que ser agora.
//
//  3. SHADOW ROOT FECHADO. Web component com mode:'closed' (spline-viewer,
//     model-viewer e afins) é uma caixa preta para qualquer serializador.
//     Forçar 'open' na criação é a única janela para ver dentro.

(() => {
  if (window.__clonasiteInstr) return;

  const REG = {
    urls: new Set(),
    blobs: new Map(), // url do blob -> tipo MIME
    streams: new Set(), // MediaSource: vídeo montado em pedaços, não vira arquivo
    canvas3d: 0,
  };
  window.__clonasiteInstr = REG;

  // Este arquivo roda em TODA página que a pessoa abre, o tempo todo. Segurar
  // blob é segurar memória: os tetos aqui são o que impede um player de vídeo
  // ou um editor de imagem de transformar isso num vazamento.
  const BLOB_MAX = 4 * 1024 * 1024;
  const BLOB_LIMITE = 40;
  const BLOB_TOTAL = 64 * 1024 * 1024;
  let blobBytes = 0;

  const anotar = (u) => {
    if (!u) return;
    const bruto = String(u);
    if (!bruto || bruto.startsWith('data:') || bruto.startsWith('blob:')) return;
    try {
      const abs = new URL(bruto, document.baseURI || location.href).href;
      if (/^https?:/i.test(abs)) REG.urls.add(abs);
    } catch {
      /* URL impossível de resolver: não serve para nada mesmo */
    }
  };

  // ------------------------------------------------- 1. tudo que a página baixa

  // O PerformanceObserver com buffered:true entrega até o que já aconteceu
  // antes desta linha, e — diferente do buffer de resource timing — não tem
  // teto: ele continua entregando mesmo depois que o buffer enche.
  try {
    performance.setResourceTimingBufferSize(5000);
  } catch {
    /* navegador sem a chamada */
  }
  try {
    new PerformanceObserver((lista) => {
      for (const e of lista.getEntries()) anotar(e.name);
    }).observe({ type: 'resource', buffered: true });
  } catch {
    /* sem PerformanceObserver: sobra o getEntriesByType lá no capture */
  }

  // fetch e XHR entram no observer também, mas só depois de completarem. Um
  // pedido que ainda está no ar quando a cópia acontece só aparece aqui.
  const fetch0 = window.fetch;
  if (typeof fetch0 === 'function') {
    window.fetch = function (entrada, init) {
      try {
        anotar(typeof entrada === 'string' ? entrada : entrada && entrada.url);
      } catch {
        /* Request exótico */
      }
      return fetch0.apply(this, arguments);
    };
  }
  const abrir0 = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (metodo, url) {
    try {
      anotar(url);
    } catch {
      /* idem */
    }
    return abrir0.apply(this, arguments);
  };

  // ------------------------------------------------- 2. canvas 3D

  const getContext0 = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (tipo, attrs) {
    const t = String(tipo || '').toLowerCase();
    const ehGL = t === 'webgl' || t === 'webgl2' || t === 'experimental-webgl';
    let a = attrs;
    if (ehGL) {
      // preserveDrawingBuffer custa um pouco de desempenho e é por isso que
      // ninguém liga. Aqui ele é a diferença entre salvar a cena e salvar preto.
      a = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
    }
    const ctx = getContext0.call(this, tipo, a);
    if (ctx) {
      try {
        // O mundo isolado não enxerga variável daqui, mas enxerga o DOM: o
        // atributo é o recado para o capture.js saber que canvas é qual.
        this.setAttribute('data-clonasite-ctx', t);
        if (ehGL || t === 'webgpu') REG.canvas3d++;
      } catch {
        /* canvas fora do documento */
      }
    }
    return ctx;
  };

  // Mesma história para OffscreenCanvas usado com transferControlToOffscreen:
  // sem preserveDrawingBuffer o quadro nunca pode ser lido de volta.
  if (typeof OffscreenCanvas === 'function') {
    const off0 = OffscreenCanvas.prototype.getContext;
    OffscreenCanvas.prototype.getContext = function (tipo, attrs) {
      const t = String(tipo || '').toLowerCase();
      if (t === 'webgl' || t === 'webgl2') {
        return off0.call(this, tipo, Object.assign({}, attrs || {}, { preserveDrawingBuffer: true }));
      }
      return off0.apply(this, arguments);
    };
  }

  // ------------------------------------------------- 3. shadow root fechado

  const attachShadow0 = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const aberto = Object.assign({}, init || {}, { mode: 'open' });
    return attachShadow0.call(this, aberto);
  };

  // ------------------------------------------------- 4. blob que não some

  // Imagem gerada em memória (crop, canvas, decodificador de textura) vive numa
  // URL blob: que o site revoga assim que termina de usar. Depois de revogada
  // não dá mais para ler o conteúdo — e a cópia fica com um src morto. Segurar
  // as pequenas é o que permite embutir a imagem no clone.
  const criar0 = URL.createObjectURL;
  const revogar0 = URL.revokeObjectURL;
  URL.createObjectURL = function (obj) {
    const url = criar0.call(URL, obj);
    try {
      if (typeof MediaSource === 'function' && obj instanceof MediaSource) {
        REG.streams.add(url);
      } else if (
        obj &&
        typeof obj.size === 'number' &&
        obj.size <= BLOB_MAX &&
        REG.blobs.size < BLOB_LIMITE &&
        blobBytes + obj.size <= BLOB_TOTAL
      ) {
        REG.blobs.set(url, obj.type || '');
        blobBytes += obj.size;
      }
    } catch {
      /* objeto estranho: deixa passar */
    }
    return url;
  };
  URL.revokeObjectURL = function (url) {
    // Segurar poucos e pequenos: o teto acima é o que impede um player de
    // streaming de encher a memória com milhares de pedaços.
    if (REG.blobs.has(url)) return;
    return revogar0.call(URL, url);
  };

  // ------------------------------------------------- o que o site usa

  // Só o mundo principal enxerga as variáveis da página. Saber que o site roda
  // GSAP + ScrollTrigger + Lenis, e não Framer Motion, muda tudo na hora de
  // pedir para alguém refazer as animações: é a diferença entre "reproduza o
  // movimento" e "reproduza o movimento COM ESTAS ferramentas".
  const BIBLIOTECAS = [
    ['GSAP', () => window.gsap || window.TweenMax || window.TweenLite],
    ['GSAP ScrollTrigger', () => window.ScrollTrigger || (window.gsap && window.gsap.plugins && window.gsap.plugins.scrollTrigger)],
    ['Lenis (smooth scroll)', () => window.Lenis || window.lenis],
    ['Locomotive Scroll', () => window.LocomotiveScroll || window.locomotive],
    ['AOS', () => window.AOS],
    ['ScrollReveal', () => window.ScrollReveal],
    ['WOW.js', () => window.WOW],
    ['Framer Motion', () => window.Motion || document.querySelector('[data-framer-appear-id]')],
    ['Motion One', () => window.motion && window.motion.animate],
    ['Three.js', () => window.THREE],
    ['Spline', () => window.spline || document.querySelector('spline-viewer')],
    ['Babylon.js', () => window.BABYLON],
    ['PixiJS', () => window.PIXI],
    ['p5.js', () => window.p5],
    ['Lottie', () => window.lottie || window.bodymovin || document.querySelector('lottie-player,dotlottie-player')],
    ['Rive', () => window.rive],
    ['Vanta', () => window.VANTA],
    ['Swiper', () => window.Swiper],
    ['Splide', () => window.Splide],
    ['Barba.js', () => window.barba],
    ['SplitType/SplitText', () => window.SplitType || window.SplitText],
    ['anime.js', () => window.anime],
    ['Velocity', () => window.Velocity],
    ['jQuery', () => window.jQuery],
    ['Alpine.js', () => window.Alpine],
    ['React', () => window.React || window.__REACT_DEVTOOLS_GLOBAL_HOOK__],
    ['Vue', () => window.Vue || window.__VUE__ || window.__VUE_DEVTOOLS_GLOBAL_HOOK__],
    ['Svelte', () => window.__svelte],
  ];

  const detectarBibliotecas = () => {
    const achadas = [];
    for (const [nome, teste] of BIBLIOTECAS) {
      try {
        if (teste()) achadas.push(nome);
      } catch {
        /* acessar a variável estourou: conta como ausente */
      }
    }
    return achadas;
  };

  // ------------------------------------------------- ponte com o capturador

  // O capture.js roda no mundo isolado e não enxerga nada daqui. Evento no DOM
  // atravessa; objeto, não — por isso o texto JSON.
  document.addEventListener('clonasite:pedir-rede', () => {
    let carga = '{}';
    try {
      carga = JSON.stringify({
        urls: [...REG.urls],
        blobs: [...REG.blobs.keys()],
        streams: [...REG.streams],
        canvas3d: REG.canvas3d,
        libs: detectarBibliotecas(),
      });
    } catch {
      /* nada a declarar */
    }
    document.dispatchEvent(new CustomEvent('clonasite:rede', { detail: carga }));
  });
})();
