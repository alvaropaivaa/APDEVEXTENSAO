import { makeZip } from './src/zip.js';
import { aplicarMarca, MARCA } from './src/marca.js';
import { linksDaPagina, nomeLocalPara, normalizarUrl, reescreverLinks } from './src/navegacao.js';
import { codigoDoDesvio } from './src/desvio.js';
import { codigoDoAnimar } from './src/animar.js';
import { montarPrompt } from './src/prompt.js';

// Modelo 3D não cabe no teto de imagem: um .glb de cena inteira passa fácil de
// 60 MB, e reprovar por tamanho é exatamente o que fazia a cena não vir.
const MAX_ASSET_BYTES = 90 * 1024 * 1024;
// Vídeo precisa de outro teto: 25 MB reprova quase todo vídeo de capa.
const MAX_MEDIA_BYTES = 400 * 1024 * 1024;
const TOTAL_BUDGET_BYTES = 1200 * 1024 * 1024;
// Acima disso o vídeo NÃO vira data: URI — base64 engorda 33% e um HTML de
// 200 MB não abre. Ele fica apontando para a URL original no arquivo único,
// mas entra inteiro no ZIP.
const INLINE_MEDIA_LIMIT = 20 * 1024 * 1024;
// Mesma ideia para modelo e textura 3D no arquivo único.
const INLINE_3D_LIMIT = 24 * 1024 * 1024;
// Playlist de streaming: baixar o .m3u8 e apontar para o arquivo local quebra
// tudo, porque os segmentos são resolvidos em relação a ela. Fica absoluta.
const STREAM_RE = /\.(m3u8|mpd)(\?|$)/i;
const MEDIA_RE = /\.(mp4|webm|ogv|ogg|mov|m4v|avi|mkv|mp3|wav|m4a|aac|flac|opus)(\?|$)/i;
// O que faz uma cena 3D existir: geometria, textura comprimida, mapa de
// ambiente, física, compressão de malha.
const TRES_D_RE =
  /\.(glb|gltf|fbx|obj|mtl|usdz|usd|dae|stl|ply|3ds|bin|drc|ktx2?|basis|hdr|exr|env|pmx|vrm|wasm|bvh|abc)(\?|$)/i;
const LOTTIE_RE = /(lottie|\.lottie|animation.*\.json|data\.json)(\?|$)/i;
// Endpoint de telemetria: não é recurso, é batida de ponto. Baixar por GET só
// gera erro no log e não coloca nada na cópia.
const TRACKER_RE =
  /(google-analytics\.com|googletagmanager\.com\/gtag|analytics\.google\.com|doubleclick\.net|facebook\.com\/tr|connect\.facebook\.net\/signals|\/collect(\?|$)|\/beacon|\/pixel|\/track(ing)?\?|hotjar\.com\/api|clarity\.ms\/collect|sentry\.io\/api|\.ingest\.sentry|segment\.io\/v1|amplitude\.com\/2|mixpanel\.com\/track)/i;
const CONCURRENCY = 8;
// Prazos. A varredura de uma página pesada leva perto de um minuto de forma
// legítima; passou de 90s, alguma coisa está errada e é melhor copiar sem rolar
// do que deixar a pessoa olhando uma barra parada.
const CAPTURA_TIMEOUT_MS = 90000;
const CAPTURA_RAPIDA_MS = 45000;
// Um <iframe> de anúncio pendurado não pode segurar a clonagem inteira.
const FRAME_TIMEOUT_MS = 15000;
// Prazo de cada tentativa de download. Vídeo grande em rede lenta ainda cabe.
const FETCH_TIMEOUT_MS = 40000;
// Teto de <iframe> para entrar por dentro. Página de notícia tem dezenas de
// frames de anúncio, e cada um custa uma injeção.
const MAX_FRAMES = 12;
// O site é renderizado numa moldura de 1280px e reduzido por transform: assim
// ele aparece como um site de verdade, não espremido na largura do painel.
const PREVIEW_W = 1280;
const PREVIEW_SWAP_LIMIT = 20 * 1024 * 1024;
const SCROLL_PASS_MS = 16000;
// captureVisibleTab tem cota de 2 chamadas por segundo. 700ms fica folgado e
// já dá a sensação de vídeo enquanto a varredura desce a página.
const FOTO_MS = 700;
const MAX_IMPORT_DEPTH = 5;
const SINGLE_FILE_WARN = 45 * 1024 * 1024;
const DEFAULT_OPTS = {
  autoScroll: true,
  slowScan: true,
  unlockAnimations: true,
  freezeCanvas: true,
  inlineShadowDom: true,
  keepScripts: true,
  manter3D: true,
  animarNaCopia: true,
  capturarRede: true,
  resgatarBlobs: true,
  capturarIframes: true,
  shimOffline: true,
};
const OPT_KEYS = Object.keys(DEFAULT_OPTS);
// Teto do rastreio. 20 páginas levam uns 3 minutos: cada uma paga de novo o
// preço da varredura que acorda as imagens preguiçosas.
const LIMITE_PADRAO = 20;
const LIMITE_MAX = 200;
const BLOCKED = /^(chrome|edge|brave|about|devtools|view-source|chrome-extension|moz-extension):/i;

const el = (id) => document.getElementById(id);

let target = null; // aba que será clonada
let busy = false;
let state = null;
// Trecho da barra que a captura de UMA página ocupa. O capturador manda a
// fração dele (0 a 1) e ela vira fração da barra inteira aqui.
let faixaCaptura = [0.05, 0.17];
const faixa = (ini, fim) => {
  faixaCaptura = [ini, fim];
};

const freshState = () => ({
  snapshot: null,
  assets: new Map(),
  css: [],
  // Chave -> bloco de CSS. No rastreio a mesma folha aparece em toda página;
  // sem isso ela seria baixada e gravada uma vez por página.
  cssPorChave: new Map(),
  paginas: [],
  nomesUsados: new Set(),
  // Contador dos nomes em assets/. Precisa viver no estado, e não dentro do
  // downloadAll: no rastreio ele é chamado uma vez por página, e reiniciar a
  // contagem faria a página 2 sobrescrever os recursos da página 1.
  assetSeq: 0,
  doc: null,
  zip: null,
  single: null,
  singleUrl: null,
  failures: 0,
  cssFailures: 0,
  bytesIn: 0,
  midiasLinkadas: 0,
  midiasBaixadas: 0,
  scriptsInline: 0,
  scriptsAdiados: 0,
  animados: 0,
  // Quantos recursos vieram de cada família, para o log dizer em português o
  // que foi puxado: "3D: 7 · vídeo: 2 · fonte: 5".
  porTipo: new Map(),
  // URLs que só a gravação de rede conhecia — nenhuma delas está escrita no
  // HTML nem no CSS. É a lista que traz o 3D e a animação.
  daRede: new Set(),
  // Subconjunto do anterior: os que NÃO aparecem em lugar nenhum do documento.
  // Falha neles é normal e não conta como recurso perdido.
  somenteRede: new Set(),
  falhasOpcionais: 0,
  frames: 0,
  desviados: 0,
  cancelado: false,
  abaTrabalhoId: null,
  // Downloads em curso, para o "Parar" cortar na hora em vez de esperar o prazo.
  emVoo: new Set(),
  opts: {},
  filename: '',
  downloadId: null,
});

// ------------------------------------------------------------------ util

const fmtBytes = (n) => {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
};

function log(tag, message, level = '') {
  const li = document.createElement('li');
  if (level) li.className = level;
  const t = document.createElement('span');
  t.className = 'tag';
  t.textContent = tag;
  const m = document.createElement('span');
  m.className = 'msg';
  m.textContent = message;
  li.append(t, m);
  el('log').append(li);
  el('log').scrollTop = el('log').scrollHeight;
}

function step(text, ratio) {
  el('step-text').textContent = text;
  if (typeof ratio === 'number') {
    el('bar').firstElementChild.style.width = Math.round(ratio * 100) + '%';
    el('pct').textContent = Math.round(ratio * 100) + '%';
  }
}

function show(...ids) {
  for (const id of ['idle', 'running', 'done', 'fatal', 'missing']) {
    el(id).classList.toggle('hidden', !ids.includes(id));
  }
}

// Volta ao estado parado depois de um "Parar". Não é erro: nada de tela
// vermelha, só recolhe a prévia e devolve o painel.
function encerrarPorCancelamento() {
  busy = false;
  fecharPreview();
  show('idle');
  return null;
}

function fatal(message) {
  busy = false;
  pararPreview();
  pararFotos();
  el('fatal-msg').textContent = message;
  show('fatal');
}

const isFetchable = (url) => /^https?:\/\//i.test(url || '') && !STREAM_RE.test(url);

const splitHash = (url) => {
  const at = url.indexOf('#');
  return at >= 0 ? [url.slice(0, at), url.slice(at)] : [url, ''];
};

const bareUrl = (url) => splitHash(url)[0];

// ------------------------------------------------------------- prévia

const preview = { url: null, timer: null, fotos: null };

function fitPreview() {
  const box = el('preview-box');
  const frame = el('preview');
  const largura = box.clientWidth;
  if (!largura) return; // painel ainda sem layout
  const escala = largura / PREVIEW_W;
  frame.style.width = PREVIEW_W + 'px';
  frame.style.height = Math.round(box.clientHeight / escala) + 'px';
  frame.style.transform = 'scale(' + escala + ')';
}

function abrirPreview(urlDoSite) {
  el('preview-url').textContent = urlDoSite || '—';
  el('preview-empty').classList.remove('hidden');
  el('preview-card').classList.remove('hidden');
  el('preview-card').classList.add('copiando');
  el('preview-selo').lastChild.textContent = 'copiando';
  el('preview-legenda').textContent = 'abrindo a página…';
}

// Enquanto o capture.js roda — o que com a varredura lenta leva dezenas de
// segundos — não existe HTML nenhum para mostrar. Então o painel fotografa a
// aba de tempos em tempos: você vê a página descendo de verdade.
function iniciarFotos(windowId) {
  pararFotos();
  const bater = async () => {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 55 });
      if (!dataUrl) return;
      el('preview-shot').src = dataUrl;
      el('preview-shot').classList.remove('hidden');
      el('preview-empty').classList.add('hidden');
      el('preview-legenda').textContent = 'lendo a página…';
    } catch {
      /* aba trocou, cota estourou ou a página não deixa: tenta na próxima */
    }
  };
  bater();
  preview.fotos = setInterval(bater, FOTO_MS);
}

function pararFotos() {
  if (preview.fotos) clearInterval(preview.fotos);
  preview.fotos = null;
}

function pintarPreview(html, { copiando }) {
  pararFotos();
  el('preview-shot').classList.add('hidden');
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anterior = preview.url;
  el('preview-card').classList.remove('hidden');
  el('preview-card').classList.toggle('copiando', !!copiando);
  el('preview-empty').classList.add('hidden');
  el('preview-selo').lastChild.textContent = copiando ? 'copiando' : 'cópia offline';
  fitPreview();
  el('preview').src = url;
  preview.url = url;
  if (anterior) setTimeout(() => URL.revokeObjectURL(anterior), 8000);
}

// Rola a prévia sozinha: é o "vendo a página inteira sendo copiada".
function rolarPreview() {
  pararPreview();
  preview.timer = setInterval(() => {
    try {
      const win = el('preview').contentWindow;
      const doc = win && win.document;
      if (!doc || !doc.documentElement) return;
      const max = doc.documentElement.scrollHeight - win.innerHeight;
      if (max <= 4) return;
      let y = win.scrollY + Math.max(1, (max * 16) / SCROLL_PASS_MS);
      if (y >= max) y = 0;
      win.scrollTo(0, y);
    } catch {
      /* prévia ainda carregando */
    }
  }, 16);
}

function pararPreview() {
  if (preview.timer) clearInterval(preview.timer);
  preview.timer = null;
}

function fecharPreview() {
  pararPreview();
  pararFotos();
  el('preview-shot').classList.add('hidden');
  el('preview-shot').removeAttribute('src');
  el('preview-card').classList.add('hidden');
  el('preview-card').classList.remove('copiando');
  el('preview').removeAttribute('src');
  el('preview-empty').classList.remove('hidden');
  if (preview.url) {
    URL.revokeObjectURL(preview.url);
    preview.url = null;
  }
}

window.addEventListener('resize', fitPreview);

// ------------------------------------------------------------- rede

// Um 403 com cookie às vezes vira 200 sem cookie (CDN com proteção de hotlink).
//
// Cada tentativa tem prazo. Sem ele, uma conexão que abre e nunca responde —
// CDN fora do ar, endereço de API que só aceita POST, servidor que engasga —
// segura um dos trabalhadores para sempre, e o painel fica parado em
// "Baixando recursos" sem nunca terminar. Com a lista da rede entrando na fila,
// o número de endereços cresceu muito e isso deixou de ser hipótese.
async function fetchAsset(url) {
  let last;
  for (const credentials of ['include', 'omit']) {
    const controle = new AbortController();
    const relogio = setTimeout(() => controle.abort(), FETCH_TIMEOUT_MS);
    state.emVoo.add(controle);
    try {
      const res = await fetch(url, { credentials, redirect: 'follow', signal: controle.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res;
    } catch (e) {
      last = e && e.name === 'AbortError' ? new Error('sem resposta em ' + FETCH_TIMEOUT_MS / 1000 + 's') : e;
      if (state.cancelado) throw last;
    } finally {
      clearTimeout(relogio);
      state.emVoo.delete(controle);
    }
  }
  throw last;
}

const fetchText = async (url) => (await fetchAsset(url)).text();

function absolutizeCss(css, base) {
  if (!css) return css;
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
      const raw = u.trim();
      if (/^(data|blob|about|#)/i.test(raw)) return m;
      try {
        return 'url("' + new URL(raw, base).href + '")';
      } catch {
        return m;
      }
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
      try {
        return '@import "' + new URL(u.trim(), base).href + '"';
      } catch {
        return m;
      }
    });
}

async function inlineImports(css, base, depth) {
  if (depth >= MAX_IMPORT_DEPTH) return css;
  const pattern = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)([^;]*);/gi;
  const jobs = [];
  css.replace(pattern, (match, q1, u1, q2, u2, media) => {
    const url = (u1 || u2 || '').trim();
    if (isFetchable(url)) jobs.push({ match, url, media: (media || '').trim() });
    return match;
  });
  if (!jobs.length) return css;

  for (const job of jobs) {
    try {
      let text = absolutizeCss(await fetchText(job.url), job.url);
      text = await inlineImports(text, job.url, depth + 1);
      if (job.media) text = '@media ' + job.media + ' {\n' + text + '\n}';
      css = css.replace(job.match, text);
    } catch (e) {
      log('@import', 'falhou: ' + job.url + ' (' + e.message + ')', 'warn');
      css = css.replace(job.match, '/* clonasite: @import falhou -> ' + job.url + ' */');
    }
  }
  return css;
}

// ------------------------------------------------------------- assets

const EXT_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'font/woff2': '.woff2',
  'font/woff': '.woff',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
  'application/font-woff': '.woff',
  'text/css': '.css',
  'text/javascript': '.js',
  'application/javascript': '.js',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'application/json': '.json',
  'application/wasm': '.wasm',
  'model/gltf-binary': '.glb',
  'model/gltf+json': '.gltf',
  'application/octet-stream': '.bin',
  'text/plain': '.txt',
  'image/ktx2': '.ktx2',
  'font/collection': '.ttc',
};

// A que família o recurso pertence. Serve só para o relato — mas é o relato que
// responde "puxou o 3D?" sem precisar abrir o ZIP.
function familiaDe(url, tipo) {
  const t = (tipo || '').toLowerCase();
  if (TRES_D_RE.test(url) || t.startsWith('model/') || t === 'application/wasm') return '3D';
  if (MEDIA_RE.test(url) || /^(video|audio)\//.test(t)) return 'mídia';
  if (/^image\//.test(t) || /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)(\?|$)/i.test(url)) return 'imagem';
  if (/^font\//.test(t) || /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(url)) return 'fonte';
  if (/javascript|ecmascript/.test(t) || /\.(m?js|cjs)(\?|$)/i.test(url)) return 'script';
  if (t.includes('css') || /\.css(\?|$)/i.test(url)) return 'css';
  if (t.includes('json') || LOTTIE_RE.test(url) || /\.json(\?|$)/i.test(url)) return 'dados';
  return 'outro';
}

function localNameFor(url, index, contentType) {
  let base = 'asset';
  try {
    base = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || 'asset');
  } catch {
    /* mantém o padrão */
  }
  base = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || 'asset';
  if (!/\.[a-z0-9]{2,5}$/i.test(base)) {
    base += EXT_BY_TYPE[(contentType || '').split(';')[0].trim().toLowerCase()] || '.bin';
  }
  return 'assets/' + String(index).padStart(3, '0') + '-' + base;
}

async function downloadAll(urls, aoProgredir = null) {
  // O que já está no pool não é buscado de novo: no rastreio, o logo e a fonte
  // do site aparecem em todas as páginas.
  const list = [...urls].filter((u) => isFetchable(u) && !state.assets.has(u));
  let done = 0;
  const queue = list.slice();

  const worker = async () => {
    for (;;) {
      if (state.cancelado) return;
      const url = queue.shift();
      if (!url) return;
      try {
        const res = await fetchAsset(url);
        const type = res.headers.get('content-type') || '';
        const ehMidia = MEDIA_RE.test(url) || /^(video|audio)\//i.test(type);
        const limite = ehMidia ? MAX_MEDIA_BYTES : MAX_ASSET_BYTES;

        // content-length evita puxar 300 MB só para descobrir que não cabe.
        const anunciado = Number(res.headers.get('content-length')) || 0;
        if (anunciado > limite) throw new Error(fmtBytes(anunciado) + ', acima de ' + fmtBytes(limite));
        if (state.bytesIn + anunciado > TOTAL_BUDGET_BYTES) {
          throw new Error('estouraria o teto de ' + fmtBytes(TOTAL_BUDGET_BYTES) + ' da cópia');
        }

        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length > limite) throw new Error(fmtBytes(buf.length) + ', acima de ' + fmtBytes(limite));

        state.bytesIn += buf.length;
        const familia = familiaDe(url, type);
        state.porTipo.set(familia, (state.porTipo.get(familia) || 0) + 1);
        const apelido = localNameFor(url, state.assetSeq + 1, type).split('/').pop();
        if (familia === 'mídia') {
          state.midiasBaixadas++;
          log('mídia', apelido + ' · ' + fmtBytes(buf.length), 'ok');
        } else if (familia === '3D') {
          log('3D', apelido + ' · ' + fmtBytes(buf.length), 'ok');
        }
        state.assets.set(url, {
          bytes: buf,
          type,
          ehMidia,
          familia,
          name: localNameFor(url, ++state.assetSeq, type),
        });
      } catch (e) {
        // Endereço que só a rede viu pode ser POST, WebSocket ou API com
        // sessão: falhar num GET é o esperado, e contar isso como recurso
        // perdido encheria o aviso do fim de alarme falso. O que está escrito
        // no documento, esse sim, faz falta quando não vem.
        if (state.somenteRede.has(url)) {
          state.falhasOpcionais++;
        } else {
          state.failures++;
          log('falhou', url.replace(/^https?:\/\//, '').slice(0, 80) + ' — ' + e.message, 'warn');
        }
      }
      done++;
      if (aoProgredir) aoProgredir(done, list.length);
      else step('Baixando recursos · ' + done + '/' + list.length, 0.3 + 0.55 * (done / list.length));
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
  return list.length;
}

// ------------------------------------------------------------- coleta

const URL_ATTRS = [
  ['img', 'src'],
  ['video', 'src'],
  ['video', 'poster'],
  ['audio', 'src'],
  ['source', 'src'],
  ['source', 'srcset'],
  ['track', 'src'],
  ['embed', 'src'],
  ['object', 'data'],
  ['input[type="image" i]', 'src'],
  ['link[rel~="icon" i]', 'href'],
  ['link[rel~="apple-touch-icon" i]', 'href'],
  ['script[src]', 'src'],
  ['image', 'href'],
  ['image', 'xlink:href'],
  ['use', 'href'],
  ['use', 'xlink:href'],
];

// O conteúdo de <template> vive num DocumentFragment fora do alcance de
// querySelectorAll — e é lá que mora o Shadow DOM que o capture.js serializou.
function* allRoots(doc) {
  const stack = [doc];
  while (stack.length) {
    const root = stack.pop();
    yield root;
    for (const tpl of root.querySelectorAll('template')) stack.push(tpl.content);
  }
}

function eachUrlAttr(doc, visit) {
  for (const root of allRoots(doc)) {
    for (const [selector, attr] of URL_ATTRS) {
      for (const node of root.querySelectorAll(selector)) {
        const value = node.getAttribute(attr);
        if (isFetchable(value)) visit(node, attr, value);
      }
    }
  }
}

function eachStyleAttr(doc, visit) {
  for (const root of allRoots(doc)) {
    for (const node of root.querySelectorAll('[style]')) visit(node);
  }
}

function eachTemplateStyle(doc, visit) {
  for (const root of allRoots(doc)) {
    if (root.nodeType === 9) continue; // o documento em si já foi coletado
    for (const node of root.querySelectorAll('style')) visit(node);
  }
}

function collectUrls(doc, cssTexts) {
  const urls = new Set();
  const scanCss = (text) => {
    for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
      if (isFetchable(m[1])) urls.add(bareUrl(m[1].trim()));
    }
  };
  eachUrlAttr(doc, (node, attr, value) => urls.add(bareUrl(value)));
  eachStyleAttr(doc, (node) => scanCss(node.getAttribute('style')));
  eachTemplateStyle(doc, (node) => scanCss(node.textContent || ''));
  for (const text of cssTexts) scanCss(text);
  return urls;
}

// Tudo que a página baixou de verdade, segundo a gravação de rede.
//
// É aqui que entram o modelo .glb, a textura .ktx2, o mapa de ambiente .hdr, o
// JSON do Lottie, o .wasm do descompressor e o pedaço de bundle que o import()
// foi buscar. NENHUM deles está escrito no HTML ou no CSS — eles nascem de uma
// chamada de JavaScript. A varredura de documento acima passa por cima de
// todos, e era exatamente por isso que a cópia vinha sem o 3D.
function urlsDaRede(snapshot) {
  const urls = new Set();
  const daPagina = bareUrl(snapshot.url || '');
  for (const bruta of snapshot.rede || []) {
    if (!isFetchable(bruta)) continue;
    const url = bareUrl(bruta);
    if (url === daPagina) continue; // o documento não é recurso dele mesmo
    if (TRACKER_RE.test(url)) continue;
    urls.add(url);
  }
  return urls;
}

// ------------------------------------------------------------- reescrita

function rewriteCss(css, resolve) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
    const targetUrl = resolve(u.trim());
    return targetUrl ? 'url("' + targetUrl + '")' : m;
  });
}

// ------------------------------------------------- desvio em tempo de execução

// Quais recursos entram no desvio: os que o JavaScript busca sozinho. Imagem
// que já está escrita numa tag não precisa — ela já foi reescrita no atributo,
// e repetir aqui dobraria o tamanho do arquivo único à toa.
function mapaDoDesvio(resolve) {
  const mapa = {};
  for (const [url, asset] of state.assets) {
    const buscadoPorJs = state.daRede.has(url) || asset.familia === '3D' || asset.familia === 'dados';
    if (!buscadoPorJs) continue;
    const destino = resolve(url);
    if (destino) mapa[url] = destino;
  }
  return mapa;
}

function buildHtml(resolve, cssBlocks, { inlineCss, inlineScripts }) {
  const doc = state.doc.cloneNode(true);

  // No arquivo único, script vira código dentro da própria tag. É mais robusto
  // que data: URI no src — que o Chrome recusa para <script type="module">.
  if (inlineScripts) {
    for (const root of allRoots(doc)) {
      const adiados = [];
      for (const node of [...root.querySelectorAll('script[src]')]) {
        const asset = state.assets.get(bareUrl(node.getAttribute('src') || ''));
        if (!asset) continue;
        let codigo;
        try {
          codigo = new TextDecoder('utf-8').decode(asset.bytes);
        } catch {
          continue; // não é texto: deixa como está
        }

        // ISTO aqui é o que fazia a cópia abrir sem animação nenhuma.
        //
        // `defer` só existe para script COM src: o navegador ignora o atributo
        // num script inline. Então `<script defer src="app.js">` no <head>, ao
        // virar código dentro da tag, deixava de esperar o documento e passava
        // a rodar durante o parse do <head> — com o <body> ainda inexistente.
        // Todo querySelector devolvia null, o script morria na primeira linha e
        // GSAP, AOS e ScrollTrigger nunca chegavam a inicializar.
        //
        // Mover para o fim do <body> devolve a ordem original: roda depois do
        // documento montado, e na mesma sequência entre eles. Módulo não entra
        // nessa: `type="module"` já é adiado por natureza, inline ou não.
        const ehModulo = (node.getAttribute('type') || '').toLowerCase() === 'module';
        const eraAdiado = node.hasAttribute('defer') || node.hasAttribute('async');

        node.removeAttribute('src');
        // Um </script> dentro do código fecharia a tag na serialização.
        // A contrabarra tem que sobrar no arquivo final: '<\\/' vira "<\/".
        node.textContent = codigo.replace(/<\/(script)/gi, '<\\/$1');
        state.scriptsInline++;

        if (eraAdiado && !ehModulo) {
          node.removeAttribute('defer');
          node.removeAttribute('async');
          adiados.push(node);
        }
      }

      const corpo = root.nodeType === 9 ? root.body : root.querySelector('body');
      if (corpo) for (const node of adiados) corpo.appendChild(node);
      state.scriptsAdiados += adiados.length;
    }
  }

  eachUrlAttr(doc, (node, attr, value) => {
    const localPath = resolve(value);
    if (localPath) node.setAttribute(attr, localPath);
  });
  eachStyleAttr(doc, (node) => node.setAttribute('style', rewriteCss(node.getAttribute('style'), resolve)));
  eachTemplateStyle(doc, (node) => {
    node.textContent = rewriteCss(node.textContent || '', resolve);
  });

  const head = doc.head || doc.documentElement;
  for (const block of cssBlocks) {
    const node = doc.createElement(inlineCss ? 'style' : 'link');
    if (block.media) node.setAttribute('media', block.media);
    if (inlineCss) {
      node.textContent = block.text;
    } else {
      node.setAttribute('rel', 'stylesheet');
      node.setAttribute('href', block.name);
    }
    head.append(node);
  }

  // <iframe> com documento capturado dentro vira srcdoc. O conteúdo viajou até
  // aqui num <template> de propósito: assim ele passou por toda a reescrita de
  // URL acima, como se fosse parte da página. Agora que está reescrito, vira
  // atributo — e o frame abre offline, sem pedir nada para a rede.
  for (const root of [...allRoots(doc)]) {
    for (const tpl of [...root.querySelectorAll('template[data-clonasite-doc]')]) {
      const alvo = tpl.parentElement;
      const raiz = tpl.content.firstElementChild;
      tpl.remove();
      if (!alvo || !raiz) continue;
      alvo.setAttribute('srcdoc', '<!DOCTYPE html>' + raiz.outerHTML);
      alvo.removeAttribute('src');
    }
  }

  // O desvio precisa ser o PRIMEIRO script da página: ele tem que estar de pé
  // antes de qualquer código do site pedir o primeiro arquivo.
  const opts = state.opts || {};
  if (opts.shimOffline && opts.keepScripts) {
    const mapa = mapaDoDesvio(resolve);
    const chaves = Object.keys(mapa);
    if (chaves.length) {
      const json = JSON.stringify(mapa).replace(/<\//g, '<\\/');
      const desvio = doc.createElement('script');
      desvio.setAttribute('data-clonasite', 'desvio');
      desvio.textContent = codigoDoDesvio(json);
      head.insertBefore(desvio, head.firstChild);

      // import() de módulo não passa por fetch: quem resolve é o carregador do
      // navegador. O import map é o único jeito de apontá-lo para o arquivo local.
      const modulos = {};
      for (const chave of chaves) {
        if (/\.(m?js|cjs)(\?|$)/i.test(chave) || (state.assets.get(chave) || {}).familia === 'script') {
          modulos[chave] = mapa[chave];
        }
      }
      // Um módulo embutido resolve `import "./chunk-abc.js"` contra a base do
      // DOCUMENTO — que na cópia é o arquivo local, não mais o site. Mapear
      // também pelo "./nome" é o que faz esses pedaços serem encontrados. Nome
      // repetido entre dois arquivos fica de fora: mandar para o errado seria
      // pior do que não mandar.
      const porNome = new Map();
      for (const chave of Object.keys(modulos)) {
        const nome = chave.split('#')[0].split('?')[0].split('/').pop();
        if (!nome) continue;
        porNome.set(nome, porNome.has(nome) ? null : modulos[chave]);
      }
      for (const [nome, destino] of porNome) {
        if (destino) modulos['./' + nome] = destino;
      }

      if (Object.keys(modulos).length) {
        const im = doc.createElement('script');
        im.setAttribute('type', 'importmap');
        im.textContent = JSON.stringify({ imports: modulos }).replace(/<\//g, '<\\/');
        head.insertBefore(im, desvio.nextSibling);
      }
      state.desviados = chaves.length;
    }
  }

  // O refazedor de animação entra no FIM do <body>: ele precisa do documento
  // montado, e só faz sentido se houver revelação anotada para refazer.
  if (opts.animarNaCopia) {
    const paraAnimar = doc.querySelectorAll('[data-clonasite-de]').length;
    if (paraAnimar) {
      const corpo = doc.body || doc.documentElement;
      const animador = doc.createElement('script');
      animador.setAttribute('data-clonasite', 'animar');
      animador.textContent = codigoDoAnimar();
      corpo.appendChild(animador);
      state.animados = paraAnimar;
    }
  }

  doc.documentElement.insertBefore(
    doc.createComment(
      ' Clonado por ' + MARCA.nome + ' em ' +
        state.snapshot.capturedAt +
        '\n     Origem: ' +
        state.snapshot.url +
        '\n     Cópia estática para uso próprio. Respeite os direitos do site original. '
    ),
    doc.documentElement.firstChild
  );

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

function toBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ------------------------------------------------------------- saída

// Nome no estilo do "Salvar como" do Chrome: título da página, com tudo que
// não pode virar nome de arquivo trocado por "_".
function safeStem() {
  const stem = (state.snapshot.title || '')
    .trim()
    .replace(/[^\p{L}\p{N}\-_. ]/gu, '_')
    .replace(/\s/g, '_')
    .replace(/_{4,}/g, '___')
    .replace(/^[_.]+|[_.]+$/g, '')
    .slice(0, 120);
  if (stem) return stem;
  try {
    return new URL(state.snapshot.url).hostname.replace(/^www\./, '') || 'pagina';
  } catch {
    return 'pagina';
  }
}

async function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    // saveAs falso: cai direto na pasta de Downloads, sem caixa de diálogo.
    return await chrome.downloads.download({ url, filename, saveAs: false });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

// O caminho do arquivo em disco só existe depois que o Chrome termina de
// gravar — antes disso o item ainda vem com filename vazio. Sem esse caminho
// não dá para pedir ao VS Code que abra o arquivo.
async function caminhoDoDownload(id, limiteMs = 15_000) {
  if (id == null) throw new Error('o arquivo não chegou a ser salvo');
  const prazo = Date.now() + limiteMs;
  for (;;) {
    const [item] = await chrome.downloads.search({ id });
    if (item?.state === 'complete' && item.filename) return item.filename;
    if (item?.state === 'interrupted') throw new Error('o download foi interrompido');
    if (Date.now() > prazo) throw new Error('o download demorou demais');
    await new Promise((r) => setTimeout(r, 200));
  }
}

function buildSingleFile() {
  if (state.single) return state.single;
  const dataUris = new Map();
  const linkadas = new Set();
  const resolve = (url) => {
    const [bare, hash] = splitHash(url);
    const asset = state.assets.get(bare);
    if (!asset) return null;
    // Vídeo pesado embutido em base64 deixaria o HTML inabrível. Devolver null
    // mantém a URL original: toca com internet e o ZIP tem o arquivo de verdade.
    const teto = asset.familia === '3D' ? INLINE_3D_LIMIT : INLINE_MEDIA_LIMIT;
    if ((asset.ehMidia || asset.familia === '3D') && asset.bytes.length > teto) {
      if (!linkadas.has(bare)) {
        linkadas.add(bare);
        state.midiasLinkadas++;
      }
      return null;
    }
    if (!dataUris.has(bare)) {
      const mime = (asset.type || '').split(';')[0].trim() || 'application/octet-stream';
      dataUris.set(bare, 'data:' + mime + ';base64,' + toBase64(asset.bytes));
    }
    return dataUris.get(bare) + hash;
  };
  const cssBlocks = state.css.map((block) => ({ ...block, text: rewriteCss(block.text, resolve) }));
  state.single = new Blob([buildHtml(resolve, cssBlocks, { inlineCss: true, inlineScripts: true })], {
    type: 'text/html;charset=utf-8',
  });
  return state.single;
}

// ------------------------------------------------------------- alvo

async function refreshTarget() {
  if (busy) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  target = tab || null;

  const ok = !!(tab && tab.url) && !BLOCKED.test(tab.url) && !/^https:\/\/chromewebstore\.google\.com/.test(tab.url);
  el('target-title').textContent = (tab && tab.title) || '—';
  el('target-url').textContent = (tab && tab.url) || 'nenhuma aba';
  el('target-icon').src = (tab && tab.favIconUrl) || 'icons/icon48.png';
  el('go').disabled = !ok;
  el('go').lastChild.textContent = ok ? ' Clonar esta página' : ' Página não permitida';
}

// ------------------------------------------------------------- captura

// Manda a captura em curso desistir. Ela checa essa bandeira nas esperas
// longas, então para em menos de um segundo — sem isso, uma captura que estourou
// o prazo continuaria rolando a página por baixo da segunda tentativa.
async function pedirAbortar(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        self.__clonasiteAbortar = true;
      },
    });
  } catch {
    /* aba já fechada */
  }
}

// Corre a promessa contra o relógio. Página com 3D pesado às vezes não devolve
// nunca; parar de esperar é melhor do que deixar o painel parado para sempre.
const comPrazo = (promessa, ms, mensagem) => {
  let relogio;
  return Promise.race([
    promessa.finally(() => clearTimeout(relogio)),
    new Promise((_, rejeitar) => {
      relogio = setTimeout(() => rejeitar(new Error(mensagem)), ms);
    }),
  ]);
};

async function rodarCaptura(tabId, opts) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (o) => self.__clonasiteCapture(o),
    args: [opts],
  });
  const snap = injection && injection.result;
  if (!snap || !snap.ok) throw new Error('a página não devolveu conteúdo utilizável');
  return snap;
}

// Injeta o capturador na aba e devolve o retrato da página já renderizada.
async function capturarAba(tabId, opts) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/capture.js'] });

  let snap;
  try {
    snap = await comPrazo(rodarCaptura(tabId, opts), CAPTURA_TIMEOUT_MS, 'a varredura passou de 90s');
  } catch (e) {
    if (state.cancelado) throw e;
    // Página que não devolve no prazo não pode virar painel parado para sempre.
    // Manda a primeira desistir e copia sem rolar: vem menos imagem preguiçosa,
    // mas vem — e vem em segundos.
    log('captura', e.message + ' — copiando sem rolar', 'warn');
    step('A página é pesada; copiando sem rolar…', 0.1);
    await pedirAbortar(tabId);
    snap = await comPrazo(
      rodarCaptura(tabId, Object.assign({}, opts, { autoScroll: false, slowScan: false })),
      CAPTURA_RAPIDA_MS,
      'a página não respondeu nem sem rolar'
    );
  }

  if (opts.capturarIframes && opts.mode !== 'component') {
    try {
      snap.frames = await capturarFrames(tabId, opts);
      if (snap.frames.length) log('iframe', snap.frames.length + ' frame(s) capturado(s) por dentro', 'ok');
    } catch (e) {
      log('iframe', 'não deu para entrar nos frames: ' + e.message, 'warn');
      snap.frames = [];
    }
  }
  return snap;
}

// Cada <iframe> é um documento separado, com DOM, CSS e canvas próprios. Player
// de vídeo, visualizador 3D e mapa embutido moram todos dentro de um — Spline,
// Sketchfab, YouTube, Vimeo. Sem entrar neles, a cópia fica com um retângulo
// vazio no lugar exatamente do que a pessoa queria clonar.
async function capturarFrames(tabId, opts) {
  const listagem = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => ({ url: location.href, topo: window.top === window }),
  });
  const filhos = listagem.filter((r) => r.result && !r.result.topo && /^https?:/i.test(r.result.url));
  if (!filhos.length) return [];

  // Dentro do frame a varredura lenta não se paga: são poucas telas, e o custo
  // seria multiplicado por quantos frames a página tiver.
  const opcoesFrame = Object.assign({}, opts, { autoScroll: false, slowScan: false, capturarIframes: false });
  const capturados = [];
  for (const frame of filhos.slice(0, MAX_FRAMES)) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] },
        files: ['src/capture.js'],
      });
      const r = await comPrazo(
        chrome.scripting
          .executeScript({
            target: { tabId, frameIds: [frame.frameId] },
            func: (o) => self.__clonasiteCapture(o),
            args: [opcoesFrame],
          })
          .then((lista) => lista[0]),
        FRAME_TIMEOUT_MS,
        'demorou demais'
      );
      if (r && r.result && r.result.ok) capturados.push(r.result);
    } catch (e) {
      log('iframe', 'pulei ' + String(frame.result.url).replace(/^https?:\/\//, '').slice(0, 55) + ' — ' + e.message, 'warn');
    }
  }
  return capturados;
}

// Chave de comparação entre o src do <iframe> e a URL do frame que respondeu:
// o navegador normaliza a URL, então comparar texto cru erra na maioria.
const chaveDeFrame = (u) => {
  try {
    const x = new URL(u);
    // A barra final vai embora: o src escrito na tag e a URL que o frame
    // reporta divergem nela o tempo todo, e isso sozinho já quebrava o encontro.
    return x.origin + x.pathname.replace(/\/+$/, '') + x.search;
  } catch {
    return String(u || '');
  }
};

const origemDe = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return '';
  }
};

// Enfia o documento de cada frame dentro do <iframe> correspondente, como um
// <template>. Sai como <template> de propósito: assim o conteúdo passa pela
// mesma coleta e reescrita de URL do resto da página. Só no fim ele vira
// srcdoc, lá no buildHtml.
async function embutirFrames(snapshot) {
  const frames = (snapshot.frames || []).slice();
  if (!frames.length) return 0;

  let feitos = 0;
  for (const alvo of state.doc.querySelectorAll('iframe[data-clonasite-frame], iframe[src]')) {
    if (!frames.length) break;
    const src = alvo.getAttribute('src') || '';
    if (!src) continue;
    let i = frames.findIndex((f) => chaveDeFrame(f.url) === chaveDeFrame(src));
    // O frame pode ter navegado depois de aberto (redirecionamento, consentimento
    // de cookie): aí só o caminho continua batendo.
    if (i < 0) i = frames.findIndex((f) => chaveDeFrame(f.url).split('?')[0] === chaveDeFrame(src).split('?')[0]);
    // Último recurso: mesma origem. Player e visualizador 3D trocam de URL
    // depois de abertos (consentimento, sessão, redirecionamento), e aí só o
    // domínio continua batendo — mas é ele que identifica o embed.
    if (i < 0 && origemDe(src)) i = frames.findIndex((f) => origemDe(f.url) === origemDe(src));
    if (i < 0) continue;

    const [frame] = frames.splice(i, 1);
    try {
      const doc = new DOMParser().parseFromString(frame.html, 'text/html');
      // O CSS do frame fica DENTRO dele. Jogar no pool compartilhado espalharia
      // o estilo do player por cima da página inteira.
      for (const bloco of await cssDoFrame(frame)) {
        const style = doc.createElement('style');
        if (bloco.media) style.setAttribute('media', bloco.media);
        style.textContent = bloco.text;
        (doc.head || doc.documentElement).appendChild(style);
      }
      const tpl = state.doc.createElement('template');
      tpl.setAttribute('data-clonasite-doc', '1');
      tpl.content.appendChild(state.doc.importNode(doc.documentElement, true));
      alvo.setAttribute('data-clonasite-src', src);
      alvo.appendChild(tpl);
      feitos++;
      // O que o frame baixou também entra na conta: o modelo 3D do Spline vive
      // lá dentro, não aqui fora.
      for (const url of urlsDaRede(frame)) state.daRede.add(url);
    } catch (e) {
      log('iframe', 'não deu para embutir — ' + e.message, 'warn');
    }
  }
  state.frames += feitos;
  return feitos;
}

// Prepara as folhas de estilo de UMA página e devolve os blocos que ela usa.
// Os blocos ficam num pool compartilhado: no rastreio, a folha que se repete
// em todas as páginas é baixada e gravada uma vez só.
async function prepararCss(snapshot) {
  const blocos = [];
  for (const sheet of snapshot.sheets) {
    const chave = sheet.href || 'embutida:' + (sheet.text || '');
    const repetida = state.cssPorChave.get(chave);
    if (repetida) {
      blocos.push(repetida);
      continue;
    }

    let text = sheet.text;
    if (text === null) {
      try {
        text = absolutizeCss(await fetchText(sheet.href), sheet.href);
      } catch (e) {
        state.cssFailures++;
        log('css', 'NÃO veio: ' + sheet.href + ' (' + e.message + ')', 'err');
        continue;
      }
    }
    text = await inlineImports(text, sheet.href || snapshot.baseURI, 0);

    const bloco = {
      name: 'styles/sheet-' + String(state.css.length).padStart(2, '0') + '.css',
      text,
      media: sheet.media,
    };
    state.css.push(bloco);
    state.cssPorChave.set(chave, bloco);
    blocos.push(bloco);
  }
  return blocos;
}

// Mesma preparação de folha, mas SEM entrar no pool compartilhado: o estilo do
// frame tem que ficar dentro do frame.
async function cssDoFrame(snapshot) {
  const blocos = [];
  for (const sheet of snapshot.sheets || []) {
    let text = sheet.text;
    if (text === null) {
      try {
        text = absolutizeCss(await fetchText(sheet.href), sheet.href);
      } catch {
        continue; // folha do frame que não veio não derruba o frame
      }
    }
    try {
      text = await inlineImports(text, sheet.href || snapshot.baseURI, 0);
    } catch {
      /* fica com os @import como estão */
    }
    blocos.push({ text, media: sheet.media });
  }
  return blocos;
}

// Vídeo que o player serve por blob: veio de um arquivo de verdade — o player
// baixou o mp4 e o transformou em blob antes de entregar ao <video>. O blob
// morre com a aba, mas o arquivo original a gravação de rede viu passar. Se ele
// foi baixado, dá para devolver a fonte ao vídeo: é o que salva o vídeo de capa
// dos sites que montam o player em JavaScript, que antes virava um quadro preto.
function restaurarVideosDeBlob() {
  const pendentes = [...state.doc.querySelectorAll('video[data-clonasite-stream="blob"]')];
  if (!pendentes.length) return 0;

  const jaUsados = new Set();
  for (const no of state.doc.querySelectorAll('video[src], source[src]')) {
    jaUsados.add(bareUrl(no.getAttribute('src') || ''));
  }

  const candidatos = [...state.assets.entries()]
    .filter(([url, asset]) => {
      if (jaUsados.has(url)) return false;
      const ehVideo = /^video\//i.test(asset.type || '') || /\.(mp4|webm|mov|m4v|ogv)(\?|$)/i.test(url);
      return ehVideo;
    })
    // O maior primeiro: entre a prévia de 3 segundos e o vídeo inteiro, é o
    // inteiro que a pessoa quer.
    .sort((a, b) => b[1].bytes.length - a[1].bytes.length);

  let feitos = 0;
  for (const video of pendentes) {
    const escolhido = candidatos.shift();
    if (!escolhido) break;
    video.setAttribute('src', escolhido[0]);
    video.removeAttribute('data-clonasite-stream');
    feitos++;
  }
  if (feitos) log('mídia', feitos + ' vídeo(s) de player recuperados do arquivo original', 'ok');
  return feitos;
}

// Junta o que a clonagem descobriu e devolve o prompt em inglês. Fica aqui, e
// não no botão, porque o mesmo texto entra no ZIP como PROMPT.md — quem abre o
// ZIP semanas depois não tem mais o painel para clicar.
function promptDaCopia(snapshot) {
  // No rastreio, quem vale é a página de ENTRADA: é a URL dela que a pessoa vai
  // abrir para comparar. Nesse momento state.snapshot já é a última visitada.
  const snap = snapshot || state.snapshot || {};
  return montarPrompt({
    url: snap.url,
    titulo: snap.title,
    capturadoEm: snap.capturedAt,
    stats: snap.stats || {},
    tecnologias: snap.tecnologias || {},
    secoes: snap.secoes || [],
    recursos: { total: state.assets.size, porTipo: state.porTipo, falhas: state.failures },
    arquivo: state.paginas.length ? 'index.html' : state.filename,
  });
}

// "3D: 7 · imagem: 84 · fonte: 5 · mídia: 2". É a linha que responde de olho se
// a cena 3D veio junto, sem precisar abrir o ZIP.
function relatarFamilias() {
  if (!state.porTipo.size) return;
  const ordem = ['3D', 'mídia', 'imagem', 'fonte', 'script', 'css', 'dados', 'outro'];
  const partes = ordem
    .filter((f) => state.porTipo.get(f))
    .map((f) => f + ': ' + state.porTipo.get(f));
  log('puxado', partes.join(' · ') + ' · ' + fmtBytes(state.bytesIn), 'ok');
  if (state.falhasOpcionais) {
    log('rede', state.falhasOpcionais + ' endereço(s) não deram arquivo (API, POST, sessão) — é o esperado', '');
  }
}

// Relata no log o que a captura encontrou.
function relatarSnapshot(snapshot, mode, opts) {
  const s = snapshot.stats;
  if (snapshot.modoOriginal) log('modo', 'ORIGINAL (v1) — sem varredura e sem mexer em animação', 'warn');
  if (snapshot.scriptsMantidos) log('js', snapshot.scriptsMantidos + ' script(s) mantido(s)', 'ok');
  if (snapshot.pareceSPA && opts.keepScripts) {
    log('js', 'o site monta a tela por JavaScript — se a cópia abrir em branco, desligue "Manter o JavaScript" nas Opções', 'warn');
  }
  log('dom', s.elements + ' elementos, ' + s.shadowRoots + ' shadow roots', 'ok');
  log('imagens', s.imagensCarregadas + '/' + s.imagens + ' carregadas', 'ok');
  if (s.lazyResgatadas) log('lazy', s.lazyResgatadas + ' imagem(ns) resgatada(s)', 'ok');
  if (s.midias) log('mídia', s.midias + ' vídeo(s)/áudio(s) na página', 'ok');
  if (s.midiasResgatadas) log('mídia', s.midiasResgatadas + ' vídeo(s) de blob embutido(s) no clone', 'ok');
  if (s.midiasStreaming) {
    log('mídia', s.midiasStreaming + ' em streaming (HLS/DASH/blob) — sem arquivo; salvei o quadro como capa', 'warn');
  }
  if (s.postersGerados) log('mídia', s.postersGerados + ' capa(s) de vídeo geradas do quadro em tela', 'ok');
  if (s.canvas3d) {
    log(
      '3D',
      s.canvas3d + ' canvas WebGL/WebGPU · ' + s.canvas3dVivos + ' mantido(s) vivo(s) na cópia',
      s.canvas3dVivos ? 'ok' : 'warn'
    );
  }
  if (s.canvasVazios) {
    log('3D', s.canvasVazios + ' canvas 3D devolveu quadro vazio — recarregue a página e clone de novo', 'warn');
  }
  if (s.canvases) log('canvas', s.canvases + ' congelado(s) em imagem', 'ok');
  if (s.blobsResgatados) log('blob', s.blobsResgatados + ' recurso(s) em memória salvos antes de sumir', 'ok');
  if (s.redeVista) log('rede', s.redeVista + ' endereço(s) vistos passar — inclusive os que só o JS pediu', 'ok');
  else if (opts.capturarRede && !snapshot.modoOriginal) {
    log('rede', 'sem gravação de rede — recarregue a página (F5) antes de clonar para pegar o 3D', 'warn');
  }
  if (snapshot.modo === 'component') log('modo', 'componente ' + (snapshot.componente || ''), 'ok');
  else if (mode === 'component') log('modo', 'componente inválido — copiei a página inteira', 'warn');
  if (s.fundosResgatados) log('fundos', s.fundosResgatados + ' fundo(s) resgatado(s)', 'ok');
  if (s.animacoesPreservadas) log('animação', s.animacoesPreservadas + ' preservada(s) para tocar na cópia', 'ok');
  if (s.animacoesDestravadas) log('animação', s.animacoesDestravadas + ' elemento(s) destravado(s)', 'ok');
  if (s.animacoesParaRefazer) log('animação', s.animacoesParaRefazer + ' revelação(ões) anotadas para refazer na cópia', 'ok');
  if (s.animacoesConcluidas) log('animação', s.animacoesConcluidas + ' adiantada(s) para o quadro final', 'ok');
  if (s.telasVarridas) log('varredura', s.telasVarridas + ' tela(s) percorrida(s)', 'ok');
}


// ------------------------------------------------------------- principal

async function clone(mode = 'page') {
  busy = true;
  state = freshState();
  el('log').innerHTML = '';
  resetarAcoes();
  show('running');
  abrirPreview(target && target.url);
  if (target && target.windowId != null) iniciarFotos(target.windowId);
  step('Preparando…', 0.02);

  const tabId = target && target.id;
  if (tabId == null) return fatal('Nenhuma aba para clonar.');

  const stored = await chrome.storage.local.get('opts');
  const opts = Object.assign({}, DEFAULT_OPTS, stored.opts, { mode });
  state.opts = opts;

  // 1. Captura -------------------------------------------------------
  step(
    mode === 'component'
      ? 'Copiando o componente…'
      : opts.autoScroll
        ? 'Rolando a página para acordar as imagens…'
        : 'Lendo a página…',
    0.05
  );
  faixa(0.05, 0.17);
  let snapshot;
  try {
    snapshot = await capturarAba(tabId, opts);
  } catch (e) {
    if (state.cancelado) return encerrarPorCancelamento();
    return fatal('Não consegui ler a página: ' + e.message);
  }
  if (state.cancelado) return encerrarPorCancelamento();

  state.snapshot = snapshot;
  const s = snapshot.stats;
  relatarSnapshot(snapshot, mode, opts);

  // 2. Folhas de estilo ----------------------------------------------
  step('Reunindo folhas de estilo…', 0.18);
  await prepararCss(snapshot);
  if (state.cancelado) return encerrarPorCancelamento();
  log(
    'css',
    state.css.length + '/' + snapshot.sheets.length + ' folha(s) de estilo prontas',
    state.cssFailures ? 'err' : 'ok'
  );

  // 3. Prévia ao vivo, ainda apontando para as URLs originais ---------
  state.doc = new DOMParser().parseFromString(snapshot.html, 'text/html');
  const frames = await embutirFrames(snapshot);
  if (frames) log('iframe', frames + ' frame(s) embutido(s) na cópia', 'ok');

  pintarPreview(buildHtml(() => null, state.css, { inlineCss: true, inlineScripts: false }), {
    copiando: true,
  });
  rolarPreview();

  // 4. Recursos ------------------------------------------------------
  const urls = collectUrls(
    state.doc,
    state.css.map((c) => c.text)
  );
  // O que só a rede viu: modelo 3D, textura, Lottie, wasm, pedaço de bundle.
  if (opts.capturarRede) for (const u of urlsDaRede(snapshot)) state.daRede.add(u);
  let soDaRede = 0;
  for (const u of state.daRede) {
    if (!urls.has(u)) {
      urls.add(u);
      state.somenteRede.add(u);
      soDaRede++;
    }
  }
  if (soDaRede) log('rede', soDaRede + ' recurso(s) que só o JavaScript pediu entraram na fila', 'ok');

  step('Baixando recursos…', 0.3);
  const attempted = await downloadAll(urls);
  if (state.cancelado) return encerrarPorCancelamento();
  log('recursos', state.assets.size + '/' + attempted + ' baixados', state.failures ? 'warn' : 'ok');
  relatarFamilias();
  restaurarVideosDeBlob();

  // 5. HTML único, que baixa sozinho ---------------------------------
  step('Embutindo tudo num HTML só…', 0.88);
  const single = buildSingleFile();
  if (state.scriptsInline) log('js', state.scriptsInline + ' script(s) embutido(s) no HTML', 'ok');
  if (state.scriptsAdiados) {
    log('js', state.scriptsAdiados + ' script(s) com defer foram para o fim do body, para rodar depois do DOM', 'ok');
  }
  if (state.animados) log('animação', state.animados + ' elemento(s) voltam a aparecer com animação na cópia', 'ok');
  if (state.midiasLinkadas) {
    log('mídia', state.midiasLinkadas + ' vídeo(s) grande(s) ficaram linkados no HTML — no ZIP vêm inteiros', 'warn');
  }
  if (single.size > SINGLE_FILE_WARN) log('aviso', 'arquivo grande — o ZIP fica mais leve', 'warn');

  const isComponent = snapshot.modo === 'component';
  const sufixo = (isComponent ? '-componente' : '') + (snapshot.modoOriginal ? '-original' : '');
  state.filename = safeStem() + sufixo + '.html';
  try {
    state.downloadId = await saveBlob(single, state.filename);
    log('download', state.filename, 'ok');
  } catch (e) {
    log('download', 'não iniciou: ' + e.message, 'err');
  }

  // A prévia passa a mostrar a cópia offline: é a prova de que ela renderiza.
  pararPreview();
  if (single.size <= PREVIEW_SWAP_LIMIT) {
    pintarPreview(await single.text(), { copiando: false });
    log('prévia', 'mostrando a cópia offline', 'ok');
  } else {
    el('preview-card').classList.remove('copiando');
    el('preview-selo').lastChild.textContent = 'copiado';
  }

  // 6. ZIP -----------------------------------------------------------
  step('Montando o ZIP…', 0.95);
  const zipResolve = (url) => {
    const [bare, hash] = splitHash(url);
    const asset = state.assets.get(bare);
    return asset ? asset.name + hash : null;
  };
  const cssForZip = state.css.map((block) => ({
    ...block,
    // Dentro de styles/ o caminho precisa subir um nível para chegar em assets/.
    text: rewriteCss(block.text, (url) => {
      const name = zipResolve(url);
      return name ? '../' + name : null;
    }),
  }));

  const entries = [
    { name: 'index.html', data: buildHtml(zipResolve, cssForZip, { inlineCss: false, inlineScripts: false }) },
    { name: 'PROMPT.md', data: promptDaCopia() },
  ];
  for (const block of cssForZip) entries.push({ name: block.name, data: block.text });
  for (const asset of state.assets.values()) entries.push({ name: asset.name, data: asset.bytes });
  entries.push({
    name: 'clone.json',
    data: JSON.stringify(
      {
        ferramenta: MARCA.nome + ' ' + chrome.runtime.getManifest().version,
        origem: snapshot.url,
        titulo: snapshot.title,
        capturadoEm: snapshot.capturedAt,
        arquivos: entries.length + 1,
        folhasDeEstilo: state.css.length,
        recursos: state.assets.size,
        recursosQueFalharam: state.failures,
        estatisticasDom: s,
      },
      null,
      2
    ),
  });
  state.zip = await makeZip(entries);

  // 7. Pronto --------------------------------------------------------
  step('Pronto', 1);
  el('done-file').textContent = state.filename;
  el('done-what').textContent =
    (isComponent ? 'componente ' + (snapshot.componente || '') : 'página inteira') +
    (snapshot.modoOriginal ? ' · modo original (v1)' : '');
  el('done-sub').textContent =
    fmtBytes(single.size) + ' · ' + state.assets.size + ' recursos · ' + state.css.length + ' folhas CSS';
  show('done');
  if (state.failures || state.cssFailures) {
    el('missing-count').textContent = String(state.failures + state.cssFailures);
    el('missing-word').textContent = state.failures + state.cssFailures === 1 ? 'recurso' : 'recursos';
    el('missing-css').classList.toggle(
      'hidden',
      !state.cssFailures
    );
    el('missing-css-count').textContent = String(state.cssFailures);
    el('missing').classList.remove('hidden');
  }
  busy = false;
}

// --------------------------------------------------- site com navegação

// Espera a aba terminar de carregar. Pergunta de tempos em tempos em vez de
// ouvir chrome.tabs.onUpdated: o evento pode disparar antes de a gente começar
// a ouvir, e aí a espera não terminaria nunca.
async function esperarCarregar(tabId, limiteMs = 45_000) {
  const prazo = Date.now() + limiteMs;
  for (;;) {
    let aba;
    try {
      aba = await chrome.tabs.get(tabId);
    } catch {
      throw new Error('a aba de trabalho sumiu');
    }
    if (aba.status === 'complete') return aba;
    if (Date.now() > prazo) throw new Error('demorou demais para carregar');
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Baixa os recursos de uma página e guarda ela na lista do rastreio.
async function registrarPagina(snapshot, doc, css, { raiz, aoProgredir }) {
  const nome = nomeLocalPara(snapshot.url, state.nomesUsados, { raiz });
  const urls = collectUrls(
    doc,
    css.map((c) => c.text)
  );
  if (state.opts.capturarRede) {
    for (const u of urlsDaRede(snapshot)) {
      state.daRede.add(u);
      if (!urls.has(u)) {
        state.somenteRede.add(u);
        urls.add(u);
      }
    }
  }
  await downloadAll(urls, aoProgredir);
  restaurarVideosDeBlob();
  state.paginas.push({ url: normalizarUrl(snapshot.url), nome, doc, css, snapshot });
  return nome;
}

// Devolve os três botões do "pronto" à cena: o rastreio esconde dois.
function resetarAcoes() {
  for (const id of ['open', 'vscode', 'dl-zip']) el(id).classList.remove('hidden');
}

async function cloneSite() {
  busy = true;
  state = freshState();
  el('log').innerHTML = '';
  resetarAcoes();
  show('running');
  abrirPreview(target && target.url);
  if (target && target.windowId != null) iniciarFotos(target.windowId);
  step('Preparando…', 0.02);

  const tabOriginal = target && target.id;
  if (tabOriginal == null) return fatal('Nenhuma aba para clonar.');

  const stored = await chrome.storage.local.get(['opts', 'limitePaginas']);
  const opts = Object.assign({}, DEFAULT_OPTS, stored.opts, { mode: 'page' });
  state.opts = opts;
  const limite = Math.max(1, Math.min(LIMITE_MAX, Number(stored.limitePaginas) || LIMITE_PADRAO));

  let abaTrabalho = null;
  const encerrarAba = async () => {
    if (abaTrabalho) {
      try {
        await chrome.tabs.remove(abaTrabalho.id);
      } catch {
        /* já foi fechada */
      }
      abaTrabalho = null;
    }
    try {
      await chrome.tabs.update(tabOriginal, { active: true });
    } catch {
      /* a aba original sumiu */
    }
  };

  try {
    // 1. Página de entrada ---------------------------------------------
    step('Lendo a página de entrada…', 0.05);
    faixa(0.05, 0.11);
    const entrada = await capturarAba(tabOriginal, opts);
    state.snapshot = entrada;
    relatarSnapshot(entrada, 'page', opts);

    const docEntrada = new DOMParser().parseFromString(entrada.html, 'text/html');
    state.doc = docEntrada;
    const cssEntrada = await prepararCss(entrada);
    await embutirFrames(entrada);

    pintarPreview(buildHtml(() => null, cssEntrada, { inlineCss: true, inlineScripts: false }), {
      copiando: true,
    });
    rolarPreview();

    const alvos = linksDaPagina(docEntrada, entrada.url, { limite: limite - 1 });
    log('rastreio', alvos.length + ' link(s) a seguir · teto de ' + limite + ' página(s)', 'ok');
    if (!alvos.length) {
      log('rastreio', 'nenhum link interno serviu — vai sair só a página de entrada', 'warn');
    }

    await registrarPagina(entrada, docEntrada, cssEntrada, {
      raiz: true,
      aoProgredir: (feito, total) => step('Recursos da entrada · ' + feito + '/' + total, 0.08),
    });

    // 2. Visita link por link ------------------------------------------
    // A aba precisa ficar VISÍVEL. O Chrome congela requestAnimationFrame em
    // aba de fundo, e a captura se apoia nele para esperar a rolagem assentar
    // e as animações terminarem — escondida, ela não termina nunca. Por isso é
    // UMA aba só, reaproveitada, e não vinte abertas de uma vez.
    for (let i = 0; i < alvos.length; i++) {
      if (state.cancelado) break;
      const url = alvos[i];
      const fatia = 0.12 + 0.6 * (i / alvos.length);
      faixa(fatia, fatia + 0.6 / alvos.length);
      step('Visitando página ' + (i + 2) + ' de ' + (alvos.length + 1) + '…', fatia);
      try {
        if (!abaTrabalho) abaTrabalho = await chrome.tabs.create({ url, active: true });
        else await chrome.tabs.update(abaTrabalho.id, { url, active: true });
        // O "Parar" precisa alcançar a aba de trabalho, não só a original.
        state.abaTrabalhoId = abaTrabalho.id;
        await esperarCarregar(abaTrabalho.id);

        const snap = await capturarAba(abaTrabalho.id, opts);
        const doc = new DOMParser().parseFromString(snap.html, 'text/html');
        state.snapshot = snap;
        state.doc = doc;
        const css = await prepararCss(snap);
        await embutirFrames(snap);
        const nome = await registrarPagina(snap, doc, css, {
          raiz: false,
          aoProgredir: (feito, total) =>
            step('Página ' + (i + 2) + ' · recursos ' + feito + '/' + total, fatia),
        });
        log('página', nome + ' · ' + String(snap.title || url).slice(0, 60), 'ok');
      } catch (e) {
        // Uma página que falha não derruba o rastreio: as outras seguem.
        log('página', 'pulei ' + url.replace(/^https?:\/\//, '').slice(0, 55) + ' — ' + e.message, 'warn');
      }
    }
  } catch (e) {
    await encerrarAba();
    return fatal('O rastreio parou: ' + e.message);
  }

  await encerrarAba();
  state.abaTrabalhoId = null;

  if (state.cancelado && !state.paginas.length) return encerrarPorCancelamento();
  if (state.cancelado) log('parado', 'monto o ZIP com as ' + state.paginas.length + ' página(s) já copiadas', 'warn');
  if (!state.paginas.length) return fatal('Nenhuma página pôde ser copiada.');
  log(
    'recursos',
    state.assets.size + ' recurso(s), compartilhados entre as páginas',
    state.failures ? 'warn' : 'ok'
  );
  relatarFamilias();

  // 3. Liga as páginas entre si ----------------------------------------
  step('Ligando as páginas entre si…', 0.78);
  const mapa = new Map(state.paginas.map((pag) => [pag.url, pag.nome]));
  let ligacoes = 0;
  for (const pag of state.paginas) ligacoes += reescreverLinks(pag.doc, mapa, pag.snapshot.url);
  log('links', ligacoes + ' link(s) agora abrem outra página da cópia', 'ok');

  // 4. ZIP navegável ---------------------------------------------------
  step('Montando o ZIP…', 0.9);
  const zipResolve = (url) => {
    const [bare, hash] = splitHash(url);
    const asset = state.assets.get(bare);
    return asset ? asset.name + hash : null;
  };

  const entries = [{ name: 'PROMPT.md', data: promptDaCopia(state.paginas[0].snapshot) }];
  for (const pag of state.paginas) {
    // buildHtml lê state.doc e state.snapshot: troca a página antes de montar.
    state.doc = pag.doc;
    state.snapshot = pag.snapshot;
    entries.push({
      name: pag.nome,
      data: buildHtml(zipResolve, pag.css, { inlineCss: false, inlineScripts: false }),
    });
  }
  // As folhas são compartilhadas, então entram uma vez só. Dentro de styles/ o
  // caminho precisa subir um nível para alcançar assets/.
  for (const bloco of state.css) {
    entries.push({
      name: bloco.name,
      data: rewriteCss(bloco.text, (url) => {
        const nome = zipResolve(url);
        return nome ? '../' + nome : null;
      }),
    });
  }
  for (const asset of state.assets.values()) entries.push({ name: asset.name, data: asset.bytes });

  const entradaPag = state.paginas[0];
  entries.push({
    name: 'clone.json',
    data: JSON.stringify(
      {
        ferramenta: MARCA.nome + ' ' + chrome.runtime.getManifest().version,
        modo: 'site',
        origem: entradaPag.snapshot.url,
        capturadoEm: entradaPag.snapshot.capturedAt,
        paginas: state.paginas.map((pag) => ({
          arquivo: pag.nome,
          url: pag.url,
          titulo: pag.snapshot.title,
        })),
        linksInternos: ligacoes,
        recursos: state.assets.size,
        folhasDeEstilo: state.css.length,
        recursosQueFalharam: state.failures,
      },
      null,
      2
    ),
  });

  state.zip = await makeZip(entries);
  // O nome do ZIP sai da página de entrada, não da última visitada.
  state.snapshot = entradaPag.snapshot;
  state.filename = safeStem() + '-site.zip';
  try {
    state.downloadId = await saveBlob(state.zip, state.filename);
    log('download', state.filename, 'ok');
  } catch (e) {
    log('download', 'não iniciou: ' + e.message, 'err');
  }

  pararPreview();
  el('preview-card').classList.remove('copiando');
  el('preview-selo').lastChild.textContent = 'copiado';

  // 5. Pronto ----------------------------------------------------------
  step('Pronto', 1);
  el('done-file').textContent = state.filename;
  el('done-what').textContent = state.paginas.length + ' página(s) · navega offline';
  el('done-sub').textContent =
    fmtBytes(state.zip.size) + ' · ' + state.assets.size + ' recursos · ' + ligacoes + ' links internos';
  // Aqui o artefato é o ZIP: não existe "um HTML só" para abrir nem para mandar
  // ao editor, então esses dois botões saem de cena.
  el('open').classList.add('hidden');
  el('vscode').classList.add('hidden');
  show('done');
  if (state.failures || state.cssFailures) {
    el('missing-count').textContent = String(state.failures + state.cssFailures);
    el('missing-word').textContent = state.failures + state.cssFailures === 1 ? 'recurso' : 'recursos';
    el('missing-css').classList.toggle('hidden', !state.cssFailures);
    el('missing-css-count').textContent = String(state.cssFailures);
    el('missing').classList.remove('hidden');
  }
  busy = false;
}

// ------------------------------------------------------------- eventos


const onClick = (id, fn) =>
  el(id).addEventListener('click', async () => {
    try {
      await fn();
    } catch (e) {
      console.error(e);
      log('erro', (e && e.message) || String(e), 'err');
    }
  });

async function saveOpts() {
  const chosen = {};
  for (const key of OPT_KEYS) {
    const campo = el('opt-' + key);
    if (campo) chosen[key] = campo.checked;
  }
  await chrome.storage.local.set({ opts: chosen });
}

onClick('go', async () => {
  await saveOpts();
  await clone('page');
});

// Injeta a barra flutuante na página; a escolha volta por mensagem.
onClick('pick', async () => {
  await saveOpts();
  if (!target || target.id == null) return;
  await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ['src/picker.js'] });
  el('pick-hint').textContent = 'Aponte o elemento na página e clique. Esc cancela.';
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'clonasite:pick' || busy) return;
  if (sender.tab && target && sender.tab.id !== target.id) return;
  if (msg.label) log('escolhido', msg.label, 'ok');
  clone(msg.mode === 'component' ? 'component' : 'page').catch((e) => fatal(e.message));
});

// A captura manda notícia de dentro da página. Sem isso a barra fica parada nos
// mesmos 5% durante a varredura inteira — que numa página com 3D leva perto de
// um minuto — e a única leitura possível é "travou".
chrome.runtime.onMessage.addListener((msg) => {
  if (!busy || !msg || msg.type !== 'clonasite:progresso') return;
  const [ini, fim] = faixaCaptura;
  const f = typeof msg.fracao === 'number' ? Math.max(0, Math.min(1, msg.fracao)) : 0;
  step(msg.texto, ini + (fim - ini) * f);
});

onClick('parar', async () => {
  if (!busy || !state || state.cancelado) return;
  state.cancelado = true;
  log('parado', 'você pediu para parar', 'warn');
  step('Parando…', 0);
  for (const controle of state.emVoo) {
    try {
      controle.abort();
    } catch {
      /* já terminou */
    }
  }
  for (const id of [target && target.id, state.abaTrabalhoId]) {
    if (id != null) await pedirAbortar(id);
  }
});

onClick('go-site', () => {
  if (busy) return;
  cloneSite().catch((e) => fatal(e.message));
});

// O teto vive fora de OPT_KEYS: aquilo é só de caixa de seleção, e este é um
// número que nem sequer vai para o capturador.
el('limite-paginas').addEventListener('change', async () => {
  const campo = el('limite-paginas');
  const valor = Math.max(1, Math.min(LIMITE_MAX, Number(campo.value) || LIMITE_PADRAO));
  campo.value = String(valor);
  await chrome.storage.local.set({ limitePaginas: valor });
});

onClick('again', async () => {
  fecharPreview();
  await refreshTarget();
  el('pick-hint').textContent = 'Abre uma barra na página para você apontar o pedaço que quer copiar.';
  show('idle');
});

onClick('retry', async () => {
  fecharPreview();
  await refreshTarget();
  show('idle');
});

onClick('dl-zip', () => saveBlob(state.zip, state.filename.replace(/\.(html|zip)$/i, '') + '.zip'));

onClick('prompt', async () => {
  const texto = promptDaCopia();
  const rotulo = el('prompt-label');
  try {
    await navigator.clipboard.writeText(texto);
    rotulo.textContent = 'Prompt copiado — cole na sua IA';
  } catch {
    // Área de transferência negada (painel sem foco, política do navegador):
    // o prompt vira um arquivo, que serve para a mesma coisa.
    await saveBlob(new Blob([texto], { type: 'text/markdown;charset=utf-8' }), safeStem() + '-PROMPT.md');
    rotulo.textContent = 'Prompt salvo em Downloads';
  }
  log('prompt', texto.length + ' caracteres · em inglês, com a URL e o que quebrou', 'ok');
  setTimeout(() => {
    rotulo.textContent = 'Copiar prompt para refazer em React';
  }, 4000);
});

onClick('vscode', async () => {
  try {
    const caminho = await caminhoDoDownload(state.downloadId);
    // O VS Code registra o esquema vscode:// no sistema operacional, então o
    // navegador só entrega o link — quem abre é ele. Caminho do Windows vem
    // com barra invertida; em URL tem que ser barra normal.
    const alvo = 'vscode://file/' + caminho.replace(/\\/g, '/');
    const a = document.createElement('a');
    a.href = alvo;
    document.body.appendChild(a);
    a.click();
    a.remove();
    log('vs code', 'abrindo ' + state.filename, 'ok');
  } catch (e) {
    log('vs code', 'não deu para abrir: ' + e.message, 'err');
  }
});

onClick('open', async () => {
  if (!state.singleUrl) state.singleUrl = URL.createObjectURL(buildSingleFile());
  await chrome.tabs.create({ url: state.singleUrl });
});

const disclosure = (btnId, bodyId, labels) =>
  el(btnId).addEventListener('click', () => {
    const open = !el(bodyId).classList.toggle('hidden');
    el(btnId).setAttribute('aria-expanded', String(open));
    if (labels) el(labels.id).textContent = open ? labels.open : labels.closed;
  });

disclosure('opts-toggle', 'opts-body');
disclosure('log-toggle', 'log', { id: 'log-label', open: 'Esconder detalhes', closed: 'Detalhes' });

chrome.tabs.onActivated.addListener(refreshTarget);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === 'complete' || info.title) refreshTarget();
});

(async () => {
  aplicarMarca();
  const stored = await chrome.storage.local.get(['opts', 'limitePaginas']);
  el('limite-paginas').value = String(
    Math.max(1, Math.min(LIMITE_MAX, Number(stored.limitePaginas) || LIMITE_PADRAO))
  );
  const opts = Object.assign({}, DEFAULT_OPTS, stored.opts);
  for (const key of OPT_KEYS) {
    const campo = el('opt-' + key);
    if (campo) campo.checked = !!opts[key];
  }
  await refreshTarget();
  show('idle');
})();
