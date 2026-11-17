// Roda dentro da página (mundo isolado), injetado por chrome.scripting.
// Define a função global; o painel a chama num segundo executeScript.
self.__clonasiteCapture = async function (incomingOpts) {
  const OPTS = Object.assign(
    {
      keepScripts: true,
      inlineShadowDom: true,
      freezeCanvas: true,
      autoScroll: true,
      unlockAnimations: true,
      slowScan: true,
      modoOriginal: false,
      // Deixa o canvas WebGL/WebGPU VIVO em vez de virar figura: é o que faz a
      // cena 3D continuar girando na cópia. O quadro congelado vira o fundo,
      // então mesmo se o script não rodar ainda se enxerga a cena.
      manter3D: true,
      // Anota tudo que a página baixou de fato — inclusive o que só o
      // JavaScript pediu: modelo .glb, textura, .hdr, Lottie, wasm, chunk.
      capturarRede: true,
      // Converte blob: (imagem gerada em memória) em data: antes que suma.
      resgatarBlobs: true,
      // Anota o estado inicial de cada revelação para a cópia refazer a
      // animação por conta própria, sem depender da biblioteca do site.
      animarNaCopia: true,
    },
    incomingOpts || {}
  );

  // Modo original: reproduz a captura da primeira versão, antes de qualquer
  // varredura, resgate de imagem preguiçosa ou mexida em animação. Serve para
  // comparar lado a lado e ver o que cada camada dessas mudou de verdade.
  const ORIGINAL = !!OPTS.modoOriginal;

  const MAX_IMPORT_DEPTH = 8;
  const MAX_SCROLL_STEPS = 60; // trava contra página de rolagem infinita
  const SCROLL_BUDGET_MS = 30000; // teto de tempo para a varredura
  const IMG_WAIT_MS = 5000;
  const FONT_WAIT_MS = 3000;
  const REDE_BUDGET_MS = 6000; // espera o 3D e o vídeo terminarem de chegar

  const stats = {
    elements: 0,
    shadowRoots: 0,
    sheets: 0,
    canvases: 0,
    imagens: 0,
    midias: 0,
    midiasStreaming: 0,
    midiasResgatadas: 0,
    imagensCarregadas: 0,
    lazyResgatadas: 0,
    fundosResgatados: 0,
    animacoesDestravadas: 0,
    animacoesPreservadas: 0,
    animacoesConcluidas: 0,
    animacoesParaRefazer: 0,
    telasVarridas: 0,
    canvas3d: 0,
    canvas3dVivos: 0,
    canvasVazios: 0,
    blobsResgatados: 0,
    postersGerados: 0,
    redeVista: 0,
    iframes: 0,
  };

  // A varredura de uma página pesada leva quase um minuto. Sem dar notícia, o
  // painel fica parado nos mesmos 5% esse tempo todo e parece travado — foi
  // exatamente essa a queixa. O recado sai daqui e chega no painel na hora,
  // porque quem escuta é outro contexto: a barra anda mesmo com esta página
  // ocupada. Fora da extensão (motor de servidor, teste) não existe
  // chrome.runtime, então o aviso simplesmente não acontece.
  const avisar = (texto, fracao) => {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
      // A forma com callback engole o "não há quem receba" quando o painel
      // fechou no meio; a forma com Promise viraria rejeição solta no console.
      chrome.runtime.sendMessage({ type: 'clonasite:progresso', texto, fracao }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      /* contexto da extensão invalidado */
    }
  };

  // Botão de parar do painel, e também a saída de emergência quando a varredura
  // passa do prazo: sem isso a captura antiga continuaria rolando a página por
  // baixo da segunda tentativa, e as duas se atrapalhariam.
  self.__clonasiteAbortar = false;
  const abortado = () => self.__clonasiteAbortar === true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Nem todo ambiente que roda este arquivo tem rAF (o motor de servidor usa
  // jsdom). Cair no relógio mantém a mesma ordem dos passos.
  const proximoQuadro = () =>
    new Promise((r) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => r());
      else setTimeout(r, 16);
    });
  const CSS_URL_RE = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;

  const abs = (url, base) => {
    if (!url) return null;
    const trimmed = String(url).trim();
    if (!trimmed) return null;
    // Âncora interna tem que continuar interna: absolutizar quebraria o link.
    if (trimmed.startsWith('#')) return trimmed;
    if (/^(data|blob|about|javascript|mailto|tel|sms):/i.test(trimmed)) return trimmed;
    try {
      return new URL(trimmed, base || document.baseURI).href;
    } catch {
      return null;
    }
  };

  const absolutizeCss = (css, base) => {
    if (!css) return css;
    return css
      .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
        const r = abs(u, base);
        return r ? 'url("' + r + '")' : m;
      })
      .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
        const r = abs(u, base);
        return r ? '@import "' + r + '"' : m;
      });
  };

  // ------------------------------------------- 0. o que a página baixou
  // O HTML e o CSS só contam metade da história. Um site com three.js, Spline,
  // Lottie ou player de vídeo busca o pesado por JavaScript: .glb, .gltf, .bin,
  // .hdr, .ktx2, .drc, .wasm, JSON de animação, pedaço de bundle. Nada disso
  // está escrito em lugar nenhum do documento — só existe como chamada de rede.
  // Sem esta lista, a cópia sai sem o 3D e sem a animação, por mais bem feita
  // que esteja a serialização do DOM.

  const pedirRede = () =>
    new Promise((resolve) => {
      let respondeu = false;
      const ouvir = (ev) => {
        respondeu = true;
        document.removeEventListener('clonasite:rede', ouvir);
        try {
          resolve(JSON.parse(ev.detail));
        } catch {
          resolve(null);
        }
      };
      document.addEventListener('clonasite:rede', ouvir);
      document.dispatchEvent(new Event('clonasite:pedir-rede'));
      // Se o instrumentar.js não chegou a rodar (página aberta antes de
      // instalar a extensão), ninguém responde: segue sem ele.
      setTimeout(() => {
        if (respondeu) return;
        document.removeEventListener('clonasite:rede', ouvir);
        resolve(null);
      }, 600);
    });

  const coletarRede = async () => {
    const urls = new Set();
    const streams = new Set();
    if (!OPTS.capturarRede || ORIGINAL) return { urls: [], streams: [], blobs: [], libs: [] };

    // Resource Timing enxerga tudo que passou pela rede, inclusive de outra
    // origem (o tempo vem zerado sem CORS, mas o endereço vem inteiro).
    try {
      for (const e of performance.getEntriesByType('resource')) {
        if (/^https?:/i.test(e.name)) urls.add(e.name);
      }
    } catch {
      /* navegador sem a API */
    }

    const doGravador = await pedirRede();
    let blobs = [];
    let libs = [];
    if (doGravador) {
      for (const u of doGravador.urls || []) urls.add(u);
      for (const u of doGravador.streams || []) streams.add(u);
      blobs = doGravador.blobs || [];
      libs = doGravador.libs || [];
    }
    stats.redeVista = urls.size;
    return { urls: [...urls], streams: [...streams], blobs, libs };
  };

  // O que o site é, por dentro. Quem vai refazer a página precisa saber com o
  // que está lidando — Webflow com GSAP não se refaz do mesmo jeito que um Next
  // com Framer Motion. A marca do construtor está no DOM; a das bibliotecas,
  // nas variáveis do mundo principal (que vêm pela ponte) e nos nomes dos
  // arquivos que a rede viu passar.
  const PELO_DOM = [
    ['Next.js', '#__next, script#__NEXT_DATA__'],
    ['Nuxt', '#__nuxt, #__layout'],
    ['Angular', '[ng-version]'],
    ['Vue (SSR)', '[data-server-rendered]'],
    ['React', '#root, [data-reactroot]'],
    ['Webflow', 'html[data-wf-page], [data-wf-site]'],
    ['Framer', '[data-framer-name], #main[data-framer-hydrate-v2]'],
    ['WordPress + Elementor', '.elementor, body.elementor-page'],
    ['WordPress', 'link[href*="wp-content"], body.wp-singular'],
    ['Shopify', '[data-shopify], #shopify-section-header'],
    ['Squarespace', '[data-sqsp-site], body#collection'],
    ['Wix', '#SITE_CONTAINER, [data-wix-editor]'],
    ['Astro', '[astro-island], astro-island'],
    ['Svelte', '[data-svelte-h]'],
  ];
  const PELA_REDE = [
    ['GSAP', /gsap|tweenmax/i],
    ['GSAP ScrollTrigger', /scrolltrigger/i],
    ['Lenis (smooth scroll)', /lenis/i],
    ['Locomotive Scroll', /locomotive/i],
    ['AOS', /aos(\.|-)/i],
    ['Three.js', /three(\.min)?\.js|three\.module/i],
    ['Spline', /spline/i],
    ['Lottie', /lottie|bodymovin/i],
    ['Rive', /rive/i],
    ['Swiper', /swiper/i],
    ['Framer Motion', /framer-motion/i],
    ['Barba.js', /barba/i],
    ['ScrollReveal', /scrollreveal/i],
    ['Splitting/SplitType', /split(ting|type|text)/i],
    ['Tailwind CSS', /tailwind/i],
    ['Bootstrap', /bootstrap/i],
  ];

  const detectarTecnologias = (rede) => {
    const construtor = [];
    for (const [nome, seletor] of PELO_DOM) {
      try {
        if (document.querySelector(seletor)) construtor.push(nome);
      } catch {
        /* seletor recusado pelo navegador */
      }
    }
    const libs = new Set(rede.libs || []);
    for (const url of rede.urls || []) {
      for (const [nome, padrao] of PELA_REDE) {
        if (padrao.test(url)) libs.add(nome);
      }
    }
    return { construtor, libs: [...libs] };
  };

  // --------------------------------------------- blob: vira data: na hora
  // O mundo isolado divide a origem com a página, então dá para ler um blob:
  // criado por ela. Fora daqui não dá — nem o painel nem o HTML salvo
  // conseguiriam. É agora ou nunca.

  const BLOB_MAX = 8 * 1024 * 1024;
  const BLOB_TOTAL = 40 * 1024 * 1024;
  const blobData = new Map();

  const lerComoDataUri = (blob) =>
    new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('não deu para ler'));
      fr.readAsDataURL(blob);
    });

  const resgatarBlobs = async (extras) => {
    if (!OPTS.resgatarBlobs || ORIGINAL) return;
    const alvos = new Set(extras || []);
    for (const node of document.querySelectorAll('img, video, audio, source, image, embed, object, [style*="blob:"]')) {
      for (const attr of ['src', 'href', 'xlink:href', 'poster', 'data', 'srcset', 'style']) {
        const v = node.getAttribute && node.getAttribute(attr);
        if (v && v.includes('blob:')) {
          for (const m of v.matchAll(/blob:[^\s'")]+/gi)) alvos.add(m[0]);
        }
      }
      if (node.currentSrc && node.currentSrc.startsWith('blob:')) alvos.add(node.currentSrc);
    }

    let total = 0;
    for (const url of alvos) {
      if (blobData.has(url)) continue;
      try {
        const res = await fetch(url);
        const blob = await res.blob();
        // Vídeo de MediaSource não chega aqui: o fetch estoura antes.
        if (!blob.size || blob.size > BLOB_MAX || total + blob.size > BLOB_TOTAL) continue;
        blobData.set(url, await lerComoDataUri(blob));
        total += blob.size;
        stats.blobsResgatados++;
      } catch {
        /* blob já revogado ou é MediaSource: não vira arquivo */
      }
    }
  };

  // ------------------------------------------------- 1. acordar a página
  // Grande parte das imagens que "não vêm" é lazy-load: elas só existem depois
  // que alguém rola até elas. Então rolamos por você antes de copiar.

  const LAZY_ATTRS = [
    'data-src',
    'data-original',
    'data-original-src',
    'data-lazy-src',
    'data-lazy',
    'data-echo',
    'data-url',
    'data-image',
    'data-img',
    'data-hi-res-src',
    'data-full-src',
    'data-actualsrc',
    'data-defer-src',
  ];
  const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset', 'data-original-set'];
  const LAZY_BG_ATTRS = ['data-bg', 'data-background', 'data-background-image', 'data-bg-src'];

  const widestFromSrcset = (value, base) => {
    let best = null;
    let bestWidth = -1;
    for (const part of String(value).split(',')) {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) continue;
      const w = parseFloat(bits[1]) || 0;
      if (w >= bestWidth) {
        bestWidth = w;
        best = bits[0];
      }
    }
    return best ? abs(best, base) : null;
  };

  const lazyUrlFor = (el, base) => {
    for (const key of LAZY_ATTRS) {
      const v = el.getAttribute(key);
      if (v && v.trim()) return abs(v, base);
    }
    for (const key of LAZY_SRCSET_ATTRS) {
      const v = el.getAttribute(key);
      if (v) return widestFromSrcset(v, base);
    }
    return null;
  };

  // Um src que existe mas não vale nada: gif transparente, SVG cinza, 1x1.
  const looksLikePlaceholder = (img) => {
    const src = img.currentSrc || img.src || '';
    if (!src) return true;
    if (/^data:/i.test(src)) return true;
    if (/(^|[\/_-])(blank|placeholder|spacer|pixel|dummy|loader|loading|lazy)[._-]/i.test(src)) return true;
    if (img.complete && img.naturalWidth > 0 && img.naturalWidth <= 4 && img.naturalHeight <= 4) return true;
    return false;
  };

  const waitForImages = async (budget) => {
    const pending = [...document.images].filter((img) => img.src && !img.complete);
    if (!pending.length) return;
    await Promise.race([
      Promise.all(
        pending.map(
          (img) =>
            new Promise((res) => {
              img.addEventListener('load', res, { once: true });
              img.addEventListener('error', res, { once: true });
            })
        )
      ),
      sleep(budget),
    ]);
  };

  // A Web Animations API enxerga animação CSS e transition. Dá para esperar
  // elas terminarem em vez de chutar um sleep — e para adiantar as que ficaram
  // pela metade quando a varredura passou.
  const animacoesFinitas = () => {
    let todas;
    try {
      todas = document.getAnimations();
    } catch {
      return []; // navegador sem a API
    }
    return todas.filter((a) => {
      try {
        const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
        // Animação em loop (spinner, gradiente girando) nunca termina: deixa quieta.
        return t && t.iterations !== Infinity && t.endTime !== Infinity;
      } catch {
        return false;
      }
    });
  };

  const esperarAnimacoes = async (budget) => {
    const rodando = animacoesFinitas().filter((a) => a.playState === 'running');
    if (!rodando.length) return;
    await Promise.race([Promise.allSettled(rodando.map((a) => a.finished)), sleep(budget)]);
  };

  // Adianta para o quadro final o que ainda estiver no meio do caminho.
  const concluirAnimacoes = () => {
    for (const a of animacoesFinitas()) {
      try {
        a.finish();
        stats.animacoesConcluidas++;
      } catch {
        /* algumas não aceitam finish() */
      }
    }
  };

  // Biblioteca de rolagem suave (Lenis, Locomotive, GSAP) troca o scrollTo por
  // uma versão animada. Mexer no scrollTop direto passa por cima disso.
  const irPara = (scroller, y) => {
    try {
      scroller.scrollTo({ top: y, left: 0, behavior: 'instant' });
    } catch {
      // Site que troca o scrollTo por uma versão própria às vezes deixa uma
      // função que não aceita objeto — ou nem função é. Nada disso pode
      // derrubar a clonagem inteira: scrollTop sozinho já rola.
      try {
        scroller.scrollTo(0, y);
      } catch {
        /* segue no scrollTop */
      }
    }
    try {
      scroller.scrollTop = y;
    } catch {
      /* documento sem scroller */
    }
  };

  // Espera a rolagem parar de verdade, em vez de chutar um sleep. Essas
  // bibliotecas escrevem transform no container enquanto a rolagem viaja: se a
  // cópia sair no meio do caminho, a página inteira vem deslocada.
  const esperarRolagemParar = async (scroller, budget) => {
    const limite = Date.now() + budget;
    let anterior = NaN;
    let estaveis = 0;
    while (Date.now() < limite && estaveis < 5) {
      await proximoQuadro();
      const atual = Math.round(scroller.scrollTop);
      if (atual === anterior) estaveis++;
      else {
        estaveis = 0;
        anterior = atual;
      }
    }
  };

  const primePage = async () => {
    const scrollerRaiz = document.scrollingElement || document.documentElement;
    const posicaoOriginal = scrollerRaiz.scrollTop;

    for (const img of document.images) {
      if (img.loading === 'lazy') img.loading = 'eager';
      if (img.decoding === 'async') img.decoding = 'sync';
    }
    for (const frame of document.querySelectorAll('iframe[loading="lazy"]')) frame.loading = 'eager';

    // Passo curto e pausa longa. Animação de entrada leva de 0,6 a 1,2 segundo:
    // varrer mais rápido que isso é passar por cima sem ver nada acontecer.
    const pausa = OPTS.slowScan ? 750 : 300;
    const esperaPorTela = OPTS.slowScan ? 1200 : 500;

    if (OPTS.autoScroll) {
      const scroller = scrollerRaiz;
      const step = Math.max(260, Math.round(window.innerHeight * 0.7));
      const prazo = Date.now() + SCROLL_BUDGET_MS;

      // Descida: é o que dispara os observers de lazy-load e de revelação.
      const telasPrevistas = Math.max(1, Math.ceil(scroller.scrollHeight / step));
      for (let i = 0; i < MAX_SCROLL_STEPS; i++) {
        const target = i * step;
        if (target > scroller.scrollHeight) break;
        irPara(scroller, target);
        avisar(
          'Rolando a página · tela ' + (i + 1) + ' de ' + Math.min(telasPrevistas, MAX_SCROLL_STEPS),
          Math.min(0.75, (Date.now() - (prazo - SCROLL_BUDGET_MS)) / SCROLL_BUDGET_MS)
        );
        await sleep(pausa);
        // Em vez de chutar mais um sleep, espera as animações desta tela.
        await esperarAnimacoes(esperaPorTela);
        stats.telasVarridas++;
        if (Date.now() > prazo || abortado()) break;
      }

      avisar('Chegando no fim da página…', 0.78);
      irPara(scroller, scroller.scrollHeight);
      await sleep(pausa);
      await esperarAnimacoes(esperaPorTela);

      // Volta para o TOPO, não para onde o usuário estava. Uma cópia de página
      // representa o começo dela, e é no topo que os transforms de rolagem
      // voltam ao valor inicial. A posição original é devolvida depois da cópia.
      avisar('Voltando ao topo…', 0.82);
      irPara(scroller, 0);
      await esperarRolagemParar(scroller, 2500);
      await esperarAnimacoes(esperaPorTela);
      await sleep(300);
    }

    if (abortado()) return posicaoOriginal;
    avisar('Esperando as fontes…', 0.86);
    // Fonte que ainda não chegou vira caixinha vazia no clone.
    try {
      if (document.fonts && document.fonts.ready) {
        await Promise.race([document.fonts.ready, sleep(FONT_WAIT_MS)]);
      }
    } catch {
      /* navegador sem a API */
    }

    avisar('Esperando as imagens…', 0.9);
    await waitForImages(IMG_WAIT_MS);
    await esperarAnimacoes(esperaPorTela);
    concluirAnimacoes();
    return posicaoOriginal;
  };

  // Cena 3D, player de vídeo e Lottie continuam baixando DEPOIS que a rolagem
  // acaba: modelo, textura, mapa de ambiente, primeiro pedaço do vídeo. Esperar
  // a rede sossegar é o que separa a cópia com a cena montada da cópia com a
  // cena pela metade.
  const esperarRedeCalma = async (budget = 9000, calmaria = 1200) => {
    const conta = () => {
      try {
        return performance.getEntriesByType('resource').length;
      } catch {
        return 0;
      }
    };
    const prazo = Date.now() + budget;
    let anterior = conta();
    let paradoDesde = Date.now();
    while (Date.now() < prazo && !abortado()) {
      await sleep(250);
      const atual = conta();
      if (atual !== anterior) {
        anterior = atual;
        paradoDesde = Date.now();
      } else if (Date.now() - paradoDesde >= calmaria) {
        return;
      }
    }
  };

  // A v1 lia o DOM do jeito que estava, sem tocar na rolagem.
  const posicaoOriginal = ORIGINAL
    ? (document.scrollingElement || document.documentElement).scrollTop
    : await primePage();

  if (!ORIGINAL) {
    avisar('Esperando o 3D e o vídeo terminarem de chegar…', 0.93);
    await esperarRedeCalma(REDE_BUDGET_MS);
    // Dois quadros de folga: com preserveDrawingBuffer ligado, o que fica no
    // buffer é o ÚLTIMO quadro desenhado. Ler no meio de um é ler tela preta.
    await proximoQuadro();
    await proximoQuadro();
  }

  // Só agora, e nesta ordem: a varredura acima é o que disparou o download do
  // 3D e do vídeo. Perguntar antes dela seria perguntar cedo demais.
  const rede = await coletarRede();
  await resgatarBlobs(rede.blobs);

  // ---------------------------------------------------------------- CSS

  const readRules = (sheet) => {
    try {
      return sheet.cssRules;
    } catch {
      return null; // cross-origin sem CORS: o painel baixa pelo href
    }
  };

  const rulesToText = (sheet, depth = 0) => {
    const rules = readRules(sheet);
    if (!rules) return null;
    let out = '';
    for (const rule of rules) {
      // CSSImportRule = 3. Tenta achatar; se não der, deixa o @import para o painel.
      if (rule.type === 3) {
        const nested =
          depth < MAX_IMPORT_DEPTH && rule.styleSheet ? rulesToText(rule.styleSheet, depth + 1) : null;
        out += (nested !== null ? nested : rule.cssText) + '\n';
      } else {
        out += rule.cssText + '\n';
      }
    }
    // O Chrome já devolve url() absoluta no cssText, mas isso não é garantido
    // em todo lugar. absolutizeCss é idempotente, então roda sempre.
    return absolutizeCss(out, sheet.href || document.baseURI);
  };

  // A ordem das folhas define a cascata, então percorre na ordem do documento
  // em vez de confiar em document.styleSheets — que pula <link> ainda pendente.
  const collectSheets = () => {
    const sheets = [];
    const done = new Set();

    const push = (sheet, label) => {
      const text = rulesToText(sheet);
      if (text === null && !sheet.href) return; // ilegível e sem fonte: ignora
      done.add(sheet);
      sheets.push({
        text,
        href: sheet.href || null,
        media: sheet.media && sheet.media.mediaText ? sheet.media.mediaText : '',
        label,
      });
      stats.sheets++;
    };

    const byOwner = new Map();
    for (const sheet of document.styleSheets) {
      if (sheet.ownerNode) byOwner.set(sheet.ownerNode, sheet);
    }

    for (const node of document.querySelectorAll('style, link[rel~="stylesheet" i]')) {
      const sheet = byOwner.get(node);
      if (sheet) {
        if (!sheet.disabled) push(sheet, sheet.href || 'inline');
      } else if (node.tagName === 'LINK' && node.href && !node.disabled) {
        // Ainda carregando ou falhou: registra pelo href para o painel baixar.
        sheets.push({ text: null, href: node.href, media: node.media || '', label: 'link-pendente' });
        stats.sheets++;
      }
    }

    // Rede de segurança: qualquer folha que a varredura por nó não alcançou —
    // <link> com rel escrito de outro jeito, folha injetada via CSSOM, nó já
    // removido do DOM. Antes isso era descartado calado, e o CSS sumia.
    for (const sheet of document.styleSheets) {
      if (!done.has(sheet) && !sheet.disabled) push(sheet, sheet.ownerNode ? 'fora-de-ordem' : 'sem-dono');
    }
    for (const sheet of document.adoptedStyleSheets || []) {
      if (!done.has(sheet)) push(sheet, 'adopted');
    }

    return sheets;
  };

  avisar('Lendo as folhas de estilo…', 0.96);
  const sheets = collectSheets();

  // ----------------------------------------------- destravar animações
  // AOS, ScrollReveal, WOW, GSAP e Framer deixam o elemento em opacity:0 até ele
  // entrar na tela. Na cópia estática esse scroll nunca acontece, então o que
  // ficou para trás sumiria de vez. Aqui a gente devolve a visibilidade.

  const REVEAL_ATTRS = [
    'data-aos',
    'data-sr-id',
    'data-scroll',
    'data-animate',
    'data-reveal',
    'data-wow-delay',
    'data-anim',
    'data-framer-appear-id',
  ];
  const REVEAL_CLASS =
    /(^|\s)(wow|reveal|revealed|animate__animated|scroll-animate|aos-init|fade-up|fade-in|fade-left|fade-right|slide-up|slide-in|zoom-in)(\s|$)/;
  // Coisa escondida de proposito: modal, dropdown, tooltip. Não mexer.
  const DELIBERATE = '[role="dialog"], [role="tooltip"], [aria-hidden="true"], .modal, .popup, .overlay, .dropdown, .tooltip, dialog';

  const hasRevealMarker = (el) => {
    for (const attr of REVEAL_ATTRS) if (el.hasAttribute(attr)) return true;
    return typeof el.className === 'string' && REVEAL_CLASS.test(el.className);
  };

  const unlockAnimation = (orig, copy) => {
    if (ORIGINAL || !OPTS.unlockAnimations) return;

    // As duas leituras baratas vêm primeiro, e isso importa muito mais do que
    // parece: getComputedStyle força o navegador a recalcular estilo, e chamar
    // isso para CADA elemento de uma página de dez mil nós custava dezenas de
    // segundos com o painel parado. Quem não tem opacity no style= nem marca de
    // biblioteca não é candidato a nada — sai antes de pagar esse preço.
    // GSAP e Framer escrevem opacity direto no style=; AOS e WOW usam classe.
    const inlineOpacity = orig.style.opacity;
    const byLibrary = inlineOpacity !== '' && parseFloat(inlineOpacity) <= 0.05;
    const temMarcador = !byLibrary && hasRevealMarker(orig);
    if (!byLibrary && !temMarcador) return;

    const computed = getComputedStyle(orig);
    if (computed.display === 'none') return; // some de proposito
    if (computed.position === 'fixed') return; // quase sempre modal/barra flutuante

    const byMarker = temMarcador && parseFloat(computed.opacity) <= 0.5;
    if (!byLibrary && !byMarker) return;
    if (orig.closest(DELIBERATE)) return;

    // O estado inicial da revelação, lido antes de ser desfeito logo abaixo.
    const opacidadeDe = byLibrary ? inlineOpacity : computed.opacity;
    const transformDe = byLibrary ? orig.style.transform : computed.transform;

    // GSAP e Framer escreveram no style= da página viva. Apagar o que eles
    // escreveram devolve o controle ao CSS do site — e a animação volta a tocar.
    if (byLibrary) {
      copy.style.removeProperty('opacity');
      copy.style.removeProperty('transform');
      copy.style.removeProperty('visibility');
    }

    // Se existe uma animação declarada, ela toca de novo quando a cópia abrir e
    // termina visível. Não escrever nada aqui é o que a deixa acontecer.
    const temAnimacao = computed.animationName && computed.animationName !== 'none';
    if (temAnimacao) {
      stats.animacoesPreservadas++;
      return;
    }

    // Não há animação declarada para tocar: sem ajuda, este elemento fica
    // parado na cópia para sempre. O estado inicial vai anotado para o
    // src/animar.js refazer a revelação na hora em que ele entrar na tela —
    // sem depender da biblioteca do site subir, que é o que quase nunca
    // acontece num arquivo estático, e era por isso que a cópia vinha morta.
    if (OPTS.animarNaCopia) {
      const partes = [];
      if (opacidadeDe !== '' && parseFloat(opacidadeDe) <= 0.5) partes.push('opacity:' + opacidadeDe);
      if (transformDe && transformDe !== 'none') partes.push('transform:' + transformDe);
      if (partes.length) {
        copy.setAttribute('data-clonasite-de', partes.join(';'));
        stats.animacoesParaRefazer++;
      }
    }

    // Sem animação para tocar, aí sim garante a visibilidade — em prioridade
    // normal, NUNCA com !important. Na cascata do CSS o !important fica ACIMA
    // das animações, então ele congelaria justamente o que queremos ver rodar.
    copy.style.setProperty('opacity', '1');
    copy.style.setProperty('visibility', 'visible');
    if (byLibrary || computed.transform !== 'none') {
      copy.style.setProperty('transform', 'none');
    }
    stats.animacoesDestravadas++;
  };

  // ---------------------------------------------------------------- DOM

  const pendingReplacements = [];
  const pendingRemovals = [];

  const resolveImageSrc = (orig, base) => {
    if (ORIGINAL) {
      // v1: só olhava data-* quando o src estava vazio. Nada de detectar
      // placeholder, nada de cair no srcset ou no <picture>.
      const atual = orig.currentSrc || orig.src || '';
      if (atual) return atual;
      for (const key of ['data-src', 'data-original', 'data-lazy-src', 'data-srcset']) {
        const v = orig.getAttribute(key);
        if (v) return abs(v.split(',')[0].trim().split(/\s+/)[0], base) || '';
      }
      return '';
    }

    let real = orig.currentSrc || orig.src || '';
    if (real.startsWith('blob:') && blobData.has(real)) return blobData.get(real);
    const lazy = lazyUrlFor(orig, base);
    if (lazy && (!real || looksLikePlaceholder(orig))) {
      stats.lazyResgatadas++;
      return lazy;
    }
    if (real) return real;

    // Nunca carregou e não tem data-*: tenta o próprio srcset.
    if (orig.hasAttribute('srcset')) {
      real = widestFromSrcset(orig.getAttribute('srcset'), base) || '';
      if (real) return real;
    }
    // Último recurso: os <source> do <picture> que envolve este <img>.
    const picture = orig.parentElement && orig.parentElement.tagName === 'PICTURE' ? orig.parentElement : null;
    if (picture) {
      for (const source of picture.querySelectorAll('source')) {
        const candidate =
          source.getAttribute('srcset') || source.getAttribute('data-srcset') || source.getAttribute('src');
        const url = candidate ? widestFromSrcset(candidate, base) : null;
        if (url) return url;
      }
    }
    return '';
  };

  // Retrato do canvas. JPEG nas telas grandes: uma cena 3D em PNG passa fácil
  // de 10 MB depois do base64, e isso entra inteiro no HTML salvo.
  const retratoDoCanvas = (canvas) => {
    try {
      const area = (canvas.width || 0) * (canvas.height || 0);
      if (!area) return null;
      let url = area > 1200000 ? canvas.toDataURL('image/jpeg', 0.82) : canvas.toDataURL('image/png');
      if (url && url.length > 6 * 1024 * 1024) url = canvas.toDataURL('image/jpeg', 0.6);
      // Tela de uma cor só comprime para quase nada: é canvas que não desenhou.
      if (!url || url.length < 1200) return null;
      return url;
    } catch {
      return null; // canvas "tainted" por imagem de outra origem
    }
  };

  const fixElement = (orig, copy) => {
    stats.elements++;
    const tag = copy.tagName.toLowerCase();
    const base = orig.baseURI || document.baseURI;

    for (const attr of ['src', 'href', 'poster', 'action', 'formaction', 'data', 'cite']) {
      if (copy.hasAttribute(attr)) {
        const resolved = abs(copy.getAttribute(attr), base);
        if (resolved) copy.setAttribute(attr, resolved);
      }
    }
    // SVG antigo referencia imagem e sprite por xlink:href.
    if (copy.hasAttribute('xlink:href')) {
      const resolved = abs(copy.getAttribute('xlink:href'), base);
      if (resolved) copy.setAttribute('xlink:href', resolved);
    }

    // SRI e crossorigin quebram assim que os arquivos viram locais.
    copy.removeAttribute('integrity');
    copy.removeAttribute('crossorigin');

    // blob: só existe enquanto a aba existir. O que foi resgatado lá em cima
    // vira data: aqui — em qualquer outro lugar já seria tarde demais.
    if (blobData.size) {
      for (const attr of ['src', 'href', 'poster', 'xlink:href']) {
        const v = copy.getAttribute(attr);
        if (v && v.startsWith('blob:') && blobData.has(v)) copy.setAttribute(attr, blobData.get(v));
      }
    }

    if (copy.hasAttribute('style')) {
      copy.setAttribute('style', absolutizeCss(copy.getAttribute('style'), base));
    }

    // Fundo com carregamento preguiçoso guardado num data-*.
    for (const key of ORIGINAL ? [] : LAZY_BG_ATTRS) {
      const v = orig.getAttribute(key);
      if (!v) continue;
      const url = abs(v.replace(/^\s*url\(\s*['"]?|['"]?\s*\)\s*$/g, ''), base);
      const current = getComputedStyle(orig).backgroundImage;
      if (url && (!current || current === 'none')) {
        copy.style.backgroundImage = 'url("' + url + '")';
        stats.fundosResgatados++;
      }
      break;
    }

    unlockAnimation(orig, copy);

    if (tag === 'img') {
      stats.imagens++;
      if (orig.naturalWidth > 0) stats.imagensCarregadas++;

      const real = resolveImageSrc(orig, base);
      if (real) copy.setAttribute('src', real);
      copy.removeAttribute('srcset');
      copy.removeAttribute('sizes');
      copy.removeAttribute('loading');
      for (const key of [...LAZY_ATTRS, ...LAZY_SRCSET_ATTRS]) copy.removeAttribute(key);

      // Congela a largura renderizada para o layout não colapsar offline.
      if (!copy.hasAttribute('width')) {
        const rect = orig.getBoundingClientRect();
        if (rect.width > 0) copy.setAttribute('data-clonasite-w', String(Math.round(rect.width)));
      }
    }

    if (tag === 'video' || tag === 'audio') {
      stats.midias++;
      // currentSrc é a fonte que o navegador escolheu de fato entre os <source>.
      // Fixá-la evita baixar mp4 E webm do mesmo vídeo.
      let real = orig.currentSrc || orig.getAttribute('src') || '';
      if (!real) {
        for (const key of ['data-src', 'data-lazy-src', 'data-video-src', 'data-mp4', 'data-poster-video']) {
          const v = orig.getAttribute(key);
          if (v) {
            real = v;
            break;
          }
        }
      }

      const ehBlob = /^blob:/i.test(real);
      const ehStream = /\.(m3u8|mpd)(\?|$)/i.test(real);

      if (ehBlob && blobData.has(real)) {
        // Vídeo curto servido por blob: cabe embutido e toca offline.
        copy.setAttribute('src', blobData.get(real));
        stats.midiasResgatadas++;
        for (const alternativa of Array.from(copy.querySelectorAll('source'))) pendingRemovals.push(alternativa);
      } else if (ehBlob || ehStream) {
        // Streaming não vira arquivo: o vídeo chega em pedaços montados por JS.
        // A marca deixa o painel tentar trocar por um arquivo de verdade que a
        // gravação de rede tenha visto passar.
        stats.midiasStreaming++;
        copy.setAttribute('data-clonasite-stream', ehStream ? real : 'blob');
        copy.removeAttribute('src');
      } else if (real) {
        const resolvido = abs(real, base);
        if (resolvido) {
          copy.setAttribute('src', resolvido);
          // Com src definido o navegador ignora os <source>; tirá-los evita
          // que o painel baixe cada formato alternativo à toa.
          for (const alternativa of Array.from(copy.querySelectorAll('source'))) {
            pendingRemovals.push(alternativa);
          }
        }
      }
      // Sem currentSrc o vídeo nunca chegou a escolher fonte (preload="none").
      // Aí os <source> ficam: é por eles que o painel descobre o que baixar.

      copy.removeAttribute('loading');
      // preload="none" no clone é um vídeo que abre e não carrega nada.
      if ((copy.getAttribute('preload') || '').toLowerCase() === 'none') copy.setAttribute('preload', 'auto');

      if (tag === 'video') {
        // Vídeo de capa é autoplay + muted + loop. Sem o muted explícito o
        // navegador barra o autoplay e a cópia abre com o vídeo parado.
        if (orig.autoplay || orig.hasAttribute('autoplay')) {
          copy.setAttribute('autoplay', '');
          copy.setAttribute('muted', '');
          copy.muted = true;
        }
        if (orig.loop || orig.hasAttribute('loop')) copy.setAttribute('loop', '');
        if (orig.playsInline || orig.hasAttribute('playsinline')) copy.setAttribute('playsinline', '');

        const poster = orig.getAttribute('poster');
        if (poster) {
          const resolvido = abs(poster, base);
          if (resolvido) copy.setAttribute('poster', resolvido);
        } else if (orig.readyState >= 2 && orig.videoWidth) {
          // Sem poster, um vídeo em streaming vira retângulo preto no clone.
          // O quadro que está na tela agora é melhor que nada — e para HLS é a
          // única imagem que sobra.
          try {
            const tela = document.createElement('canvas');
            tela.width = orig.videoWidth;
            tela.height = orig.videoHeight;
            tela.getContext('2d').drawImage(orig, 0, 0);
            const quadro = tela.toDataURL('image/jpeg', 0.8);
            if (quadro && quadro.length > 1200) {
              copy.setAttribute('poster', quadro);
              stats.postersGerados++;
            }
          } catch {
            /* vídeo de outra origem contamina o canvas */
          }
        }
      }
    }

    if (tag === 'iframe') {
      stats.iframes++;
      // O painel usa esta marca para casar o iframe com o conteúdo capturado
      // dentro dele e transformar os dois num srcdoc.
      copy.setAttribute('data-clonasite-frame', String(stats.iframes));
      copy.removeAttribute('loading');
    }

    if (tag === 'source' && copy.hasAttribute('srcset')) {
      const widest = widestFromSrcset(copy.getAttribute('srcset'), base);
      if (widest) copy.setAttribute('srcset', widest);
    }

    if (tag === 'canvas') {
      const ctxTipo = (orig.getAttribute('data-clonasite-ctx') || '').toLowerCase();
      const eh3d = ctxTipo === 'webgl' || ctxTipo === 'webgl2' || ctxTipo === 'experimental-webgl' || ctxTipo === 'webgpu';
      if (eh3d) stats.canvas3d++;

      const retrato = ORIGINAL ? null : retratoDoCanvas(orig);
      if (eh3d && !retrato) stats.canvasVazios++;

      // Cena 3D com o JavaScript preservado continua VIVA na cópia. Virar
      // figura seria jogar fora justamente o que a pessoa quis clonar — e era
      // isso que a versão anterior fazia, ainda por cima com o quadro preto que
      // o WebGL devolve quando o buffer de desenho não foi preservado.
      const manterVivo = eh3d && OPTS.manter3D && OPTS.keepScripts;

      if (manterVivo) {
        stats.canvas3dVivos++;
        if (retrato) {
          // Rede de segurança: o quadro congelado fica de fundo. Se o script 3D
          // subir, ele pinta por cima; se não subir, ainda assim se vê a cena.
          copy.style.backgroundImage = 'url("' + retrato + '")';
          copy.style.backgroundSize = '100% 100%';
          copy.style.backgroundRepeat = 'no-repeat';
        }
      } else if (OPTS.freezeCanvas && retrato) {
        const frozen = document.createElement('img');
        frozen.setAttribute('src', retrato);
        frozen.setAttribute('style', copy.getAttribute('style') || '');
        frozen.setAttribute('alt', '');
        if (orig.width) frozen.setAttribute('width', String(orig.width));
        if (orig.height) frozen.setAttribute('height', String(orig.height));
        pendingReplacements.push([copy, frozen]);
        stats.canvases++;
      }
    }

    // Estado dos formulários (menos senhas e arquivos).
    if (tag === 'input') {
      const type = (orig.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        if (orig.checked) copy.setAttribute('checked', '');
        else copy.removeAttribute('checked');
      } else if (type !== 'password' && type !== 'file') {
        copy.setAttribute('value', orig.value || '');
      }
    } else if (tag === 'textarea') {
      copy.textContent = orig.value || '';
    } else if (tag === 'option') {
      if (orig.selected) copy.setAttribute('selected', '');
      else copy.removeAttribute('selected');
    }

    // Shadow DOM aberto -> <template shadowrootmode="open"> (shadow DOM declarativo).
    if (OPTS.inlineShadowDom && orig.shadowRoot) {
      stats.shadowRoots++;
      const tpl = document.createElement('template');
      tpl.setAttribute('shadowrootmode', 'open');
      for (const sheet of orig.shadowRoot.adoptedStyleSheets || []) {
        const text = rulesToText(sheet);
        if (text) {
          const styleEl = document.createElement('style');
          styleEl.textContent = text;
          tpl.content.appendChild(styleEl);
        }
      }
      for (const child of Array.from(orig.shadowRoot.childNodes)) {
        const childCopy = child.cloneNode(true);
        tpl.content.appendChild(childCopy);
        if (child.nodeType === 1) walkPair(child, childCopy);
      }
      copy.appendChild(tpl);
    }
  };

  function walkPair(orig, copy) {
    if (orig.nodeType !== 1) return;
    // Nossa própria barra flutuante mora no DOM da página. Sem esta linha o
    // shadow root dela seria serializado direto para dentro da cópia.
    if (orig.id === 'clonasite-overlay') return;
    // Captura os filhos antes de mexer: fixElement pode acrescentar um <template>.
    const origKids = Array.from(orig.childNodes);
    const copyKids = Array.from(copy.childNodes);
    fixElement(orig, copy);
    for (let i = 0; i < origKids.length; i++) {
      if (origKids[i].nodeType === 1 && copyKids[i]) walkPair(origKids[i], copyKids[i]);
    }
  }

  // Modo componente: copia só a subárvore escolhida, mas reconstrói a cadeia de
  // ancestrais (vazios, com classe e estilo) — sem ela um seletor como
  // ".pagina .card" deixaria de casar e o componente sairia sem estilo.
  let picked = OPTS.mode === 'component' ? self.__clonasitePicked : null;
  let componentLabel = null;
  if (picked && (!picked.isConnected || picked.getRootNode() !== document || picked === document.documentElement)) {
    picked = null; // dentro de Shadow DOM ou desconectado: cai para página inteira
  }

  avisar('Copiando o documento…', 0.97);

  let clone;
  if (picked) {
    componentLabel = picked.tagName.toLowerCase() + (picked.id ? '#' + picked.id : '');
    const subtree = picked.cloneNode(true);
    walkPair(picked, subtree);
    let current = subtree;
    for (let node = picked.parentElement; node; node = node.parentElement) {
      const shell = node.cloneNode(false);
      fixElement(node, shell);
      shell.appendChild(current);
      current = shell;
    }
    clone = current; // o último invólucro é o próprio <html>
  } else {
    clone = document.documentElement.cloneNode(true);
    walkPair(document.documentElement, clone);
  }

  for (const [oldNode, newNode] of pendingReplacements) {
    if (oldNode.parentNode) oldNode.parentNode.replaceChild(newNode, oldNode);
  }
  for (const node of pendingRemovals) node.remove();

  // Cópia feita: devolve a página para onde a pessoa estava.
  try {
    irPara(document.scrollingElement || document.documentElement, posicaoOriginal);
  } catch {
    /* página sem scroller */
  }

  // Limpeza: tudo que atrapalha uma cópia estática.
  // Nada aqui alcança o conteúdo dos <template> de shadow DOM, que vive num
  // DocumentFragment e por isso escapa do querySelectorAll — que é o que queremos.
  const drop = [
    'style',
    'noscript',
    'base',
    'link[rel~="stylesheet" i]',
    'link[rel~="preload"]',
    'link[rel~="modulepreload"]',
    'link[rel~="prefetch"]',
    'link[rel~="preconnect"]',
    'link[rel~="dns-prefetch"]',
    'meta[http-equiv="Content-Security-Policy" i]',
    'meta[http-equiv="refresh" i]',
    'picture source',
    '#clonasite-overlay',
  ];
  if (!OPTS.keepScripts) drop.push('script');
  clone.querySelectorAll(drop.join(',')).forEach((el) => el.remove());

  let head = clone.querySelector('head');
  if (!head) {
    head = document.createElement('head');
    clone.insertBefore(head, clone.firstChild);
  }
  if (!head.querySelector('meta[charset]')) {
    const meta = document.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    head.insertBefore(meta, head.firstChild);
  }

  // Site que monta a tela sozinho pode se redesenhar por cima da cópia.
  const pareceSPA = !!document.querySelector(
    '#root, #app, #__next, #__nuxt, [data-reactroot], [data-server-rendered], [ng-version]'
  );

  return {
    ok: true,
    pareceSPA,
    scriptsMantidos: OPTS.keepScripts ? clone.querySelectorAll('script').length : 0,
    modoOriginal: ORIGINAL,
    modo: picked ? 'component' : 'page',
    componente: componentLabel,
    html: '<!DOCTYPE html>\n' + clone.outerHTML,
    sheets,
    // Tudo que a página baixou de verdade, inclusive o que só o JavaScript
    // pediu. É esta lista que traz o 3D, o Lottie, o wasm e os pedaços de
    // bundle — nenhum deles aparece no HTML nem no CSS.
    rede: rede.urls,
    streams: rede.streams,
    tecnologias: detectarTecnologias(rede),
    // Os títulos da página, na ordem. É o esqueleto dela em texto: quem for
    // refazer em componentes precisa saber quais seções existem, e ler isso do
    // HTML de 5 mil elementos dá muito mais trabalho do que receber pronto.
    secoes: (() => {
      const vistos = [];
      try {
        for (const h of document.querySelectorAll('h1, h2')) {
          const texto = (h.textContent || '').replace(/\s+/g, ' ').trim();
          if (!texto || texto.length > 90) continue;
          if (h.closest('[role="dialog"], .modal, nav, footer')) continue;
          if (!vistos.includes(texto)) vistos.push(texto);
          if (vistos.length >= 24) break;
        }
      } catch {
        /* seletor recusado */
      }
      return vistos;
    })(),
    url: location.href,
    origin: location.origin,
    title: document.title || location.hostname,
    favicon: (() => {
      const link = document.querySelector('link[rel~="icon" i], link[rel~="apple-touch-icon" i]');
      return link && link.href ? link.href : location.origin + '/favicon.ico';
    })(),
    baseURI: document.baseURI,
    capturedAt: new Date().toISOString(),
    stats,
  };
};
