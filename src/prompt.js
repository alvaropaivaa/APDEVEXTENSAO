// O prompt em inglês que sai junto com a cópia.
//
// A cópia estática é o retrato de uma página; ela não é o site de volta. Quem
// vai reconstruir isso em React precisa de duas coisas que não estão no HTML: o
// ENDEREÇO do original, para comparar lado a lado, e a lista do que se perdeu no
// caminho — animação que dependia de biblioteca, vídeo em streaming que não vira
// arquivo, cena 3D, frame de outro domínio.
//
// Por isso o texto é montado com os números da clonagem que acabou de acontecer,
// e não é um modelo fixo: um prompt genérico faz a pessoa do outro lado
// adivinhar, e adivinhar é exatamente o que produz um site "parecido" no lugar
// de uma cópia fiel.
//
// Sai em inglês porque é a língua em que os modelos são mais precisos com
// instrução técnica — e porque o prompt vai ser colado em ferramenta de código.

const lista = (itens, vazio = 'none detected') => (itens && itens.length ? itens.join(', ') : vazio);

const linha = (condicao, texto) => (condicao ? [texto] : []);

const plural = (n, singular, pluralForma) => n + ' ' + (n === 1 ? singular : pluralForma);
// O texto sai em inglês: contagem e verbo precisam concordar, senão vira
// "1 video were served" logo na parte mais importante do prompt.
const foi = (n) => (n === 1 ? 'was' : 'were');

/**
 * @param {object} d
 * @param {string} d.url          endereço original
 * @param {string} d.titulo
 * @param {string} d.capturadoEm
 * @param {object} d.stats        estatísticas do capture.js
 * @param {object} d.tecnologias  { construtor: [], libs: [] }
 * @param {object} d.recursos     { total, porTipo: Map|objeto, falhas }
 * @param {string} d.arquivo      nome do arquivo salvo
 */
export function montarPrompt(d) {
  const s = d.stats || {};
  const tec = d.tecnologias || {};
  const rec = d.recursos || {};
  const porTipo = rec.porTipo instanceof Map ? Object.fromEntries(rec.porTipo) : rec.porTipo || {};

  const inventario = [
    plural(s.elements || 0, 'element', 'elements') + ' in the DOM',
    plural(rec.total || 0, 'downloaded asset', 'downloaded assets'),
    ...linha(porTipo['3D'], plural(porTipo['3D'], '3D asset', '3D assets') + ' (models, textures, environment maps)'),
    ...linha(porTipo['mídia'], plural(porTipo['mídia'], 'video/audio file', 'video/audio files')),
    ...linha(porTipo['fonte'], plural(porTipo['fonte'], 'web font', 'web fonts')),
    ...linha(s.imagens, plural(s.imagens, 'image', 'images')),
  ];

  // O que a cópia estática NÃO conseguiu levar. É a parte mais importante do
  // prompt: sem ela, quem reconstrói não sabe o que precisa refazer do zero.
  const perdido = [
    ...linha(
      s.animacoesParaRefazer,
      plural(s.animacoesParaRefazer, 'scroll-reveal animation', 'scroll-reveal animations') +
        ' ' + foi(s.animacoesParaRefazer) + ' captured only as a start state (`data-clonasite-de` attribute: the opacity/transform ' +
        'the element animated FROM). The static copy fakes them with a CSS transition. ' +
        'Rebuild them as real animations.'
    ),
    ...linha(
      s.animacoesPreservadas,
      plural(s.animacoesPreservadas, 'CSS animation', 'CSS animations') +
        ' survived in the stylesheet and should still work — keep them, do not rewrite them in JS.'
    ),
    ...linha(
      s.canvas3d,
      plural(s.canvas3d, 'WebGL/WebGPU canvas', 'WebGL/WebGPU canvases') +
        ' (3D scene). The static copy keeps the canvas alive and a frozen frame as its background. ' +
        'The scene must be re-created: camera, lights, materials, and the scroll/mouse interaction it had.'
    ),
    ...linha(
      s.midiasStreaming,
      plural(s.midiasStreaming, 'video', 'videos') +
        ' ' + foi(s.midiasStreaming) + ' delivered as HLS/DASH/blob streaming, so no file could be saved — only a poster frame from ' +
        'the moment of capture. These need their real source.'
    ),
    ...linha(
      s.iframes,
      plural(s.iframes, 'iframe', 'iframes') +
        ' ' + foi(s.iframes) + ' flattened into static `srcdoc` snapshots. Anything interactive inside them is frozen.'
    ),
    ...linha(
      s.shadowRoots,
      plural(s.shadowRoots, 'shadow root', 'shadow roots') +
        ' ' + foi(s.shadowRoots) + ' serialized as declarative shadow DOM (web components no longer have their behaviour).'
    ),
    ...linha(rec.falhas, plural(rec.falhas, 'asset', 'assets') + ' failed to download and still point at the original URL.'),
  ];

  const secoes = d.secoes || [];

  const stack = [
    ...linha(tec.construtor && tec.construtor.length, 'Built with: ' + lista(tec.construtor)),
    ...linha(tec.libs && tec.libs.length, 'Libraries detected at runtime: ' + lista(tec.libs)),
  ];


  return `# Port this page to React — do NOT rebuild it

## Read this first, before anything else

**The landing page already exists and is finished. You are not designing one.**

The single most common way this task gets ruined is the assistant reading the
brief, ignoring the attached file, and generating a brand new landing page from
scratch — new sections, new copy, new colors, new layout, "cleaner" markup. That
is a failure, not a deliverable. If what you produce could be described as *your*
version of the page, you did the wrong task.

What you are doing is a **port**: the exact same page, expressed as React
components, with the motion that the static copy could not carry put back.

Two kinds of code exist in this job:

1. **Code you COPY.** All markup, all CSS, all text, all assets. It comes out of
   the attached file, verbatim — same elements, same order, same class names,
   same values. You are transcribing, not authoring.
2. **Code you WRITE.** Only the animation and interaction listed under "What
   broke", plus the minimum React scaffolding to mount what you copied.

If you catch yourself writing markup that is not in the attached file, stop: you
are rebuilding instead of porting.

## The original

**${d.url}**

Open it. Keep it side by side with what you build and compare constantly. The
live site is the spec; the attached file is the source. This prompt only tells
you where to look.

- Page title: ${d.titulo || '(untitled)'}
- Captured: ${d.capturedAt || d.capturadoEm || 'unknown'}
- Attached: \`${d.arquivo || 'index.html'}\` — a static clone of that page, with
  every asset already downloaded (images, fonts, CSS, video, 3D models). This is
  the markup you port. Read it before writing a single line.
${stack.length ? stack.map((l) => '- ' + l).join('\n') + '\n' : ''}
## Copy verbatim — this list is not negotiable

- **Every element, in the same order and the same nesting.** Do not flatten
  wrappers, do not merge \`<div>\`s, do not "simplify" the structure. Those
  wrappers usually carry the layout.
- **Every class name, id and data attribute, spelled exactly the same.** They are
  what the CSS hooks into. Renaming them to something prettier breaks the page
  silently.
- **Every line of CSS.** Port it as \`.css\` files or CSS Modules. Do **not**
  convert it to Tailwind or any utility framework. Do not deduplicate it, do not
  reorder it, do not "tidy" it — cascade order is load-bearing.
- **Every string of text**, including headings, labels, legal lines and alt text.
  Not a paraphrase, not an improvement, not lorem ipsum.
- **Every asset**: the real images, fonts, videos and 3D models that came with
  the clone. No stock photos, no icon swaps, no placeholders.
- **Every breakpoint**: reproduce each media query in the attached CSS as it is.

Things you must NOT do, stated plainly: no redesign, no new palette, no new
fonts, no new spacing scale, no new sections, no removed sections, no reordered
sections, no reworded copy, no new components that were not on the page, no
component library, no "modernising".

## What you DO write: the motion that was lost

${perdido.length ? perdido.map((l) => '- ' + l).join('\n') : '- Nothing significant was lost; still verify motion against the live site.'}

### How to get the animations right

- Go to the live URL and **watch it**. Scroll slowly from top to bottom. Hover
  every button, card and link. Note what moves, in what order, from which
  direction, how far, how fast, and with what easing.
- Elements carrying \`data-clonasite-de\` in the attached HTML are the ones that
  animated in on scroll. The attribute holds the state they animated **from**
  (e.g. \`opacity:0;transform:translateY(40px)\`); their inline style holds the
  state they animate **to**. That pair is the animation — restore it as a real
  scroll-triggered animation, with the stagger between siblings that the original
  has. Then remove the attribute and the stand-in CSS transition the clone added.
- Also restore: hover and focus transitions, marquees, counters, parallax, sticky
  and pinned scroll sections, text splits, page-load intros, cursor effects and
  carousel behaviour.
- Respect \`prefers-reduced-motion\`: motion must be skippable.
${
    secoes.length
      ? '\n## Sections, in order\n\n' +
        'The headings found in the page, top to bottom. Port them as components in\n' +
        'this order — no additions, no removals:\n\n' +
        secoes.map((t, i) => i + 1 + '. ' + t).join('\n') +
        '\n'
      : ''
}
## What the clone contains

${inventario.map((l) => '- ' + l).join('\n')}

## Deliverable

- **Vite + React 18 + TypeScript.**
- One component per section, in \`src/sections/\`, named after what the section
  actually is (\`Hero\`, \`Services\`, \`Fleet\`, \`Footer\`…). A component is a
  container for the copied markup — not a rewrite of it.
- The original CSS, ported as-is into \`.css\` files next to the components.
- The downloaded assets under \`public/\`, referenced from there.
- For animation, prefer the library the original already used${
    tec.libs && tec.libs.length ? ' (' + lista(tec.libs) + ')' : ''
  } so the
  timing and easing come out the same. If it is not available, match the curves
  by hand.
- \`npm install && npm run dev\` must work with no manual steps.
- A short \`README.md\` with two lists: what you restored, and what you could not
  reproduce and why. Be honest in the second list — a known gap is useful, a
  silent one is not.

## Before you tell me it is done

Check every line against the live site, at desktop and mobile widths:

- [ ] The rendered DOM matches the attached file: same sections, same order,
      same nesting, same class names. Diff them if you are unsure.
- [ ] Not one word of copy was changed, added or removed.
- [ ] Fonts, sizes, weights and letter spacing match.
- [ ] Colors match exactly — compare hex values, do not judge by eye.
- [ ] Spacing and alignment match at every breakpoint.
- [ ] Every image, video and icon is the real one from the original.
- [ ] Every scroll animation fires, in the same order, at the same point in the
      scroll, with the same duration and easing.
- [ ] Hover and focus states behave the same.
- [ ] The 3D / canvas content renders and reacts the same way.
- [ ] Nothing logs an error in the console.
- [ ] Nothing exists on the page that was not in the original.
`;
}
