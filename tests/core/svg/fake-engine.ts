import { parseColor } from '@core/color';
import { createBackgroundResolutionCache } from '@core/analysis';
import { PROBE_COLORS, type SvgAnalysisEnvironment } from '@core/svg';

/**
 * A miniature CSS engine for SVG paint, enough to give the analyzer the inputs a
 * browser would. jsdom's `getComputedStyle` knows nothing about `fill`/`stroke`
 * inheritance, so the cascade the tests care about is spelled out here:
 *
 *  - declarations come from presentation attributes, then `addRule`s, then the
 *    inline `style` attribute (later wins); ColorAdapt's own `<style>` rules
 *    (`!important`) out-rank all of those, and an inline `!important` out-ranks them;
 *  - `fill`, `stroke`, `stroke-width`, `fill-opacity`, `stroke-opacity`, `color`
 *    and `visibility` inherit; `opacity`, `display`, `filter`, `mask`,
 *    `mix-blend-mode` do not;
 *  - `currentColor` computes to the element's resolved `color` (as Chromium does);
 *  - a style probe (see `core/svg/inheritance.ts`) overrides the probed
 *    element's `fill`/`stroke`/`color` for the duration of `read`.
 */
const INHERITED = new Set([
  'color',
  'fill',
  'stroke',
  'stroke-width',
  'fill-opacity',
  'stroke-opacity',
  'visibility',
]);

const ATTRIBUTES = [
  'color',
  'fill',
  'stroke',
  'stroke-width',
  'fill-opacity',
  'stroke-opacity',
  'opacity',
  'display',
  'visibility',
  'filter',
  'mask',
  'mix-blend-mode',
  'marker-start',
];

const DEFAULTS: Record<string, string> = {
  color: 'rgb(0, 0, 0)',
  fill: 'rgb(0, 0, 0)',
  stroke: 'none',
  'stroke-width': '1px',
  'fill-opacity': '1',
  'stroke-opacity': '1',
  visibility: 'visible',
  opacity: '1',
  display: 'inline',
  filter: 'none',
  mask: 'none',
  'mix-blend-mode': 'normal',
  'marker-start': 'none',
};

function rgb(value: string): string {
  const color = parseColor(value);
  if (!color) return value;
  const byte = (n: number) => Math.round(n * 255);
  return color.alpha < 1
    ? `rgba(${byte(color.r)}, ${byte(color.g)}, ${byte(color.b)}, ${color.alpha})`
    : `rgb(${byte(color.r)}, ${byte(color.g)}, ${byte(color.b)})`;
}

function normalizePaint(value: string): string {
  const text = value.trim();
  const url = /^url\(\s*#([^)\s]+)\s*\)$/.exec(text);
  if (url) return `url("#${url[1]}")`;
  if (text === 'none' || text.startsWith('context-')) return text;
  return rgb(text);
}

export interface FakeEngine {
  readonly env: SvgAnalysisEnvironment;
  readonly getStyle: (element: Element) => CSSStyleDeclaration;
  /** A declaration as an author stylesheet rule (`selector { property: value }`). */
  addRule(selector: string, declarations: Record<string, string>): void;
  /** How many times the probe was applied (one per batch is the point). */
  readonly probes: number;
}

export function createFakeEngine(
  doc: Document,
  options: { probe?: boolean; animated?: Element[] } = {},
): FakeEngine {
  const rules: Array<{ selector: string; declarations: Record<string, string> }> = [];
  const overrides = new Map<Element, Record<string, string>>();
  let probes = 0;
  let nextId = 0;

  /**
   * Rules of ColorAdapt's own sheet that target `element`: one rule per declaration
   * (`[data-coloradapt-s~="token"] { prop: value !important }`), matched through the element's token list.
   */
  function sheetDeclarations(element: Element): Record<string, string> {
    const tokens = new Set((element.getAttribute('data-coloradapt-s') ?? '').split(' '));
    const text = doc.getElementById('coloradapt-stylesheet')?.textContent ?? '';
    const out: Record<string, string> = {};
    if (tokens.size === 0) return out;
    for (const m of text.matchAll(
      /\[data-coloradapt-s~="([^"]+)"\][^{]*\{\s*([a-z-]+):\s*([^;!]+?)\s*!important;/g,
    )) {
      if (tokens.has(m[1]!)) out[m[2]!] = m[3]!;
    }
    return out;
  }

  function declared(element: Element): Record<string, string> {
    const out: Record<string, string> = {};
    const important: Record<string, string> = {};
    for (const name of ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value !== null) out[name] = value;
    }
    for (const rule of rules) {
      if (element.matches(rule.selector)) Object.assign(out, rule.declarations);
    }
    for (const part of (element.getAttribute('style') ?? '').split(';')) {
      const colon = part.indexOf(':');
      if (colon <= 0) continue;
      const name = part.slice(0, colon).trim();
      const value = part.slice(colon + 1).trim();
      if (/!important$/i.test(value)) important[name] = value.replace(/\s*!important$/i, '');
      else out[name] = value;
    }
    return { ...out, ...sheetDeclarations(element), ...important, ...overrides.get(element) };
  }

  function compute(element: Element, property: string): string {
    const own = declared(element)[property];
    const parent = element.parentElement;
    const inherited = (): string =>
      parent && INHERITED.has(property) ? compute(parent, property) : (DEFAULTS[property] ?? '');
    if (own === undefined || own === 'inherit')
      return INHERITED.has(property) || own ? inherited() : (DEFAULTS[property] ?? '');
    if (property === 'color') return rgb(own);
    if (property === 'fill' || property === 'stroke') {
      return own.trim().toLowerCase() === 'currentcolor'
        ? compute(element, 'color')
        : normalizePaint(own);
    }
    return own;
  }

  const getStyle = (element: Element): CSSStyleDeclaration => {
    const get = (property: string) => compute(element, property);
    const maskValue = get('mask');
    return {
      display: get('display'),
      visibility: get('visibility'),
      opacity: get('opacity'),
      fill: get('fill'),
      stroke: get('stroke'),
      strokeWidth: get('stroke-width'),
      fillOpacity: get('fill-opacity'),
      strokeOpacity: get('stroke-opacity'),
      filter: get('filter'),
      maskImage: maskValue,
      mixBlendMode: get('mix-blend-mode'),
      color: get('color'),
      backgroundColor: 'rgba(0, 0, 0, 0)',
      backgroundImage: 'none',
      getPropertyValue: (name: string) => (name === 'mask-image' ? maskValue : get(name)),
    } as unknown as CSSStyleDeclaration;
  };

  const env: SvgAnalysisEnvironment = {
    getStyle,
    backgroundCache: createBackgroundResolutionCache(),
    ensureId: (element) => {
      const existing = element.getAttribute('data-coloradapt-id');
      if (existing) return existing;
      nextId += 1;
      const id = `t-${nextId}`;
      element.setAttribute('data-coloradapt-id', id);
      return id;
    },
    ...(options.probe === false
      ? {}
      : {
          probe: <T>(css: string, read: () => T): T => {
            probes += 1;
            const ids = [...css.matchAll(/\[data-coloradapt-id="([^"]+)"\]/g)].map((m) => m[1]!);
            const touched: Element[] = [];
            for (const id of new Set(ids)) {
              const element = doc.querySelector(`[data-coloradapt-id="${id}"]`);
              if (!element) continue;
              // The first probe replaces fill, stroke and color; the second only color.
              overrides.set(
                element,
                css.includes('fill:')
                  ? {
                      fill: PROBE_COLORS.fill,
                      stroke: PROBE_COLORS.stroke,
                      color: PROBE_COLORS.color,
                    }
                  : { color: PROBE_COLORS.color },
              );
              touched.push(element);
            }
            try {
              return read();
            } finally {
              for (const element of touched) overrides.delete(element);
            }
          },
        }),
    ...(options.animated ? { animatedTargets: new Set(options.animated) } : {}),
  };

  return {
    env,
    getStyle,
    addRule: (selector, declarations) => rules.push({ selector, declarations }),
    get probes() {
      return probes;
    },
  };
}

/** Parses markup into `document.body` and returns it. */
export function mount(markup: string): HTMLElement {
  document.body.innerHTML = markup;
  return document.body;
}

/**
 * Makes `window.getComputedStyle` answer SVG elements from the fake engine (jsdom knows no SVG
 * inheritance), so the real StylesheetManager verifies against the same cascade the analyzer reads.
 * Returns the function that puts the real one back.
 */
export function installFakeComputedStyle(engine: FakeEngine): () => void {
  const original = window.getComputedStyle.bind(window);
  window.getComputedStyle = (element: Element, pseudo?: string | null) =>
    element.namespaceURI === 'http://www.w3.org/2000/svg'
      ? engine.getStyle(element)
      : original(element, pseudo);
  return () => {
    window.getComputedStyle = original;
  };
}
