// Desvio em tempo de execução.
//
// Baixar o modelo 3D não adianta nada sozinho: quem pede o arquivo é o
// JavaScript do site, e ele pede pela URL original — que offline não existe.
// Este trecho entra como o primeiro <script> da cópia e desvia, em tempo de
// execução, fetch, XHR, atributo src/href, propriedade .src e Worker para o
// arquivo local. É a peça que faz a cena 3D montar sem internet.
//
// Mora aqui, e não dentro do painel, porque o motor de servidor monta a mesma
// cópia e precisa exatamente do mesmo desvio.

export function codigoDoDesvio(mapaJson) {
  return (
    '(function(){\n' +
    'var M=' + mapaJson + ';\n' +
    // Dois índices de reserva, para quando a chave exata não casa:
    //
    //   P, por CAMINHO — a cópia abre em file:// ou blob:, onde o domínio
    //   original deixou de existir. Um pedido a "/api/dados" ou
    //   "/assets/cena.glb" vira "file:///api/dados": o caminho é a única parte
    //   que sobrevive à mudança de origem, e é o que casa com o que foi salvo.
    //
    //   B, por NOME DE ARQUIVO — bundler e loader 3D penduram um ?v=123
    //   diferente a cada carga, e às vezes montam o caminho de outro jeito.
    // Sem regex de propósito: uma barra escapada dentro de string vira barra
    // solta no código gerado, e a expressão fecharia no meio.
    'function cam(u){var i=u.indexOf("://");if(i<0)return u;' +
    'var j=u.indexOf("/",i+3);return j<0?"":u.slice(j);}\n' +
    'var B={},P={};for(var k in M){try{var lim=k.split("#")[0].split("?")[0];' +
    'var n=lim.split("/").pop();if(n&&!(n in B))B[n]=M[k];' +
    'var c=cam(lim);if(c&&c.length>1&&!(c in P))P[c]=M[k];}catch(e){}}\n' +
    'var base=document.baseURI||location.href;\n' +
    'function achar(u){\n' +
    ' if(!u)return null;var s;try{s=String(u);}catch(e){return null;}\n' +
    ' if(s.slice(0,5)==="data:"||s.slice(0,5)==="blob:")return null;\n' +
    ' var a;try{a=new URL(s,base).href;}catch(e){a=s;}\n' +
    ' var sh=a.split("#")[0];if(M[sh])return M[sh];\n' +
    ' var sq=sh.split("?")[0];if(M[sq])return M[sq];\n' +
    ' var cm=cam(sq);if(cm&&P[cm])return P[cm];\n' +
    ' var nm=sq.split("/").pop();if(nm&&B[nm])return B[nm];\n' +
    ' return null;\n' +
    '}\n' +
    'var f0=window.fetch;\n' +
    'if(f0)window.fetch=function(e,i){try{var u=typeof e==="string"?e:(e&&e.url);var l=achar(u);' +
    'if(l)return f0.call(this,l,typeof e==="string"?i:undefined);}catch(x){}return f0.apply(this,arguments);};\n' +
    'var o0=XMLHttpRequest.prototype.open;\n' +
    'XMLHttpRequest.prototype.open=function(m,u){try{var l=achar(u);if(l)arguments[1]=l;}catch(e){}return o0.apply(this,arguments);};\n' +
    'var sa=Element.prototype.setAttribute;\n' +
    'Element.prototype.setAttribute=function(n,v){try{if(n==="src"||n==="href"||n==="poster"||n==="xlink:href"){' +
    'var l=achar(v);if(l)return sa.call(this,n,l);}}catch(e){}return sa.apply(this,arguments);};\n' +
    'var alvos=[[window.HTMLImageElement,"src"],[window.HTMLScriptElement,"src"],[window.HTMLMediaElement,"src"],' +
    '[window.HTMLSourceElement,"src"],[window.HTMLLinkElement,"href"],[window.HTMLIFrameElement,"src"]];\n' +
    'for(var i=0;i<alvos.length;i++){(function(par){try{\n' +
    ' var p=par[0]&&par[0].prototype;if(!p)return;\n' +
    ' var d=Object.getOwnPropertyDescriptor(p,par[1]);if(!d||!d.set)return;\n' +
    ' Object.defineProperty(p,par[1],{configurable:true,enumerable:d.enumerable,get:d.get,\n' +
    '  set:function(v){var l=null;try{l=achar(v);}catch(e){}return d.set.call(this,l||v);}});\n' +
    '}catch(e){}})(alvos[i]);}\n' +
    // Draco, Basis e Meshopt descomprimem malha e textura dentro de um Worker,
    // buscado por URL própria. Sem desviar ele, a cena carrega e não aparece.
    'if(window.Worker){var W=window.Worker;window.Worker=function(u,o){var l=null;try{l=achar(u);}catch(e){}return new W(l||u,o);};' +
    'window.Worker.prototype=W.prototype;}\n' +
    // Offline, o service worker só serve para encher o console de erro.
    'try{if(navigator.serviceWorker)navigator.serviceWorker.register=function(){' +
    'return Promise.reject(new Error("clonasite: cópia offline"));};}catch(e){}\n' +
    '})();'
  );
}
