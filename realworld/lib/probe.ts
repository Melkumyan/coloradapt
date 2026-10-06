/**
 * Page-side probes of the M10 real-world harness. Each function is serialized with `toString()` and run in
 * the page's own JavaScript world (Playwright `evaluate` in Chrome, WebDriver `execute` in Firefox), so it
 * must be self-contained: no imports, no closure over module state, plain ES2020.
 *
 * They only *read*. They report what the browser resolved; every number that judges ColorAdapt is computed
 * on the Node side (`color.ts`), so the oracle does not depend on code that is under test.
 */

export interface FeatureProbe {
  readonly url: string;
  readonly title: string;
  readonly lang: string;
  readonly dir: string;
  readonly scripts: string[];
  readonly elements: number;
  readonly textLength: number;
  readonly scrollHeight: number;
  readonly shadow: { openHosts: number; nestedHosts: number; maxDepth: number };
  readonly svg: { inline: number; withText: number; use: number; imgSvg: number };
  readonly canvas: { count: number; large: number; webgl: number };
  readonly images: {
    img: number;
    lazy: number;
    picture: number;
    srcset: number;
    cssBackground: number;
    inlineData: number;
  };
  readonly frames: { total: number; sameOrigin: number; crossOrigin: number };
  readonly forms: { inputs: number; passwords: number; textareas: number; editable: number };
  readonly frameworks: string[];
  readonly cssVariables: number;
  readonly cssInJs: string[];
  readonly contrastSchemeDark: boolean;
  readonly media: { video: number; audio: number };
}

export function featureProbe(): FeatureProbe {
  const all = Array.from(document.querySelectorAll('*'));
  let openHosts = 0;
  let nestedHosts = 0;
  let maxDepth = 0;
  const walk = (root: ParentNode, depth: number): void => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) {
        openHosts++;
        if (depth > 0) nestedHosts++;
        maxDepth = Math.max(maxDepth, depth + 1);
        walk(sr, depth + 1);
      }
    }
  };
  walk(document, 0);

  const svgs = Array.from(document.querySelectorAll('svg'));
  const imgs = Array.from(document.images);
  const canvases = Array.from(document.querySelectorAll('canvas'));
  let webgl = 0;
  for (const c of canvases) {
    // Never create a context (that would change the page); a canvas that already has one reports it.
    const a = c.getAttribute('data-engine') || '';
    if (/webgl|three|pixi/i.test(a + c.className)) webgl++;
  }
  let cssBackground = 0;
  for (const el of all.slice(0, 4000)) {
    if (getComputedStyle(el).backgroundImage.indexOf('url(') >= 0) cssBackground++;
  }
  let cssVariables = 0;
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules).slice(0, 4000)) {
        const text = rule.cssText;
        if (text.indexOf('var(--') >= 0) cssVariables++;
      }
    } catch {
      // cross-origin sheet: unreadable, not counted
    }
  }
  const w = window as unknown as Record<string, unknown>;
  const frameworks: string[] = [];
  if (w['__NEXT_DATA__'] || document.getElementById('__next')) frameworks.push('nextjs');
  if (w['__NUXT__'] || document.getElementById('__nuxt')) frameworks.push('nuxt');
  if (document.querySelector('[ng-version]')) frameworks.push('angular');
  if (
    document.querySelector('[data-reactroot]') ||
    w['React'] ||
    w['__REACT_DEVTOOLS_GLOBAL_HOOK__']
  )
    frameworks.push('react');
  for (const el of all.slice(0, 600)) {
    const keys = Object.keys(el);
    if (keys.some((k) => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'))) {
      if (frameworks.indexOf('react') < 0) frameworks.push('react');
    }
    if (keys.some((k) => k === '__vue_app__' || k === '__vue__')) {
      if (frameworks.indexOf('vue') < 0) frameworks.push('vue');
    }
  }
  if (w['Vue'] || w['__VUE__']) if (frameworks.indexOf('vue') < 0) frameworks.push('vue');
  if (document.querySelector('[data-sveltekit-preload-data],[class*="svelte-"]'))
    frameworks.push('svelte');
  if (document.querySelector('astro-island')) frameworks.push('astro');
  if (document.getElementById('___gatsby')) frameworks.push('gatsby');
  if (w['jQuery']) frameworks.push('jquery');
  if (w['Shopify']) frameworks.push('shopify');
  if (w['ko'] || w['Ember'] || w['Backbone']) frameworks.push('other-mvc');
  const cssInJs: string[] = [];
  if (document.querySelector('style[data-styled]')) cssInJs.push('styled-components');
  if (document.querySelector('style[data-emotion]')) cssInJs.push('emotion');
  if (document.querySelector('style[data-jss]')) cssInJs.push('jss');
  if (document.querySelector('style[data-vanilla-extract],style[data-aphrodite]'))
    cssInJs.push('other');

  const inputs = Array.from(document.querySelectorAll('input'));
  const origin = location.origin;
  let sameOrigin = 0;
  let crossOrigin = 0;
  for (const f of Array.from(document.querySelectorAll('iframe'))) {
    try {
      if (f.contentDocument) sameOrigin++;
      else crossOrigin++;
    } catch {
      crossOrigin++;
    }
  }
  void origin;
  return {
    url: location.href,
    title: document.title.slice(0, 80),
    lang: document.documentElement.lang || '',
    dir: document.documentElement.dir || getComputedStyle(document.documentElement).direction,
    scripts: Array.from(document.scripts)
      .map((s) => s.src)
      .filter(Boolean)
      .slice(0, 0),
    elements: all.length,
    textLength: (document.body?.innerText ?? '').length,
    scrollHeight: document.documentElement.scrollHeight,
    shadow: { openHosts, nestedHosts, maxDepth },
    svg: {
      inline: svgs.length,
      withText: svgs.filter((s) => s.querySelector('text')).length,
      use: document.querySelectorAll('svg use').length,
      imgSvg: imgs.filter((i) => /\.svg(\?|$)/i.test(i.currentSrc || i.src)).length,
    },
    canvas: {
      count: canvases.length,
      large: canvases.filter((c) => c.width * c.height >= 40000).length,
      webgl,
    },
    images: {
      img: imgs.length,
      lazy: imgs.filter((i) => i.loading === 'lazy').length,
      picture: document.querySelectorAll('picture').length,
      srcset: imgs.filter((i) => i.hasAttribute('srcset')).length,
      cssBackground,
      inlineData: imgs.filter((i) => i.src.startsWith('data:')).length,
    },
    frames: { total: sameOrigin + crossOrigin, sameOrigin, crossOrigin },
    forms: {
      inputs: inputs.length,
      passwords: inputs.filter((i) => i.type === 'password').length,
      textareas: document.querySelectorAll('textarea').length,
      editable: document.querySelectorAll('[contenteditable]:not([contenteditable="false"])')
        .length,
    },
    frameworks,
    cssVariables,
    cssInJs,
    contrastSchemeDark: /dark/.test(getComputedStyle(document.documentElement).colorScheme || ''),
    media: {
      video: document.querySelectorAll('video').length,
      audio: document.querySelectorAll('audio').length,
    },
  };
}

export interface OracleElement {
  /** Structural path, anchored at the nearest unique safe id (the audit locator's identity scheme, re-derived). */
  readonly path: string;
  /** The same path to the root without anchors. */
  readonly full: string;
  readonly tag: string;
  readonly color: string;
  /** The element, then each ancestor to the root: its own opacity and the background it paints (see `color.ts`). */
  readonly chain: Array<{
    opacity: number;
    paint: { kind: 'color'; color: string } | { kind: 'gradient' } | { kind: 'image' } | null;
  }>;
  readonly darkCanvas: boolean;
  readonly effects: boolean;
  readonly clipText: boolean;
  readonly fontSize: number;
  readonly fontWeight: number;
  readonly interactive: boolean;
  readonly disabled: boolean;
  readonly inert: boolean;
  readonly positioned: boolean;
  readonly inSvg: boolean;
  readonly sensitive: boolean;
  readonly textChars: number;
  /** `-webkit-text-fill-color` paints something other than `color` (the oracle reads the fill). */
  readonly textFillDiffers: boolean;
  /** Another element is painted over the middle of the text (null: not in the viewport, so not asked). */
  readonly occluded: boolean | null;
  /** The element has `display: contents`: its text is painted in an ancestor's box. */
  readonly displayContents: boolean;
  /** Whether the visible text could be seen at all (size, display, visibility, clip). */
  readonly visible: boolean;
  /** Why not (`display`, `visibility`, `opacity`, `zero-size`), or `offscreen` for an element that is rendered outside the page. */
  readonly hiddenReason: string;
  readonly inShadow: boolean;
  readonly inFrame: boolean;
}

export interface OracleProbe {
  readonly elements: OracleElement[];
  readonly truncated: boolean;
}

export function oracleProbe(limit: number): OracleProbe {
  // The audit only anchors a path at an id it is willing to print (a short, readable one): the same rule, so
  // that the oracle's path of an element is the audit's identity path of it.
  const safeId = (id: string): boolean => {
    const t = id.trim();
    if (t === '' || !/^[A-Za-z0-9_\-:.]+$/.test(t)) return false;
    const cut = t.length > 40 ? t.slice(0, 40) : t;
    if (/\d{6,}/.test(cut) || /[0-9a-f]{16,}/i.test(cut)) return false;
    if (cut.length >= 20 && /\d/.test(cut) && /[A-Za-z]/.test(cut) && !/[-_]/.test(cut))
      return false;
    return cut === id;
  };
  const seen = new Set<Element>();
  const colorMemo = new Map<string, string>();
  const canvasContext = (() => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      return canvas.getContext('2d', { willReadFrequently: true });
    } catch {
      return null;
    }
  })();
  const out: OracleElement[] = [];
  let truncated = false;
  const pathMemo = new Map<Element, string>();
  const fullMemo = new Map<Element, string>();
  const nthOf = (el: Element): number => {
    let n = 0;
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) {
      if (s.localName === el.localName) n++;
    }
    return n + 1;
  };
  const step = (el: Element): string => {
    const tag = el.localName.replace(/[^a-z0-9-]/g, '');
    return tag === 'html' || tag === 'body' ? tag : `${tag}:nth-of-type(${nthOf(el)})`;
  };
  const anchored = (el: Element): string => {
    const memo = pathMemo.get(el);
    if (memo !== undefined) return memo;
    let p: string;
    // `el.id` can be shadowed by a form control named "id" (DOM clobbering): read the attribute.
    const id = el.getAttribute('id') ?? '';
    if (id && safeId(id) && el.ownerDocument.getElementById(id) === el) p = `#${id}`;
    else {
      const parent = el.parentElement;
      p = parent ? `${anchored(parent)}>${step(el)}` : step(el);
    }
    pathMemo.set(el, p);
    return p;
  };
  const full = (el: Element): string => {
    const memo = fullMemo.get(el);
    if (memo !== undefined) return memo;
    const parent = el.parentElement;
    const p = parent ? `${full(parent)}>${step(el)}` : step(el);
    fullMemo.set(el, p);
    return p;
  };
  const rootStyle = getComputedStyle(document.documentElement);
  // the scheme the browser uses: a list with `dark` is dark when the visitor prefers dark or `dark` is alone
  const schemes = (rootStyle.colorScheme || '').toLowerCase().split(' ');
  let prefersDark = false;
  try {
    prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    prefersDark = false;
  }
  const darkCanvas = schemes.indexOf('dark') >= 0 && (schemes.indexOf('light') < 0 || prefersDark);
  const walker = document.createTreeWalker(
    document.body ?? document.documentElement,
    NodeFilter.SHOW_TEXT,
  );
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || seen.has(el)) continue;
    // a character that can be painted: not whitespace, not a zero-width or invisible format character
    if (!node.nodeValue || !/[^\s\u200B-\u200D\u2060\uFEFF]/.test(node.nodeValue)) continue;
    const tag = el.localName;
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') continue;
    seen.add(el);
    if (out.length >= limit) {
      truncated = true;
      break;
    }
    const cs = getComputedStyle(el);
    // `display: contents` has no box of its own: its text is painted in the nearest ancestor that has one
    let box: Element | null = el;
    while (box && getComputedStyle(box).display === 'contents') box = box.parentElement;
    const rendered = box ?? el;
    let visible = false;
    try {
      visible = rendered.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    } catch {
      visible = getComputedStyle(rendered).display !== 'none' && cs.visibility === 'visible';
    }
    // the text's own boxes (a Range), not the element's: right for inline elements and display: contents
    const range = document.createRange();
    range.selectNodeContents(node);
    let rect: DOMRect | null = null;
    for (const r of Array.from(range.getClientRects())) {
      if (r.width > 0 && r.height > 0) {
        rect = r;
        break;
      }
    }
    // a box of no size that clips (overflow or `clip: rect(0 0 0 0)`) paints nothing, whatever its text's Range says
    const boxRect = rendered.getBoundingClientRect();
    const boxStyle = getComputedStyle(rendered);
    const clippedAway =
      (boxRect.width === 0 && boxRect.height === 0 && boxStyle.overflow !== 'visible') ||
      boxStyle.clip === 'rect(0px, 0px, 0px, 0px)' ||
      /^inset\(\s*50%/.test(boxStyle.clipPath);
    const zero = rect === null || clippedAway;
    let hiddenReason = '';
    if (!visible || zero) {
      for (let n: Element | null = rendered; n; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.display === 'none') {
          hiddenReason = 'display';
          break;
        }
        if (parseFloat(s.opacity || '1') === 0) {
          hiddenReason = 'opacity';
          break;
        }
        if (
          (s as unknown as Record<string, string>)['contentVisibility'] === 'hidden' &&
          n !== rendered
        ) {
          hiddenReason = 'content-visibility';
          break;
        }
      }
      if (hiddenReason === '' && cs.visibility !== 'visible') hiddenReason = 'visibility';
      if (hiddenReason === '') hiddenReason = zero ? 'zero-size' : 'not-rendered';
      visible = false;
    } else if (
      rect !== null &&
      (rect.right <= 0 ||
        rect.bottom + window.scrollY <= 0 ||
        rect.left >= document.documentElement.scrollWidth + 1)
    ) {
      hiddenReason = 'offscreen';
    }
    // Colors the browser reports in a form the Node side does not read (lab, oklch, display-p3, ...) are asked
    // of the browser's own canvas, which converts any CSS color to sRGB: independent of both implementations.
    const rgbaOf = (value: string): string => {
      if (value.startsWith('rgb') || value.startsWith('color(srgb') || canvasContext === null) {
        return value;
      }
      const memo = colorMemo.get(value);
      if (memo !== undefined) return memo;
      let result = value;
      try {
        canvasContext.clearRect(0, 0, 1, 1);
        canvasContext.fillStyle = '#123456';
        canvasContext.fillStyle = value;
        // an unreadable value leaves the previous fill: then the answer is "unknown", not a color
        if (canvasContext.fillStyle !== '#123456') {
          canvasContext.fillRect(0, 0, 1, 1);
          const d = canvasContext.getImageData(0, 0, 1, 1).data;
          result = `rgba(${d[0]}, ${d[1]}, ${d[2]}, ${Math.round(((d[3] ?? 255) / 255) * 1000) / 1000})`;
        }
      } catch {
        result = value;
      }
      colorMemo.set(value, result);
      return result;
    };
    const alphaOf = (color: string): number => {
      // rgba(r, g, b, a) | rgb(r, g, b) | color(srgb r g b / a) | color(srgb r g b)
      const comma = /^rgba\([^)]*,\s*([\d.]+)\)$/.exec(color);
      if (comma) return parseFloat(comma[1] ?? '1');
      const slash = /\/\s*([\d.]+)\s*\)$/.exec(color);
      if (slash) return parseFloat(slash[1] ?? '1');
      return 1;
    };
    let effects = false;
    let clipText = false;
    const chain: OracleElement['chain'] = [];
    let positioned = false;
    let coverage = 0;
    for (let n: Element | null = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      // a blend mode, a backdrop filter or a filter function that changes colors (CSS Filter Effects: grayscale,
      // sepia, hue-rotate, invert, brightness, contrast, saturate, opacity, url()) makes the painted color
      // differ from the computed one; a blur or a drop shadow does not
      if (
        (s.mixBlendMode && s.mixBlendMode !== 'normal') ||
        (s.backdropFilter && s.backdropFilter !== 'none') ||
        (s.filter &&
          s.filter !== 'none' &&
          /grayscale|sepia|hue-rotate|invert|brightness|contrast|saturate|opacity|url\(/i.test(
            s.filter,
          ))
      ) {
        effects = true;
      }
      // a clipped background paints only the glyphs of the element and what is inside it: text on it, or under
      // it, has no solid background to measure (as long as something above has not covered it already)
      const clip =
        (s as unknown as Record<string, string>)['webkitBackgroundClip'] || s.backgroundClip;
      if (clip === 'text' && coverage < 0.999999) clipText = true;
      if (n === el && (s.position === 'absolute' || s.position === 'fixed')) positioned = true;
      // What the group below this element already covers: a background behind a fully covered group is never
      // seen. Each element composites its content over its own background and then fades the result, so the
      // coverage after it is opacity x (coverage + (1 - coverage) x alpha of its background).
      let paint: OracleElement['chain'][number]['paint'] = null;
      let alpha = 0;
      if (coverage < 0.999999) {
        const img = s.backgroundImage;
        const bg = s.backgroundColor;
        if (img && img !== 'none') {
          paint =
            img.indexOf('url(') >= 0 || img.indexOf('image-set(') >= 0
              ? { kind: 'image' }
              : { kind: 'gradient' };
          alpha = 1;
        } else if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
          const color = rgbaOf(bg);
          paint = { kind: 'color', color };
          alpha = alphaOf(color);
        }
      }
      coverage = parseFloat(s.opacity || '1') * (coverage + (1 - coverage) * alpha);
      chain.push({ opacity: parseFloat(s.opacity || '1'), paint });
    }
    const fill = (cs as unknown as Record<string, string>)['webkitTextFillColor'];
    const rawColor = fill && fill !== cs.color && fill !== 'currentcolor' ? fill : cs.color;
    const color = rgbaOf(rawColor);
    let occluded: boolean | null = null;
    if (visible && rect !== null && rect.bottom > 0 && rect.right > 0) {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight) {
        const top = document.elementFromPoint(cx, cy);
        occluded = top !== null && top !== el && !el.contains(top) && !top.contains(el);
      }
    }
    out.push({
      path: anchored(el),
      full: full(el),
      tag,
      color,
      chain,
      darkCanvas,
      effects,
      clipText,
      fontSize: parseFloat(cs.fontSize),
      fontWeight: parseFloat(cs.fontWeight) || 400,
      interactive:
        el.closest(
          'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"]',
        ) !== null,
      disabled: el.closest('[disabled],[aria-disabled="true"],fieldset[disabled]') !== null,
      inert: el.closest('[inert],[aria-hidden="true"]') !== null,
      positioned,
      inSvg: el.closest('svg') !== null,
      sensitive:
        tag === 'textarea' ||
        tag === 'option' ||
        el.closest('[contenteditable]:not([contenteditable="false"])') !== null,
      textChars: (node.nodeValue || '').trim().length,
      textFillDiffers: rawColor !== cs.color,
      occluded,
      displayContents: box !== el,
      visible,
      hiddenReason,
      inShadow: el.getRootNode() instanceof ShadowRoot,
      inFrame: window !== window.top,
    });
  }
  return { elements: out, truncated };
}

export interface IntegrityProbe {
  readonly href: string;
  readonly title: string;
  readonly historyLength: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly scrollHeight: number;
  readonly scrollWidth: number;
  readonly elementCount: number;
  /** One digest per element in document order: tag + every attribute that is not ColorAdapt's own. */
  readonly digests: string[];
  readonly formValues: string[];
  readonly foreign: number;
  /** Rects of up to `rectLimit` visible elements (x, y, w, h rounded to 0.5). */
  readonly rects: number[][];
  readonly activeElementPath: string;
}

export function integrityProbe(rectLimit: number): IntegrityProbe {
  const digests: string[] = [];
  const formValues: string[] = [];
  const rects: number[][] = [];
  let foreign = 0;
  const els = Array.from(document.querySelectorAll('*'));
  for (const el of els) {
    if (
      (el.getAttribute('id') ?? '').startsWith('coloradapt-') ||
      el.hasAttribute('data-coloradapt-chart-node') ||
      el.hasAttribute('data-coloradapt-audit-overlay')
    ) {
      foreign++;
      continue;
    }
    const attrs = Array.from(el.attributes)
      .filter((a) => !a.name.startsWith('data-coloradapt'))
      // An empty `style` is what automation (a screenshot's caret hiding) leaves behind; it is not page state.
      .filter((a) => !(a.name === 'style' && a.value === ''))
      .map((a) => `${a.name}=${a.value}`)
      .sort();
    digests.push(`${el.localName}|${attrs.join('|')}`);
    const tag = el.localName;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const f = el as HTMLInputElement;
      formValues.push(`${tag}:${f.type}:${f.value}:${f.checked}`);
    }
    if (rects.length < rectLimit) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        rects.push([
          Math.round(r.x * 2) / 2,
          Math.round((r.y + window.scrollY) * 2) / 2,
          Math.round(r.width * 2) / 2,
          Math.round(r.height * 2) / 2,
        ]);
      }
    }
  }
  const ae = document.activeElement;
  return {
    href: location.href,
    title: document.title,
    historyLength: history.length,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
    elementCount: els.length,
    digests,
    formValues,
    foreign,
    rects,
    activeElementPath: ae ? ae.localName : '',
  };
}

/** `fn` as source for `evaluate`: `(function ...)(arg)`. */
export function call(fn: (...args: never[]) => unknown, ...args: unknown[]): string {
  return `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`;
}
