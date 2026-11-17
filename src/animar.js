// Animação de entrada, refeita na cópia.
//
// AOS, ScrollReveal, WOW, GSAP e Framer deixam o elemento em opacity:0 e
// deslocado até ele entrar na tela. O capturador anota esse estado inicial em
// `data-clonasite-de` e deixa o elemento no estado FINAL — assim a cópia nunca
// abre com metade da página invisível, mesmo sem JavaScript nenhum.
//
// Só que aí a página fica parada: tudo já revelado, nada acontecendo. E a
// animação original raramente volta sozinha, porque ela dependia da biblioteca
// do site inicializar — e num arquivo estático, sem as APIs e os dados que ela
// espera, isso falha em boa parte dos sites.
//
// Este trecho refaz a revelação por conta própria: devolve o estado inicial,
// observa a rolagem e anima até o estado final que o capturador guardou. Não
// depende de biblioteca nenhuma, e o estado final continua sendo o que vale se
// este código não rodar.

export function codigoDoAnimar({ duracao = 700, escada = 90 } = {}) {
  return (
    '(function(){\n' +
    'var els=[].slice.call(document.querySelectorAll("[data-clonasite-de]"));\n' +
    'if(!els.length)return;\n' +
    'var D=' + Number(duracao) + ',E=' + Number(escada) + ';\n' +
    'var mov="(prefers-reduced-motion: reduce)";\n' +
    // Quem pediu menos movimento no sistema não quer isto. Fica no estado final.
    'try{if(window.matchMedia&&window.matchMedia(mov).matches){els.forEach(function(el){' +
    'el.removeAttribute("data-clonasite-de");});return;}}catch(e){}\n' +
    'var trans="opacity "+D+"ms cubic-bezier(.22,.61,.36,1),transform "+D+"ms cubic-bezier(.22,.61,.36,1)";\n' +
    'var fila=[];\n' +
    'els.forEach(function(el){\n' +
    ' var de=el.getAttribute("data-clonasite-de")||"";\n' +
    // O style que o capturador deixou é o estado final: guardá-lo é o que
    // permite voltar exatamente para ele, sem chutar valor nenhum.
    ' var fim=el.getAttribute("style")||"";\n' +
    ' fila.push({el:el,fim:fim});\n' +
    ' el.setAttribute("style",fim+";"+de+";transition:"+trans+";will-change:opacity,transform");\n' +
    ' el.removeAttribute("data-clonasite-de");\n' +
    '});\n' +
    'function revelar(item,atraso){\n' +
    ' if(item.feito)return;item.feito=true;\n' +
    ' setTimeout(function(){\n' +
    '  item.el.setAttribute("style",item.fim+";transition:"+trans);\n' +
    // will-change custa memória de composição: sai assim que a animação acaba.
    '  setTimeout(function(){item.el.setAttribute("style",item.fim);},D+60);\n' +
    ' },atraso||0);\n' +
    '}\n' +
    'if(!window.IntersectionObserver){fila.forEach(function(i){revelar(i,0);});return;}\n' +
    'var mapa=new Map();fila.forEach(function(i){mapa.set(i.el,i);});\n' +
    'var vistos=0;\n' +
    'var io=new IntersectionObserver(function(entradas){\n' +
    ' entradas.forEach(function(e){\n' +
    '  if(!e.isIntersecting)return;\n' +
    '  var item=mapa.get(e.target);if(!item)return;\n' +
    '  io.unobserve(e.target);\n' +
    // A escada é o que dá o ritmo de "um depois do outro" em vez de tudo de uma
    // vez; ela zera a cada leva para não acumular atraso página abaixo.
    '  revelar(item,Math.min(5,vistos++)*E);\n' +
    ' });\n' +
    ' setTimeout(function(){vistos=0;},D);\n' +
    '},{rootMargin:"0px 0px -8% 0px",threshold:0.04});\n' +
    'fila.forEach(function(i){io.observe(i.el);});\n' +
    // Rede de segurança: se em 6 segundos alguma coisa não revelou — observer
    // que não disparou, elemento fora de fluxo — ela aparece assim mesmo. Uma
    // cópia com conteúdo invisível seria pior que uma cópia sem animação.
    'setTimeout(function(){fila.forEach(function(i){revelar(i,0);});},6000);\n' +
    '})();'
  );
}
