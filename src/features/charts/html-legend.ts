import { parseColor } from '@core/color';
import { isNeutral } from '@core/charts';
import { CHART_LIMITS } from '@shared/constants';
import type { ChartEnvironment } from './chart-facts';

/**
 * The HTML legend guard (docs/CHARTS.md, "HTML legend guard").
 *
 * M7 synchronizes a chart with the legend drawn *inside* its `<svg>`. A legend in HTML cannot be
 * re-skinned without editing the page's DOM or CSS, so a chart with one must not be adapted: marks
 * with a dash or a pattern next to a legend that still shows plain colors is the one state this layer
 * must never create. The guard therefore errs towards refusing: it answers "is there evidence of an
 * HTML legend near this chart?" from structure only (never from nearby prose), and any evidence is
 * enough. The reverse error (a refused chart that had no legend) costs a missing redundancy cue;
 * the forward error (an adapted chart with a stale legend) costs a wrong one.
 *
 * Evidence, per element near the chart (the parent and the grandparent of the `<svg>`, or the
 * siblings of a chart that sits directly in `<body>`; at most {@link CHART_LIMITS.maxLegendScan}
 * elements):
 *
 *  - a name: `legend`, `swatch`, `keyline`, or a `key`/`series` class token, in class, id, role or
 *    aria-label (`key-metric`, `monkey` and `keyboard` are not names);
 *  - a swatch: a small box with its own background, a thin colored rule, a bordered mark, a small
 *    inline `<svg>`, a `::before`/`::after` box or bullet, a colored glyph bullet (a bullet, a square, a
 *    colored emoji square) - two or more of them with distinct colors;
 *  - a control that points at the chart (`aria-controls` naming the chart or an ancestor), two or more;
 *  - toggle buttons (`aria-pressed`/`aria-checked`/`aria-selected`) carrying distinct colors;
 *  - checkboxes/radios with an explicit `accent-color`, distinct;
 *  - an `aria-describedby`/`aria-labelledby`/`aria-owns` on the chart naming an element outside it
 *    that is itself a legend by any of the above.
 */

/** Names of legends. Substring match: `chart-legend`, `legendItem`, `swatches`, `keyline`. */
const LEGEND_NAME = /legend|swatch|keyline/;
/** `key` and `series` only as a whole class token or the last part of one (`chart-key`, `series`). */
const KEY_TOKEN = /^(?:[a-z0-9]+[-_])?(?:key|series)$/;
/** A bullet or a square used as a swatch glyph, or a colored emoji square/circle. */
const GLYPH = /^[\s]*[•■-◿⬛⬜⬤●━─—―\u{1F534}-\u{1F535}\u{1F7E0}-\u{1F7EB}]/u;

const SMALL_MIN = 4;
const SMALL_MAX = 24;
/** A legend sample can be a short rule: this wide, this thick. */
const RULE_MIN = 8;
const RULE_MAX = 48;
const RULE_THICK = 6;

function nameOf(element: Element): string {
  return [
    element.getAttribute('class') ?? '',
    element.id,
    element.getAttribute('role') ?? '',
    element.getAttribute('aria-label') ?? '',
  ]
    .join(' ')
    .toLowerCase();
}

function hasLegendName(element: Element): boolean {
  const name = nameOf(element);
  if (LEGEND_NAME.test(name)) return true;
  return (element.getAttribute('class') ?? '')
    .toLowerCase()
    .split(/\s+/)
    .some((token) => KEY_TOKEN.test(token));
}

function colorKey(value: string): string | null {
  const color = parseColor(value);
  if (!color || color.alpha < 0.5) return null;
  return `${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)}`;
}

/** Like {@link colorKey}, but a gray (or black, white) is no evidence of a series color. */
function chromaKey(value: string): string | null {
  const color = parseColor(value);
  if (!color || color.alpha < 0.5 || isNeutral(color)) return null;
  return colorKey(value);
}

function pixels(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/** Elements the walk looks at: the scopes around the chart. */
function scopesAround(svg: Element): Element[] {
  const doc = svg.ownerDocument;
  const scopes: Element[] = [];
  for (
    let node = svg.parentElement, depth = 0;
    node && depth < 2;
    node = node.parentElement, depth += 1
  ) {
    if (node === doc.body || node === doc.documentElement) break;
    scopes.push(node);
  }
  return scopes;
}

/** The siblings of a chart that sits directly in `<body>` (its parent is too wide to scan). */
function bodySiblings(svg: Element): Element[] {
  const parent = svg.parentElement;
  const doc = svg.ownerDocument;
  if (!parent || (parent !== doc.body && parent !== doc.documentElement)) return [];
  return [...parent.children].filter((child) => child !== svg && child.localName !== 'script');
}

interface Tally {
  /** Distinct swatch-like colors of one kind. */
  readonly background: Set<string>;
  readonly rule: Set<string>;
  readonly border: Set<string>;
  readonly pseudo: Set<string>;
  readonly glyph: Set<string>;
  readonly toggle: Set<string>;
  readonly accent: Set<string>;
  /** Series colors that small labels, swatches or borders next to the chart wear exactly. */
  readonly matched: Set<string>;
  smallSvgs: number;
  controls: number;
}

function emptyTally(): Tally {
  return {
    background: new Set(),
    rule: new Set(),
    border: new Set(),
    pseudo: new Set(),
    glyph: new Set(),
    toggle: new Set(),
    accent: new Set(),
    matched: new Set(),
    smallSvgs: 0,
    controls: 0,
  };
}

function distinct(tally: Tally): boolean {
  return (
    tally.background.size >= 2 ||
    tally.rule.size >= 2 ||
    tally.border.size >= 2 ||
    tally.pseudo.size >= 2 ||
    tally.glyph.size >= 2 ||
    tally.toggle.size >= 2 ||
    tally.accent.size >= 2 ||
    tally.matched.size >= 2 ||
    tally.smallSvgs >= 2 ||
    tally.controls >= 2
  );
}

function pageBox(env: ChartEnvironment, element: Element) {
  if (env.getPageBox) return env.getPageBox(element);
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
}

/** Looks at one element; returns true when it is a legend by name. */
function inspect(
  element: Element,
  svg: Element,
  env: ChartEnvironment,
  tally: Tally,
  paints: ReadonlySet<string>,
): boolean {
  if (hasLegendName(element)) return true;

  const chartIds = new Set<string>();
  for (let node: Element | null = svg; node && chartIds.size < 4; node = node.parentElement) {
    if (node.id) chartIds.add(node.id);
  }
  const controls = element.getAttribute('aria-controls');
  if (controls?.split(/\s+/).some((id) => chartIds.has(id))) tally.controls += 1;

  const box = pageBox(env, element);
  const style = env.getStyle(element);
  if (style.getPropertyValue('display') === 'none') return false;

  // A small inline <svg> next to the chart is a swatch as often as an icon: two of them are a legend.
  if (element.localName === 'svg') {
    if (box && box.w >= SMALL_MIN && box.w <= SMALL_MAX && box.h >= SMALL_MIN && box.h <= SMALL_MAX)
      tally.smallSvgs += 1;
    return false;
  }

  const background = colorKey(style.getPropertyValue('background-color'));
  if (background && box) {
    const small =
      box.w >= SMALL_MIN && box.w <= SMALL_MAX && box.h >= SMALL_MIN && box.h <= SMALL_MAX;
    const rule = box.w >= RULE_MIN && box.w <= RULE_MAX && box.h >= 1 && box.h <= RULE_THICK;
    if (small && element.children.length === 0) tally.background.add(background);
    else if (rule && element.children.length === 0) tally.rule.add(background);
  }

  // A colored rule on one side (border-left legends, a border-top line sample).
  if (box && box.h <= 64) {
    for (const side of ['Left', 'Top', 'Bottom'] as const) {
      const width = pixels(style.getPropertyValue(`border-${side.toLowerCase()}-width`));
      const kind = style.getPropertyValue(`border-${side.toLowerCase()}-style`);
      if (width < 2 || width > 12 || kind === 'none' || kind === 'hidden') continue;
      const key = chromaKey(style.getPropertyValue(`border-${side.toLowerCase()}-color`));
      if (key) tally.border.add(key);
    }
  }

  // ::before / ::after boxes and bullets.
  if (env.getPseudoStyle && element.children.length <= 2) {
    for (const pseudo of ['::before', '::after'] as const) {
      const after = env.getPseudoStyle(element, pseudo);
      if (!after) continue;
      const content = after.getPropertyValue('content').trim();
      if (!content || content === 'none' || content === 'normal') continue;
      if (after.getPropertyValue('display') === 'none') continue;
      const fill = colorKey(after.getPropertyValue('background-color'));
      const w = pixels(after.getPropertyValue('width'));
      const h = pixels(after.getPropertyValue('height'));
      if (fill && w >= 2 && w <= RULE_MAX && h >= 1 && h <= SMALL_MAX) {
        tally.pseudo.add(fill);
        continue;
      }
      // A glyph bullet in `content` ("\25CF"), colored by `color`.
      const text = content.replace(/^["']|["']$/g, '');
      const ink = chromaKey(after.getPropertyValue('color'));
      if (GLYPH.test(text) && ink) tally.glyph.add(ink);
    }
  }

  // A bullet glyph in the element's own text, or an element that is only a glyph.
  const own = [...element.childNodes]
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent ?? '')
    .join('');
  if (own && GLYPH.test(own)) {
    const ink = chromaKey(style.getPropertyValue('color'));
    const glyph = own.trim().slice(0, 2);
    if (ink) tally.glyph.add(ink);
    else if (/[\u{1F534}\u{1F535}\u{1F7E0}-\u{1F7EB}]/u.test(glyph)) tally.glyph.add(glyph);
  }

  // A label, swatch or rule wearing exactly a series color (text-colored legends have no swatch at all).
  if (paints.size > 0 && element.children.length <= 3) {
    const labelled = (element.textContent ?? '').trim().length <= 32;
    const props = [
      'background-color',
      'border-left-color',
      'border-top-color',
      'border-bottom-color',
    ];
    if (own.trim() !== '' && labelled) props.push('color');
    for (const property of props) {
      const key = colorKey(style.getPropertyValue(property));
      if (key && paints.has(key)) tally.matched.add(key);
    }
  }

  // Toggle buttons carrying their series' color, and checkboxes with a chosen accent.
  if (
    element.hasAttribute('aria-pressed') ||
    element.hasAttribute('aria-checked') ||
    element.hasAttribute('aria-selected')
  ) {
    for (const property of ['background-color', 'border-top-color', 'color']) {
      const value = style.getPropertyValue(property);
      const key = chromaKey(value);
      if (key) {
        tally.toggle.add(key);
        break;
      }
    }
  }
  if (
    element.localName === 'input' &&
    /^(?:checkbox|radio)$/i.test(element.getAttribute('type') ?? '')
  ) {
    const accent = style.getPropertyValue('accent-color').trim();
    if (accent && accent !== 'auto') {
      const key = colorKey(accent);
      if (key) tally.accent.add(key);
    }
  }
  return false;
}

/** Elements an `aria-describedby`-style relation names, outside the chart. */
function related(svg: Element): Element[] {
  const found: Element[] = [];
  const doc = svg.ownerDocument;
  for (const attribute of ['aria-describedby', 'aria-labelledby', 'aria-owns', 'aria-details']) {
    for (const id of (svg.getAttribute(attribute) ?? '').split(/\s+/).filter(Boolean)) {
      const target = doc.getElementById(id);
      if (target && !svg.contains(target) && !found.includes(target)) found.push(target);
    }
  }
  return found;
}

/** Whether `root` (a related element) is a legend: by name, or by the swatches inside it. */
function isLegendElement(
  root: Element,
  svg: Element,
  env: ChartEnvironment,
  paints: ReadonlySet<string>,
): boolean {
  const tally = emptyTally();
  let seen = 0;
  if (inspect(root, svg, env, tally, paints)) return true;
  for (const element of root.querySelectorAll('*')) {
    if (seen >= CHART_LIMITS.maxLegendScan) break;
    seen += 1;
    if (inspect(element, svg, env, tally, paints)) return true;
  }
  return distinct(tally);
}

/**
 * The elements around a chart where a legend could be: what the guard scans, and so also the
 * regions whose change (a legend added, removed, recolored, moved) makes the chart worth re-reading.
 */
export function legendScopes(svg: Element): Element[] {
  const scopes = scopesAround(svg);
  return scopes.length > 0 ? scopes : bodySiblings(svg);
}

/**
 * Whether an HTML legend may sit next to `svg`. Bounded: at most `maxLegendScan` elements per scope,
 * never the whole document. See the module comment for the evidence.
 */
export function hasHtmlLegend(
  svg: Element,
  env: ChartEnvironment,
  paints: ReadonlySet<string> = new Set(),
): boolean {
  for (const target of related(svg)) {
    if (isLegendElement(target, svg, env, paints)) return true;
  }
  for (const scope of legendScopes(svg)) {
    const tally = emptyTally();
    let seen = 0;
    // A sibling scope (chart directly in <body>) can itself be the legend; an ancestor never is.
    if (!scope.contains(svg) && inspect(scope, svg, env, tally, paints)) return true;
    for (const element of scope.querySelectorAll('*')) {
      if (seen >= CHART_LIMITS.maxLegendScan) break;
      seen += 1;
      if (svg.contains(element) || element === svg) continue;
      if (element.closest('svg') !== null && element.localName !== 'svg') continue;
      if (inspect(element, svg, env, tally, paints)) return true;
    }
    if (distinct(tally)) return true;
  }
  return false;
}
