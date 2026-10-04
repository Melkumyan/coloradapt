import { parseColor } from '@core/color';
import type { Box } from '@core/charts';
import type { ChartEnvironment } from '@features/charts';

/**
 * A miniature CSS engine and layout for SVG charts, enough to give the chart layer the inputs a
 * browser would (jsdom has neither SVG inheritance nor layout). Real-browser behavior is covered
 * in e2e/chart-*.spec.ts; this exists to test the controller's logic: ownership, reversibility,
 * idempotency, retention, verification and rollback.
 *
 *  - declarations: presentation attributes < author `<style>` rules (by importance, specificity,
 *    order; ColorAdapt's own sheet is just the last author sheet) < inline style;
 *  - `fill`, `stroke`, `stroke-width`, `stroke-dasharray`, `marker-*`, opacities and visibility inherit;
 *  - boxes come from `data-box="x,y,w,h"` (pixels in the chart), local boxes from `data-lbox`
 *    (falling back to `data-box`).
 */
const INHERITED = new Set([
  'fill',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'marker-start',
  'marker-mid',
  'marker-end',
  'fill-opacity',
  'stroke-opacity',
  'visibility',
]);

const PRESENTATION = [
  'fill',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'marker-start',
  'marker-mid',
  'marker-end',
  'fill-opacity',
  'stroke-opacity',
  'opacity',
  'display',
  'visibility',
  'filter',
  'mask',
  'clip-path',
];

const DEFAULTS: Record<string, string> = {
  fill: 'rgb(0, 0, 0)',
  stroke: 'none',
  'stroke-width': '1px',
  'stroke-dasharray': 'none',
  'marker-start': 'none',
  'marker-mid': 'none',
  'marker-end': 'none',
  'fill-opacity': '1',
  'stroke-opacity': '1',
  opacity: '1',
  display: 'inline',
  visibility: 'visible',
  filter: 'none',
  mask: 'none',
  'clip-path': 'none',
  'mask-image': 'none',
  'background-color': 'rgba(0, 0, 0, 0)',
};

function rgb(value: string): string {
  const color = parseColor(value);
  if (!color) return value;
  const byte = (n: number) => Math.round(n * 255);
  return color.alpha < 1
    ? `rgba(${byte(color.r)}, ${byte(color.g)}, ${byte(color.b)}, ${color.alpha})`
    : `rgb(${byte(color.r)}, ${byte(color.g)}, ${byte(color.b)})`;
}

function normalize(property: string, value: string): string {
  const text = value.trim();
  if (property === 'fill' || property === 'stroke') {
    const url = /^url\(\s*["']?(#[^)"'\s]+)["']?\s*\)/.exec(text);
    if (url) return `url("${url[1]}")`;
    if (text === 'none' || text.startsWith('context-')) return text;
    return rgb(text);
  }
  if (property.startsWith('marker-')) {
    const url = /^url\(\s*["']?(#[^)"'\s]+)["']?\s*\)/.exec(text);
    return url ? `url("${url[1]}")` : text;
  }
  if (property === 'stroke-dasharray' && text !== 'none') {
    return text
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((n) => `${Number.parseFloat(n)}px`)
      .join(', ');
  }
  if (property === 'stroke-width' && /^[\d.]+$/.test(text)) return `${text}px`;
  return text;
}

function specificity(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:not\(/g) ?? []).length;
  const tags = (
    selector.replace(/\[[^\]]*\]|[.#][\w-]+/g, ' ').match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []
  ).length;
  return ids * 10000 + classes * 100 + tags;
}

interface Rule {
  readonly selector: string;
  readonly spec: number;
  readonly order: number;
  readonly declarations: ReadonlyArray<readonly [string, string, boolean]>;
}

function parseSheet(text: string, startOrder: number): Rule[] {
  const rules: Rule[] = [];
  let order = startOrder;
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations: Array<readonly [string, string, boolean]> = [];
    for (const part of (match[2] ?? '').split(';')) {
      const colon = part.indexOf(':');
      if (colon <= 0) continue;
      const name = part.slice(0, colon).trim().toLowerCase();
      let value = part.slice(colon + 1).trim();
      const important = /!important$/i.test(value);
      if (important) value = value.replace(/\s*!important$/i, '').trim();
      declarations.push([name, value, important]);
    }
    for (const selector of (match[1] ?? '').split(',')) {
      const trimmed = selector.trim();
      if (trimmed)
        rules.push({ selector: trimmed, spec: specificity(trimmed), order: order++, declarations });
    }
  }
  return rules;
}

function parseBox(value: string | null): Box | null {
  if (!value) return null;
  const [x, y, w, h] = value.split(',').map(Number);
  return [x, y, w, h].every((n) => Number.isFinite(n)) ? { x: x!, y: y!, w: w!, h: h! } : null;
}

export function createChartEnvironment(
  doc: Document,
): ChartEnvironment & { readonly styleReads: () => number } {
  let reads = 0;

  function declared(element: Element): Map<string, { value: string; weight: number }> {
    const out = new Map<string, { value: string; weight: number }>();
    const set = (name: string, value: string, important: boolean, spec: number, order: number) => {
      const weight = (important ? 1e9 : 0) + spec * 1000 + order;
      const before = out.get(name);
      if (!before || weight >= before.weight) out.set(name, { value, weight });
    };
    for (const name of PRESENTATION) {
      const value = element.getAttribute(name);
      if (value !== null) set(name, value, false, 0, 0);
    }
    let order = 1;
    for (const sheet of doc.querySelectorAll('style')) {
      for (const rule of parseSheet(sheet.textContent ?? '', order)) {
        order = Math.max(order, rule.order + 1);
        let matches = false;
        try {
          matches = element.matches(rule.selector);
        } catch {
          matches = false;
        }
        if (!matches) continue;
        for (const [name, value, important] of rule.declarations)
          set(name, value, important, rule.spec, rule.order);
      }
    }
    for (const part of (element.getAttribute('style') ?? '').split(';')) {
      const colon = part.indexOf(':');
      if (colon <= 0) continue;
      const name = part.slice(0, colon).trim();
      let value = part.slice(colon + 1).trim();
      const important = /!important$/i.test(value);
      if (important) value = value.replace(/\s*!important$/i, '').trim();
      set(name, value, important, 99999, 1e6);
    }
    return out;
  }

  function compute(element: Element, property: string): string {
    const own = declared(element).get(property)?.value;
    if (own !== undefined && own !== 'inherit') return normalize(property, own);
    const parent = element.parentElement;
    if (parent && (own === 'inherit' || INHERITED.has(property))) return compute(parent, property);
    return DEFAULTS[property] ?? '';
  }

  const camel = (name: string) => name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

  return {
    styleReads: () => reads,
    getStyle(element) {
      reads += 1;
      const lookup = (name: string) => compute(element, name);
      return new Proxy({} as CSSStyleDeclaration, {
        get(_target, key) {
          if (key === 'getPropertyValue') return (name: string) => lookup(name);
          if (typeof key !== 'string') return undefined;
          const known = [...PRESENTATION, 'mask-image', 'background-color'].find(
            (name) => camel(name) === key,
          );
          return known ? lookup(known) : '';
        },
      });
    },
    getBox: (element) => parseBox(element.getAttribute('data-box')),
    getLocalBox: (element) =>
      parseBox(element.getAttribute('data-lbox') ?? element.getAttribute('data-box')),
    unitsPerPixel: () => 1,
    animatedTargets: () => new Set(),
    getPageBox: (element) => parseBox(element.getAttribute('data-box')),
    // `data-before="content:'';background-color:#f00;width:10px;height:10px"` stands in for a ::before rule.
    getPseudoStyle(element, pseudo) {
      const spec = element.getAttribute(pseudo === '::before' ? 'data-before' : 'data-after');
      if (!spec) return null;
      const declared = new Map<string, string>();
      for (const part of spec.split(';')) {
        const colon = part.indexOf(':');
        if (colon > 0) declared.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
      }
      return new Proxy({} as CSSStyleDeclaration, {
        get: (_target, key) =>
          key === 'getPropertyValue' ? (name: string) => declared.get(name) ?? '' : '',
      });
    },
  };
}

// ----------------------------------------------------------------------- markup

const box = (x: number, y: number, w: number, h: number) => `data-box="${x},${y},${w},${h}"`;

export interface ChartMarkupOptions {
  readonly id?: string;
  readonly legend?: boolean;
  readonly keys?: boolean;
  readonly dashes?: ReadonlyArray<string | null>;
  readonly labels?: readonly string[];
  readonly extraSeries?: boolean;
  /** Legend swatches: line samples (default) or small boxes. */
  readonly legendKind?: 'line' | 'box';
}

/** An inline-SVG line chart: axes, ticks, labels, one path per color, a D3-style legend. */
export function lineChartSvg(colors: readonly string[], options: ChartMarkupOptions = {}): string {
  const id = options.id ?? 'chart';
  const axis = [0, 1, 2, 3, 4]
    .map(
      (i) =>
        `<g class="tick"><line x1="${40 + i * 80}" y1="260" x2="${40 + i * 80}" y2="265" stroke="#888" ${box(40 + i * 80, 260, 0, 5)}></line><text x="${40 + i * 80}" y="278" fill="#222" ${box(36 + i * 80, 270, 10, 10)}>${i * 10}</text></g>`,
    )
    .join('');
  const lines = colors
    .map((color, i) => {
      const dash = options.dashes?.[i];
      const key = options.keys ? ` data-series="s${i}"` : '';
      return `<path class="line line-${i}"${key} fill="none" stroke="${color}" stroke-width="2"${dash ? ` stroke-dasharray="${dash}"` : ''} d="M60 ${100 + i * 10} L100 ${120 + i * 5} L140 ${90 + i * 8} L180 ${130 - i * 4} L220 ${80 + i * 12} L260 ${110 + i * 3}" ${box(60, 80 + i * 10, 200, 60)}></path>`;
    })
    .join('');
  const legend =
    options.legend === false
      ? ''
      : `<g class="legend">${colors
          .map((color, i) => {
            const y = 10 + i * 16;
            const key = options.keys ? ` data-series="s${i}"` : '';
            const dash = options.dashes?.[i];
            if (options.legendKind === 'box') {
              return `<g class="legend-item"><rect${key} class="swatch" x="300" y="${y}" width="10" height="10" fill="${color}" ${box(300, y, 10, 10)}></rect><text x="325" y="${y + 10}" fill="#222" ${box(325, y, 50, 10)}>${options.labels?.[i] ?? `Series ${i + 1}`}</text></g>`;
            }
            return `<g class="legend-item"><line${key} class="swatch" x1="300" y1="${y + 5}" x2="320" y2="${y + 5}" stroke="${color}" stroke-width="2"${dash ? ` stroke-dasharray="${dash}"` : ''} ${box(300, y + 5, 20, 0)}></line><text x="325" y="${y + 10}" fill="#222" ${box(325, y, 50, 10)}>${options.labels?.[i] ?? `Series ${i + 1}`}</text></g>`;
          })
          .join('')}</g>`;
  return `<svg id="${id}" class="line-chart" viewBox="0 0 400 300" width="400" height="300"><path class="domain" d="M40 260 H380" stroke="#888" fill="none" ${box(40, 260, 340, 0)}></path>${axis}${lines}${legend}</svg>`;
}

/** Grouped bars: one rect per series per category, legend of box swatches. */
export function barChartSvg(colors: readonly string[], options: ChartMarkupOptions = {}): string {
  const id = options.id ?? 'chart';
  const axis = [0, 1, 2, 3, 4]
    .map(
      (i) =>
        `<line x1="${40 + i * 80}" y1="260" x2="${40 + i * 80}" y2="265" stroke="#888" ${box(40 + i * 80, 260, 0, 5)}></line><text x="${40 + i * 80}" y="278" fill="#222" ${box(36 + i * 80, 270, 10, 10)}>${i * 10}</text>`,
    )
    .join('');
  let bars = '';
  for (let category = 0; category < 3; category += 1) {
    colors.forEach((color, i) => {
      const h = 60 + ((category * 37 + i * 23) % 90);
      bars += `<rect class="bar" fill="${color}" x="${60 + category * 100 + i * 22}" y="${260 - h}" width="20" height="${h}" ${box(60 + category * 100 + i * 22, 260 - h, 20, h)}></rect>`;
    });
  }
  const legend =
    options.legend === false
      ? ''
      : `<g class="legend">${colors
          .map((color, i) => {
            const y = 10 + i * 16;
            return `<g class="legend-item"><rect class="swatch" x="300" y="${y}" width="10" height="10" fill="${color}" ${box(300, y, 10, 10)}></rect><text x="325" y="${y + 10}" fill="#222" ${box(325, y, 50, 10)}>Bar ${i + 1}</text></g>`;
          })
          .join('')}</g>`;
  return `<svg id="${id}" class="bar-chart" viewBox="0 0 400 300" width="400" height="300"><path class="domain" d="M40 260 H380" stroke="#888" fill="none" ${box(40, 260, 340, 0)}></path>${axis}${bars}${legend}</svg>`;
}

/** Scatter: 8 circles per color, circle legend. */
export function scatterChartSvg(
  colors: readonly string[],
  options: ChartMarkupOptions = {},
): string {
  const id = options.id ?? 'chart';
  const axis = [0, 1, 2, 3, 4]
    .map(
      (i) =>
        `<line x1="${40 + i * 80}" y1="260" x2="${40 + i * 80}" y2="265" stroke="#888" ${box(40 + i * 80, 260, 0, 5)}></line><text x="${40 + i * 80}" y="278" fill="#222" ${box(36 + i * 80, 270, 10, 10)}>${i * 10}</text>`,
    )
    .join('');
  let points = '';
  colors.forEach((color, i) => {
    for (let n = 0; n < 8; n += 1) {
      const cx = 60 + n * 38 + i * 5;
      const cy = 80 + ((n * 53 + i * 31) % 150);
      points += `<circle class="dot dot-${i}" cx="${cx}" cy="${cy}" r="4" fill="${color}" ${box(cx - 4, cy - 4, 8, 8)}></circle>`;
    }
  });
  const legend =
    options.legend === false
      ? ''
      : `<g class="legend">${colors
          .map((color, i) => {
            const y = 10 + i * 16;
            return `<g class="legend-item"><circle class="swatch" cx="305" cy="${y + 5}" r="5" fill="${color}" ${box(300, y, 10, 10)}></circle><text x="325" y="${y + 10}" fill="#222" ${box(325, y, 50, 10)}>Group ${i + 1}</text></g>`;
          })
          .join('')}</g>`;
  return `<svg id="${id}" class="scatter" viewBox="0 0 400 300" width="400" height="300"><path class="domain" d="M40 260 H380" stroke="#888" fill="none" ${box(40, 260, 340, 0)}></path>${axis}${points}${legend}</svg>`;
}

/** Pie: wedges (arc paths) in a 200x200 circle, box legend. */
export function pieChartSvg(colors: readonly string[], options: ChartMarkupOptions = {}): string {
  const id = options.id ?? 'chart';
  const slices = colors
    .map(
      (color, i) =>
        `<path class="slice" fill="${color}" d="M150 150 L150 50 A100 100 0 0 1 ${200 + i} ${60 + i} Z" ${box(50, 50, 200, 200)}></path>`,
    )
    .join('');
  const legend =
    options.legend === false
      ? ''
      : `<g class="legend">${colors
          .map((color, i) => {
            const y = 10 + i * 16;
            return `<g class="legend-item"><rect class="swatch" x="300" y="${y}" width="10" height="10" fill="${color}" ${box(300, y, 10, 10)}></rect><text x="325" y="${y + 10}" fill="#222" ${box(325, y, 50, 10)}>Slice ${i + 1}</text></g>`;
          })
          .join('')}</g>`;
  return `<svg id="${id}" class="pie" viewBox="0 0 400 300" width="400" height="300">${slices}${legend}</svg>`;
}

// ------------------------------------------------- charts of other types, and things that are not charts

const axisMarkup = () =>
  `<path class="domain" d="M40 260 H380" stroke="#888" fill="none" ${box(40, 260, 340, 0)}></path>` +
  [0, 1, 2, 3, 4]
    .map(
      (i) =>
        `<line x1="${40 + i * 80}" y1="260" x2="${40 + i * 80}" y2="265" stroke="#888" ${box(40 + i * 80, 260, 0, 5)}></line><text x="${40 + i * 80}" y="278" fill="#222" ${box(36 + i * 80, 270, 10, 10)}>${i * 10}</text>`,
    )
    .join('');

const legendBoxes = (colors: readonly string[]) =>
  `<g class="legend">${colors
    .map((color, i) => {
      const y = 10 + i * 16;
      return `<g class="legend-item"><rect class="swatch" x="300" y="${y}" width="10" height="10" fill="${color}" ${box(300, y, 10, 10)}></rect><text x="325" y="${y + 10}" fill="#222" ${box(325, y, 50, 10)}>S${i + 1}</text></g>`;
    })
    .join('')}</g>`;

/** Sequential heatmap: 6x6 cells of one hue. */
export function heatmapSvg(id = 'chart'): string {
  let cells = '';
  for (let r = 0; r < 6; r += 1) {
    for (let c = 0; c < 6; c += 1) {
      const shade = Math.round(235 - ((r * 6 + c) / 35) * 170);
      cells += `<rect class="cell" x="${50 + c * 40}" y="${26 + r * 38}" width="38" height="36" fill="rgb(${shade}, ${shade + 10}, 255)" ${box(50 + c * 40, 26 + r * 38, 38, 36)}></rect>`;
    }
  }
  return `<svg id="${id}" class="heatmap" viewBox="0 0 400 300" width="400" height="300">${axisMarkup()}${cells}</svg>`;
}

/** Areas: closed polygons over the axes. */
export function areaChartSvg(colors: readonly string[], id = 'chart'): string {
  const areas = colors
    .map((color, i) => {
      const pts = Array.from(
        { length: 6 },
        (_, k) => `${60 + k * 55} ${220 - i * 25 - ((k * 31 + i * 17) % 60)}`,
      );
      return `<path class="area" fill="${color}" fill-opacity="0.6" d="M60 260 L${pts.join(' L')} L335 260 Z" ${box(60, 130 - i * 25, 275, 130 + i * 25)}></path>`;
    })
    .join('');
  return `<svg id="${id}" class="area-chart" viewBox="0 0 400 300" width="400" height="300">${axisMarkup()}${areas}${legendBoxes(colors)}</svg>`;
}

/** Stacked bars: each column holds one rect per series. */
export function stackedBarSvg(colors: readonly string[], id = 'chart'): string {
  let bars = '';
  for (let c = 0; c < 4; c += 1) {
    let top = 260;
    colors.forEach((color, i) => {
      const h = 30 + ((c * 17 + i * 29) % 50);
      top -= h;
      bars += `<rect class="bar" fill="${color}" x="${60 + c * 80}" y="${top}" width="60" height="${h}" ${box(60 + c * 80, top, 60, h)}></rect>`;
    });
  }
  return `<svg id="${id}" class="stacked-bar" viewBox="0 0 400 300" width="400" height="300">${axisMarkup()}${bars}${legendBoxes(colors)}</svg>`;
}

export function logoSvg(id = 'logo'): string {
  const wedge = (fill: string, d: string) =>
    `<path fill="${fill}" d="${d}" data-box="10,10,80,80"></path>`;
  return `<svg id="${id}" viewBox="0 0 100 100" width="96" height="96">${wedge('#e63946', 'M50 50 L90 50 A40 40 0 0 1 50 90 Z')}${wedge('#457b9d', 'M50 50 L50 90 A40 40 0 0 1 10 50 Z')}${wedge('#1d3557', 'M50 50 L10 50 A40 40 0 0 1 50 10 Z')}${wedge('#ffb703', 'M50 50 L50 10 A40 40 0 0 1 90 50 Z')}</svg>`;
}

export function mapSvg(id = 'map'): string {
  const palette = ['#e63946', '#f1faee', '#a8dadc', '#457b9d', '#1d3557', '#ffb703', '#fb8500'];
  let paths = '';
  for (let i = 0; i < 36; i += 1) {
    const x = (i % 6) * 60 + 20;
    const y = Math.floor(i / 6) * 40 + 14;
    paths += `<path fill="${palette[i % palette.length]}" stroke="#fff" d="M${x} ${y} l44 3 l4 30 l-44 4 z" ${box(x, y, 48, 37)}></path>`;
  }
  return `<svg id="${id}" viewBox="0 0 400 300" width="400" height="300">${paths}<text x="30" y="30" ${box(30, 20, 30, 10)}>North</text><text x="300" y="250" ${box(300, 240, 30, 10)}>South</text><text x="200" y="140" ${box(200, 130, 40, 10)}>Central</text></svg>`;
}

export function diagramSvg(id = 'diagram'): string {
  const colors = ['#e63946', '#457b9d', '#2a9d8f', '#e9c46a', '#f4a261', '#264653'];
  const nodes = colors
    .map((color, i) => {
      const x = 20 + i * 62;
      const y = 30 + (i % 3) * 70;
      const w = 50 + (i % 2) * 8;
      const h = 36 + (i % 3) * 6;
      return `<rect fill="${color}" x="${x}" y="${y}" width="${w}" height="${h}" ${box(x, y, w, h)}></rect><text x="${x + 4}" y="${y + 20}" fill="#fff" ${box(x + 4, y + 10, 30, 10)}>Step ${i}</text>`;
    })
    .join('');
  const edges = [0, 1, 2, 3, 4]
    .map(
      (i) =>
        `<path fill="none" stroke="#555" d="M${70 + i * 62} 50 H${80 + i * 62} V${110 + (i % 2) * 20}" ${box(70 + i * 62, 50, 10, 70)}></path>`,
    )
    .join('');
  return `<svg id="${id}" viewBox="0 0 400 300" width="400" height="300">${nodes}${edges}</svg>`;
}

export function iconSvg(id = 'icon'): string {
  const paths = [0, 1, 2, 3, 4, 5]
    .map((i) => `<path fill="#333" d="M${i} ${i} h8 v8 h-8 z" ${box(i, i, 8, 8)}></path>`)
    .join('');
  return `<svg id="${id}" viewBox="0 0 24 24" width="24" height="24">${paths}</svg>`;
}
