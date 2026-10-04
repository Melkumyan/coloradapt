import {
  CHART_NODE_ATTRIBUTE,
  NO_PAINT,
  colorHex,
  isNeutral,
  normalizeDashArray,
  pathStats,
  pointsCount,
  type Box,
  type CanvasFacts,
  type ChartBlocker,
  type ChartFacts,
  type MarkFacts,
  type PaintFacts,
  type TextFacts,
} from '@core/charts';
import {
  classifyPaintServer,
  collectAnimatedPaintTargets,
  parseNumber,
  parsePaint,
} from '@core/svg';
import { CHART_LIMITS } from '@shared/constants';
import { hasHtmlLegend } from './html-legend';

/** What the chart layer needs from the browser: swappable in tests (jsdom has no layout). */
export interface ChartEnvironment {
  getStyle(element: Element): CSSStyleDeclaration;
  /** Box of `element` in pixels relative to `svg`'s top-left, or null when it is not laid out. */
  getBox(element: Element, svg: Element): Box | null;
  /** Bounding box in the element's own user space (where overlays are placed), or null. */
  getLocalBox(element: Element): Box | null;
  /** User units per CSS pixel where `element` is drawn (1 when unknown). */
  unitsPerPixel(element: Element): number;
  /** Elements a running animation drives a paint property on. */
  animatedTargets(): ReadonlySet<Element>;
  /** Box of `element` in viewport pixels (HTML legend guard); the browser default when absent. */
  getPageBox?(element: Element): Box | null;
  /** Computed style of a pseudo-element (`::before`), or null (HTML legend guard). */
  getPseudoStyle?(element: Element, pseudo: '::before' | '::after'): CSSStyleDeclaration | null;
}

export function defaultChartEnvironment(doc: Document): ChartEnvironment {
  const view = doc.defaultView;
  return {
    getStyle: (element) => (view ?? window).getComputedStyle(element),
    getBox(element, svg) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;
      const origin = svg.getBoundingClientRect();
      return { x: rect.x - origin.x, y: rect.y - origin.y, w: rect.width, h: rect.height };
    },
    getLocalBox(element) {
      const graphic = element as SVGGraphicsElement;
      if (typeof graphic.getBBox !== 'function') return null;
      try {
        const box = graphic.getBBox();
        return { x: box.x, y: box.y, w: box.width, h: box.height };
      } catch {
        return null;
      }
    },
    unitsPerPixel(element) {
      const graphic = element as SVGGraphicsElement;
      const matrix = typeof graphic.getScreenCTM === 'function' ? graphic.getScreenCTM() : null;
      if (!matrix) return 1;
      const scale = Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c));
      return scale > 0 && Number.isFinite(scale) ? 1 / scale : 1;
    },
    animatedTargets: () => collectAnimatedPaintTargets(doc),
    getPageBox(element) {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    },
    getPseudoStyle(element, pseudo) {
      try {
        return (view ?? window).getComputedStyle(element, pseudo);
      } catch {
        return null;
      }
    },
  };
}

const MARK_TAGS: ReadonlySet<string> = new Set([
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
]);

/** Subtrees that are never painted where they stand. */
const SKIPPED_TAGS: ReadonlySet<string> = new Set([
  'defs',
  'symbol',
  'clippath',
  'mask',
  'pattern',
  'marker',
  'lineargradient',
  'radialgradient',
  'filter',
  'style',
  'title',
  'desc',
  'metadata',
  'script',
  'use',
]);

const SMIL_TAGS: ReadonlySet<string> = new Set([
  'animate',
  'set',
  'animatecolor',
  'animatetransform',
  'animatemotion',
]);

const SERIES_ATTRIBUTES = [
  'data-series',
  'data-series-name',
  'data-series-id',
  'data-key',
  'data-name',
] as const;

export interface ReadChart {
  readonly facts: ChartFacts;
  /** Element by `order`, for marks and texts. */
  readonly nodes: ReadonlyMap<number, Element>;
}

function tokensOf(element: Element): string[] {
  return (element.getAttribute('class') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

function titleOf(element: Element): string | null {
  const aria = element.getAttribute('aria-label');
  if (aria?.trim()) return aria.trim();
  for (const child of element.children) {
    if (child.localName === 'title') {
      const text = child.textContent?.trim();
      if (text) return text.slice(0, 80);
    }
  }
  return null;
}

function readPaint(doc: Document, value: string, opacity: number): PaintFacts {
  const raw = parsePaint(value);
  switch (raw.kind) {
    case 'none':
      return NO_PAINT;
    case 'solid':
      return { kind: 'solid', color: raw.color, ref: null, opacity };
    case 'paint-server': {
      const kind = classifyPaintServer(doc, raw.reference);
      return {
        kind: kind === 'gradient' ? 'gradient' : kind === 'pattern' ? 'pattern' : 'other',
        color: null,
        ref: raw.reference,
        opacity,
      };
    }
    default:
      return { kind: 'other', color: null, ref: value.trim(), opacity };
  }
}

function markerReference(style: CSSStyleDeclaration): string | null {
  for (const property of ['marker-mid', 'marker-start', 'marker-end']) {
    const value = style.getPropertyValue(property).trim();
    if (value && value !== 'none') return value;
  }
  return null;
}

function geometry(
  element: Element,
  tag: string,
): { vertices: number; arcCount: number; closed: boolean; rectilinear: boolean } {
  switch (tag) {
    case 'path': {
      const stats = pathStats(element.getAttribute('d') ?? '');
      return stats;
    }
    case 'polyline':
    case 'polygon': {
      const vertices = pointsCount(element.getAttribute('points') ?? '');
      return { vertices, arcCount: 0, closed: tag === 'polygon', rectilinear: false };
    }
    case 'line':
      return { vertices: 2, arcCount: 0, closed: false, rectilinear: true };
    default:
      return { vertices: 1, arcCount: 0, closed: true, rectilinear: false };
  }
}

function seriesKey(element: Element): string | null {
  for (const name of SERIES_ATTRIBUTES) {
    const value = element.getAttribute(name)?.trim();
    if (value) return value.toLowerCase();
  }
  return null;
}

/** Product of `opacity` up the tree to the `<svg>` (a faded group fades what is in it). */
function groupOpacity(element: Element, svg: Element, env: ChartEnvironment): number {
  let opacity = 1;
  for (
    let node = element.parentElement;
    node && node !== svg.parentElement;
    node = node.parentElement
  ) {
    opacity *= parseNumber(env.getStyle(node).opacity, 1);
    if (node === svg) break;
  }
  return opacity;
}

/**
 * Reads one `<svg>` into plain {@link ChartFacts}. Call it with the page's own styles in
 * effect (the sheet suspended), or the paints it reads would be ColorAdapt's. Bounded: more than
 * `maxMarks` painted shapes, or `maxDescendants` elements, marks the facts `overBudget`.
 */
export function readChartFacts(svg: Element, env: ChartEnvironment): ReadChart {
  const doc = svg.ownerDocument;
  const marks: MarkFacts[] = [];
  const texts: TextFacts[] = [];
  const nodes = new Map<number, Element>();
  const blockers = new Set<ChartBlocker>();
  const animated = env.animatedTargets();
  let order = 0;
  let nextGroup = 1;
  let visited = 0;
  let overBudget = false;

  const rootRect = svg.getBoundingClientRect();
  const viewBox =
    svg
      .getAttribute('viewBox')
      ?.split(/[\s,]+/)
      .map(Number) ?? [];
  const width = rootRect.width || viewBox[2] || parseNumber(svg.getAttribute('width') ?? '', 0);
  const height = rootRect.height || viewBox[3] || parseNumber(svg.getAttribute('height') ?? '', 0);

  const visit = (element: Element, ancestry: readonly number[]): void => {
    if (overBudget) return;
    for (const child of element.children) {
      visited += 1;
      if (visited > CHART_LIMITS.maxDescendants) {
        overBudget = true;
        return;
      }
      if (child.hasAttribute(CHART_NODE_ATTRIBUTE)) continue;
      const tag = child.localName.toLowerCase();
      if (SMIL_TAGS.has(tag)) {
        blockers.add('animated');
        continue;
      }
      if (tag === 'foreignobject') {
        blockers.add('foreign-object');
        continue;
      }
      if (tag === 'image') {
        blockers.add('embedded-image');
        continue;
      }
      if (SKIPPED_TAGS.has(tag)) continue;

      const style = env.getStyle(child);
      if (style.display === 'none') continue;
      const filter = style.getPropertyValue('filter').trim();
      if (filter && filter !== 'none') blockers.add('filter');
      const mask =
        `${style.getPropertyValue('mask-image')} ${style.getPropertyValue('mask')}`.trim();
      if (mask && !/^(?:none\s*)*$/.test(mask)) blockers.add('mask');
      if (animated.has(child)) blockers.add('animated');

      if (MARK_TAGS.has(tag)) {
        if (style.visibility === 'hidden' || style.visibility === 'collapse') continue;
        const factor = groupOpacity(child, svg, env) * parseNumber(style.opacity, 1);
        // A `<line>` has no area: its computed `fill` (black by default) paints nothing.
        const fill =
          tag === 'line'
            ? NO_PAINT
            : readPaint(doc, style.fill, parseNumber(style.fillOpacity, 1) * factor);
        const stroke = readPaint(doc, style.stroke, parseNumber(style.strokeOpacity, 1) * factor);
        const shape = geometry(child, tag);
        // Exactly `maxMarks` shapes and texts fit; the next one is over the budget.
        if (marks.length + texts.length >= CHART_LIMITS.maxMarks) {
          overBudget = true;
          return;
        }
        const mark: MarkFacts = {
          order,
          tag,
          ancestry,
          fill,
          stroke,
          strokeWidth: parseNumber(style.strokeWidth, 1),
          dash: normalizeDashArray(style.getPropertyValue('stroke-dasharray')),
          markerRef: markerReference(style),
          ...shape,
          box: env.getBox(child, svg),
          classTokens: tokensOf(child),
          dataSeries: seriesKey(child),
          label: titleOf(child),
        };
        marks.push(mark);
        nodes.set(order, child);
        order += 1;
        continue;
      }
      if (tag === 'text') {
        if (marks.length + texts.length >= CHART_LIMITS.maxMarks) {
          overBudget = true;
          return;
        }
        const text = (child.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
        const fill = readPaint(doc, style.fill, 1);
        texts.push({
          order,
          ancestry,
          text,
          color: fill.kind === 'solid' ? fill.color : null,
          box: env.getBox(child, svg),
          classTokens: tokensOf(child),
        });
        nodes.set(order, child);
        order += 1;
        continue;
      }
      // Containers (g, a, svg, switch) and anything else: look inside.
      const id = nextGroup;
      nextGroup += 1;
      visit(child, [id, ...ancestry].slice(0, 3));
      if (overBudget) return;
    }
  };
  // The <svg> itself can carry the filter, the mask or the animation.
  const rootStyle = env.getStyle(svg);
  const rootFilter = rootStyle.getPropertyValue('filter').trim();
  if (rootFilter && rootFilter !== 'none') blockers.add('filter');
  const rootMask =
    `${rootStyle.getPropertyValue('mask-image')} ${rootStyle.getPropertyValue('mask')}`.trim();
  if (rootMask && !/^(?:none\s*)*$/.test(rootMask)) blockers.add('mask');
  if (animated.has(svg)) blockers.add('animated');
  visit(svg, [0]);

  const hints: string[] = [];
  for (
    let node: Element | null = svg, depth = 0;
    node && depth < 3;
    node = node.parentElement, depth += 1
  ) {
    hints.push(
      (node.getAttribute('class') ?? '').toLowerCase(),
      node.id.toLowerCase(),
      (node.getAttribute('role') ?? '').toLowerCase(),
      (node.getAttribute('aria-label') ?? '').toLowerCase(),
      ...node
        .getAttributeNames()
        .filter((name) => name.startsWith('data-') && !name.startsWith('data-coloradapt')),
    );
  }
  const cleanHints = hints.filter((hint) => hint !== '');

  // Only a chart that could be adapted needs to know about an HTML legend: two distinct colored paints,
  // and something laid out. Monochrome icons and hidden SVGs never pay for the neighbourhood scan.
  const paints = new Set<string>();
  for (const mark of marks) {
    for (const paint of [mark.stroke, mark.fill]) {
      if (paint.kind === 'solid' && paint.color && !isNeutral(paint.color))
        paints.add(colorHex(paint.color));
    }
    if (paints.size >= 2) break;
  }
  const paintKeys = new Set<string>();
  for (const mark of marks) {
    for (const paint of [mark.stroke, mark.fill]) {
      if (paint.kind === 'solid' && paint.color && !isNeutral(paint.color)) {
        const { r, g, b } = paint.color;
        paintKeys.add(`${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)}`);
      }
    }
  }
  if (
    paints.size >= 2 &&
    marks.some((mark) => mark.box !== null) &&
    hasHtmlLegend(svg, env, paintKeys)
  ) {
    blockers.add('html-legend');
  }

  return {
    facts: {
      marks,
      texts,
      width,
      height,
      hints: cleanHints,
      label: titleOf(svg),
      blockers: [...blockers],
      overBudget,
    },
    nodes,
  };
}

/** What `<canvas>` classification reads: names near the element, never its pixels. */
export function readCanvasFacts(canvas: Element): CanvasFacts {
  const hints: string[] = [];
  for (
    let node: Element | null = canvas, depth = 0;
    node && depth < 3;
    node = node.parentElement, depth += 1
  ) {
    hints.push(
      (node.getAttribute('class') ?? '').toLowerCase(),
      node.id.toLowerCase(),
      (node.getAttribute('role') ?? '').toLowerCase(),
      (node.getAttribute('aria-label') ?? '').toLowerCase(),
      ...node
        .getAttributeNames()
        .filter((name) => name.startsWith('data-') && !name.startsWith('data-coloradapt')),
    );
  }
  const width = Number.parseFloat(canvas.getAttribute('width') ?? '') || 0;
  const height = Number.parseFloat(canvas.getAttribute('height') ?? '') || 0;
  return { hints: hints.filter((hint) => hint !== ''), width, height };
}
