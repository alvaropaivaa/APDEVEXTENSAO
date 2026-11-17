// Marca — white label.
//
// Este é o único arquivo que precisa mudar para a extensão sair com a cara de
// outra empresa. Nome, logo e as quatro cores da marca moram aqui; o painel lê
// tudo isso na hora que abre e aplica por cima do CSS.
//
// O que NÃO fica aqui, de propósito: o nome que aparece no Chrome (na barra de
// extensões e na chrome://extensions) vem do manifest.json, porque o Chrome lê
// aquele arquivo antes de qualquer JavaScript rodar. Trocar a marca é mexer
// nestes dois lugares — aqui e no manifest.
//
// A logo precisa de duas versões porque ela aparece sobre dois fundos:
//   logo       → sobre o branco do painel  (use a versão colorida/escura)
//   logoClara  → sobre o verde da tela de carregamento (use a versão branca)
// Se você só tem uma versão, aponte as duas para o mesmo arquivo — só confira
// que ela é legível nos dois fundos.

export const MARCA = {
  nome: 'AP Dev Clone',
  tagline: 'Clonador de sites',

  logo: 'icons/apdev-green.png',
  logoClara: 'icons/apdev-white.png',

  // Estas quatro viram variáveis CSS (--brand, --brand-hi, ...) e pintam botão,
  // barra de progresso, realce do seletor e a tela de carregamento.
  cores: {
    brand: '#16a34a',
    'brand-hi': '#22c55e',
    'brand-deep': '#166534',
    'brand-wash': '#e9f9ef',
  },
};

// Aplica a marca no documento. Chamado uma vez, quando o painel abre.
export function aplicarMarca(doc = document) {
  const raiz = doc.documentElement;
  for (const [nome, valor] of Object.entries(MARCA.cores)) {
    if (valor) raiz.style.setProperty('--' + nome, valor);
  }

  doc.title = MARCA.nome;

  const titulo = doc.getElementById('marca-nome');
  if (titulo) titulo.textContent = MARCA.nome;

  const tagline = doc.getElementById('marca-tagline');
  if (tagline) tagline.textContent = MARCA.tagline;

  const logo = doc.querySelector('.marca .logo');
  if (logo) {
    logo.src = MARCA.logo;
    logo.alt = MARCA.nome;
  }

  for (const clara of doc.querySelectorAll('.logo-clara')) {
    clara.src = MARCA.logoClara;
    clara.alt = '';
  }
}
