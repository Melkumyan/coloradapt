import type { SvgElementRole } from '@domain/models';

export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
export const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';

/** Elements that paint geometry with `fill`/`stroke`. */
const SHAPE_TAGS: ReadonlySet<string> = new Set([
  'path',
  'circle',
  'ellipse',
  'rect',
  'line',
  'polyline',
  'polygon',
]);

/** Elements that paint glyphs with `fill`/`stroke`. */
const TEXT_TAGS: ReadonlySet<string> = new Set(['text', 'tspan', 'textpath']);

/** Elements whose children are rendered where they stand (the traversal descends into them). */
const CONTAINER_TAGS: ReadonlySet<string> = new Set(['svg', 'g', 'a', 'switch']);

/**
 * Elements whose subtree is never painted where it stands: definitions,
 * resources and metadata. Their content only matters when something
 * references it (`<use>`, a paint server, `mask`, `filter`, ...), and each of
 * those references is classified on its own.
 */
const NON_RENDERED_TAGS: ReadonlySet<string> = new Set([
  'defs',
  'symbol',
  'clippath',
  'mask',
  'pattern',
  'marker',
  'lineargradient',
  'radialgradient',
  'meshgradient',
  'filter',
  'style',
  'title',
  'desc',
  'metadata',
  'script',
  'stop',
  'view',
]);

/** SMIL animation elements. Any of them under an SVG makes its paint a moving target. */
const SMIL_TAGS: ReadonlySet<string> = new Set(['animate', 'set', 'animatecolor']);

export function isSvgElement(element: Element): boolean {
  return element.namespaceURI === SVG_NAMESPACE;
}

function tagOf(element: Element): string {
  return element.localName.toLowerCase();
}

export const isShapeTag = (tag: string): boolean => SHAPE_TAGS.has(tag);
export const isTextTag = (tag: string): boolean => TEXT_TAGS.has(tag);
export const isContainerTag = (tag: string): boolean => CONTAINER_TAGS.has(tag);
export const isNonRenderedTag = (tag: string): boolean => NON_RENDERED_TAGS.has(tag);
export const isSmilTag = (tag: string): boolean => SMIL_TAGS.has(tag);

/**
 * Rough, structural role of one SVG element. It only says what the element
 * does in the paint model; it never says what it *means* (docs/SVG_ANALYSIS.md).
 *
 * `icon` is an outermost `<svg>`; `shape`/`text`/`container` are the elements
 * inside; `use-instance` is `<use>`.
 */
export function classifySvgElement(element: Element): SvgElementRole {
  if (!isSvgElement(element)) return 'unknown';
  const tag = tagOf(element);
  if (tag === 'svg') return outermostSvg(element) === element ? 'icon' : 'container';
  if (tag === 'use') return 'use-instance';
  if (SHAPE_TAGS.has(tag)) return 'shape';
  if (TEXT_TAGS.has(tag)) return 'text';
  if (CONTAINER_TAGS.has(tag)) return 'container';
  return 'unknown';
}

/**
 * The outermost `<svg>` that contains `element` (or is `element`), or null for
 * a node outside any inline SVG. Walks up through SVG-namespace ancestors only,
 * so HTML inside a `<foreignObject>` is *not* part of the SVG.
 */
export function outermostSvg(element: Element): Element | null {
  if (!isSvgElement(element)) return null;
  let top: Element | null = null;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (!isSvgElement(current)) break;
    if (tagOf(current) === 'svg') top = current;
  }
  return top;
}

/** True for an `<svg>` that is not nested in another `<svg>`: the unit of SVG analysis. */
export function isOutermostSvg(element: Element): boolean {
  return isSvgElement(element) && tagOf(element) === 'svg' && outermostSvg(element) === element;
}
