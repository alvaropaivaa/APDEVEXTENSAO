// Clonagem de várias páginas: descobrir para onde os links levam, dar nome de
// arquivo a cada página e reescrever os links para que a cópia offline navegue
// entre eles.
//
// Tudo aqui é função pura sobre DOM e URL — nada de chrome.*, nada de rede. É
// o que permite testar o rastreamento inteiro sem abrir navegador.

// Parâmetros que a query string carrega só para rastrear campanha. Se ficarem,
// a mesma página vira duas entradas no rastreio e dois arquivos no ZIP.
const LIXO_DE_QUERY =
  /^(utm_[a-z_]+|fbclid|gclid|gbraid|wbraid|msclkid|mc_[ce]id|igshid|ref|ref_src|_ga|yclid|_openstat)$/i;

// Endereço que não é página: seguir isso gastaria uma vaga do limite baixando
// um PDF ou uma imagem que o clone já pega como recurso.
const NAO_E_PAGINA =
  /\.(zip|rar|7z|gz|tar|exe|msi|dmg|pkg|apk|pdf|docx?|xlsx?|pptx?|odt|csv|txt|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp4|webm|ogv|mov|mkv|mp3|wav|m4a|flac|woff2?|ttf|otf|eot|css|js|mjs|json|xml|rss|atom)$/i;

// Link que muda estado ou destrói sessão. O rastreio roda com a SUA sessão
// aberta: seguir um "sair" derruba o login no meio do trabalho, e um
// "add-to-cart" enche o carrinho de verdade. Nenhum deles rende página útil
// offline, então ficam de fora por padrão.
const PERIGOSO =
  /(\/|[?&=_-])(logout|log-out|sign-?out|sair|deslogar|desconectar|add-to-cart|adicionar-ao-carrinho|remove_item|remover|excluir|delete|destroy|wp-login|wp-admin|xmlrpc)([/?&=_-]|$)/i;

// Página que existe, mas não rende cópia: ou é formulário de sessão, ou é
// área logada que offline vira tela vazia.
const SEM_GRACA = /(\/|^)(login|entrar|signin|sign-in|cadastro|register|checkout|carrinho|cart|minha-conta|my-account|painel|dashboard)(\/|$)/i;

/**
 * Deixa a URL numa forma comparável: sem fragmento, sem parâmetro de campanha
 * e sem barra final. Duas URLs que apontam para a mesma página passam a ser a
 * mesma string — é o que impede o rastreio de clonar a mesma coisa duas vezes.
 * Devolve null se a URL não for utilizável.
 */
export function normalizarUrl(bruta, base) {
  let u;
  try {
    u = new URL(bruta, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  u.hash = '';
  const limpos = [...u.searchParams.keys()].filter((k) => LIXO_DE_QUERY.test(k));
  for (const k of limpos) u.searchParams.delete(k);

  // "/produtos/" e "/produtos" são a mesma página; a raiz continua com a barra.
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.href;
}

/**
 * Os links que valem a pena seguir a partir de um documento já renderizado.
 * Sai na ordem em que aparecem na página — numa vitrine isso é a ordem dos
 * produtos, então cortar no limite corta os últimos, não um punhado aleatório.
 */
export function linksDaPagina(doc, baseUrl, opcoes = {}) {
  const { mesmaOrigem = true, incluirSemGraca = false, limite = Infinity } = opcoes;

  const raiz = normalizarUrl(baseUrl);
  const origem = raiz ? new URL(raiz).origin : null;

  const achados = [];
  const vistos = new Set(raiz ? [raiz] : []); // a própria página nunca se repete

  for (const a of doc.querySelectorAll('a[href]')) {
    const bruto = a.getAttribute('href') || '';
    // Âncora pura e javascript: não levam a lugar nenhum novo.
    if (!bruto || bruto.startsWith('#')) continue;

    const url = normalizarUrl(bruto, baseUrl);
    if (!url || vistos.has(url)) continue;

    const u = new URL(url);
    if (mesmaOrigem && origem && u.origin !== origem) continue;
    if (NAO_E_PAGINA.test(u.pathname)) continue;
    if (PERIGOSO.test(url)) continue;
    if (!incluirSemGraca && SEM_GRACA.test(u.pathname)) continue;

    vistos.add(url);
    achados.push(url);
    if (achados.length >= limite) break;
  }
  return achados;
}

/**
 * Nome do arquivo local de uma página. A primeira página é sempre index.html —
 * é o que o navegador abre ao apontar para a pasta.
 */
export function nomeLocalPara(url, usados = new Set(), { raiz = false } = {}) {
  if (raiz) {
    usados.add('index.html');
    return 'index.html';
  }

  let base = 'pagina';
  try {
    const u = new URL(url);
    const partes = u.pathname.split('/').filter(Boolean);
    if (partes.length) base = partes.slice(-2).join('-');
    // Query que sobrou é o que separa "?page=2" de "?page=3": entra no nome.
    const q = [...u.searchParams.entries()].map(([k, v]) => k + '-' + v).join('-');
    if (q) base += '-' + q;
  } catch {
    /* fica com o padrão */
  }

  base = decodeURIComponent(base)
    .replace(/\.[a-z0-9]{2,5}$/i, '') // .php/.aspx não dizem nada na cópia
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (!base) base = 'pagina';

  let nome = base + '.html';
  let n = 2;
  while (usados.has(nome)) nome = base + '-' + n++ + '.html';
  usados.add(nome);
  return nome;
}

/**
 * Aponta os links do documento para os arquivos locais. O que não foi clonado
 * fica absoluto de propósito: melhor um link que abre o site de verdade do que
 * um que quebra num arquivo inexistente.
 *
 * Devolve quantos links passaram a apontar para dentro da cópia.
 */
export function reescreverLinks(doc, mapa, baseUrl) {
  let trocados = 0;
  for (const a of doc.querySelectorAll('a[href]')) {
    const bruto = a.getAttribute('href') || '';
    if (!bruto || bruto.startsWith('#')) continue;

    const url = normalizarUrl(bruto, baseUrl);
    const destino = url && mapa.get(url);
    if (!destino) {
      // Vai continuar apontando para a internet: deixa absoluto para não virar
      // caminho relativo quebrado dentro do ZIP.
      try {
        a.setAttribute('href', new URL(bruto, baseUrl).href);
      } catch {
        /* href esquisito: melhor não mexer */
      }
      continue;
    }
    // O fragmento é do documento de destino e sobrevive à troca.
    let hash = '';
    try {
      hash = new URL(bruto, baseUrl).hash;
    } catch {
      /* sem fragmento */
    }
    a.setAttribute('href', destino + hash);
    trocados++;
  }
  return trocados;
}
