import type { SvgUnsupportedReason } from '@domain/models';
import { hasOwnText } from '@core/analysis/text';
import { SVG_BUDGET } from '@shared/constants';
import {
  XLINK_NAMESPACE,
  isContainerTag,
  isNonRenderedTag,
  isShapeTag,
  isSmilTag,
  isSvgElement,
  isTextTag,
} from './classification';
import { parseNumber } from './paint';

export type StyleReader = (element: Element) => CSSStyleDeclaration;

/** One element that paints (a shape, or text with its own glyphs), with its computed paint inputs. */
export interface PaintedElement {
  readonly element: Element;
  readonly kind: 'shape' | 'text';
  /** Computed `fill` / `stroke`, as the browser serializes them. */
  readonly fill: string;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly fillOpacity: number;
  readonly strokeOpacity: number;
  /**
   * Product of this element's and its SVG ancestors' own `opacity`, up to but
   * *not* including the scan root (the root's opacity belongs to the page-level
   * compositing in `background-resolution`).
   */
  readonly groupOpacity: number;
}

/** Where a `<use>` points. */
export type UseTarget =
  | { readonly kind: 'local'; readonly target: Element }
  | { readonly kind: 'external' }
  | { readonly kind: 'unresolved' };

/** One `<use>` instance and what it instantiates. */
export interface ScannedUse {
  readonly use: Element;
  readonly groupOpacity: number;
  readonly target: UseTarget;
  /** Painted elements of the referenced content (empty unless `target` is local). */
  readonly content: readonly PaintedElement[];
  /** Parent of the referenced element: the element a style probe goes on. */
  readonly host: Element | null;
}

export interface SvgScan {
  readonly painted: PaintedElement[];
  readonly uses: ScannedUse[];
  /** Reasons the SVG must not be adapted, found while walking (paint servers are judged later). */
  readonly blockers: Set<SvgUnsupportedReason>;
  /** Elements visited, over the root and all referenced `<use>` content. */
  visited: number;
  /** A structural limit cut the walk: nothing may be concluded from a partial scan. */
  overBudget: boolean;
}

function nonDefault(value: string | undefined, neutral: string): boolean {
  const text = (value ?? '').trim();
  return text !== '' && text.toLowerCase() !== neutral;
}

/**
 * Properties that change a color's *appearance* without being a paint — a
 * filter, a mask, a blend mode, markers — none of which is modeled. Their
 * presence on any rendered element of the SVG keeps it out of adaptation.
 */
function blockersOf(style: CSSStyleDeclaration): SvgUnsupportedReason[] {
  const found: SvgUnsupportedReason[] = [];
  if (nonDefault(style.filter, 'none')) found.push('filter');
  if (
    nonDefault(style.maskImage, 'none') ||
    nonDefault(style.getPropertyValue('mask-image'), 'none')
  ) {
    found.push('mask');
  }
  if (nonDefault(style.mixBlendMode, 'normal')) found.push('blend-mode');
  if (
    nonDefault(style.getPropertyValue('marker-start'), 'none') ||
    nonDefault(style.getPropertyValue('marker-mid'), 'none') ||
    nonDefault(style.getPropertyValue('marker-end'), 'none')
  ) {
    found.push('marker');
  }
  return found;
}

/** Resolves `<use href>` / `xlink:href` to a same-document target (`#id`). */
export function resolveUseTarget(use: Element): UseTarget {
  const href =
    use.getAttribute('href') ??
    use.getAttributeNS(XLINK_NAMESPACE, 'href') ??
    use.getAttribute('xlink:href');
  const value = (href ?? '').trim();
  if (value === '') return { kind: 'unresolved' };
  if (!value.startsWith('#')) return { kind: 'external' };
  let id = value.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // keep the raw id
  }
  const target = use.ownerDocument.getElementById(id);
  // A target that contains its own `<use>` is a reference cycle; a non-SVG target is no SVG content.
  if (!target || !isSvgElement(target) || target.contains(use)) return { kind: 'unresolved' };
  return { kind: 'local', target };
}

interface WalkState {
  readonly scan: SvgScan;
  readonly getStyle: StyleReader;
  readonly maxDescendants: number;
  readonly maxPainted: number;
  /** Painted elements recorded so far in the current collection (the scan's, or one `<use>` target's). */
  painted: PaintedElement[];
  /** Whether `<use>` is followed here (not inside referenced content: nesting is unsupported). */
  allowUse: boolean;
  /**
   * Record every shape/text element, painted or not. Referenced content is read
   * this way: whether it paints depends on the instance (`<use>`), not on the
   * tree it is defined in.
   */
  recordAll: boolean;
  /** Uses found while walking referenced content (nested): always a blocker. */
  nestedUse: boolean;
}

function visibleStroke(style: CSSStyleDeclaration): number {
  return parseNumber(style.strokeWidth, 1);
}

function recordPainted(
  state: WalkState,
  element: Element,
  kind: 'shape' | 'text',
  style: CSSStyleDeclaration,
  groupOpacity: number,
): void {
  const fill = (style.fill ?? '').trim();
  const stroke = (style.stroke ?? '').trim();
  const strokeWidth = visibleStroke(style);
  const paintsFill = fill !== '' && fill.toLowerCase() !== 'none';
  const paintsStroke = stroke !== '' && stroke.toLowerCase() !== 'none' && strokeWidth > 0;
  if (!state.recordAll && !paintsFill && !paintsStroke) return;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return;

  if (state.painted.length >= state.maxPainted) {
    state.scan.overBudget = true;
    return;
  }
  state.painted.push({
    element,
    kind,
    fill,
    stroke,
    strokeWidth,
    fillOpacity: parseNumber(style.fillOpacity, 1),
    strokeOpacity: parseNumber(style.strokeOpacity, 1),
    groupOpacity,
  });
}

/**
 * Visits `element` and, where it renders its children in place, those too.
 * `asUseTarget` lets a referenced `<symbol>` (never rendered where it stands)
 * be walked as content. Every element counts against the visit budget.
 */
function visit(
  element: Element,
  state: WalkState,
  parentOpacity: number,
  depth: number,
  asUseTarget: boolean,
): void {
  const { scan } = state;
  if (scan.overBudget) return;
  scan.visited += 1;
  if (scan.visited > state.maxDescendants || depth > SVG_BUDGET.maxDepth) {
    scan.overBudget = true;
    return;
  }
  if (!isSvgElement(element)) return;

  const tag = element.localName.toLowerCase();
  if (isSmilTag(tag)) {
    scan.blockers.add('animated');
    return;
  }
  if (tag === 'foreignobject') {
    scan.blockers.add('foreign-object');
    return;
  }
  if (isNonRenderedTag(tag) && !(asUseTarget && tag === 'symbol')) return;

  const style = state.getStyle(element);
  if (style.display === 'none') return;
  for (const reason of blockersOf(style)) scan.blockers.add(reason);

  const own = parseNumber(style.opacity, 1);
  if (own <= 0) return;
  const groupOpacity = parentOpacity * own;

  if (tag === 'image') {
    scan.blockers.add('embedded-image');
    return;
  }

  if (tag === 'use') {
    if (!state.allowUse) {
      state.nestedUse = true;
      return;
    }
    scanUse(element, state, groupOpacity);
    return;
  }

  if (isShapeTag(tag)) {
    recordPainted(state, element, 'shape', style, groupOpacity);
    noteSmilChildren(element, scan);
    return;
  }

  if (isTextTag(tag)) {
    if (hasOwnText(element)) recordPainted(state, element, 'text', style, groupOpacity);
    noteSmilChildren(element, scan);
    for (const child of element.children) visit(child, state, groupOpacity, depth + 1, false);
    return;
  }

  if (isContainerTag(tag) || (asUseTarget && tag === 'symbol')) {
    for (const child of element.children) visit(child, state, groupOpacity, depth + 1, false);
  }
}

/** SMIL (`<animate>`, `<set>`) is a child of the shape it animates, which the walk does not enter. */
function noteSmilChildren(element: Element, scan: SvgScan): void {
  for (const child of element.children) {
    if (isSmilTag(child.localName.toLowerCase())) scan.blockers.add('animated');
  }
}

function scanUse(use: Element, state: WalkState, groupOpacity: number): void {
  const { scan } = state;
  const target = resolveUseTarget(use);
  if (target.kind === 'external') scan.blockers.add('use-external');
  if (target.kind === 'unresolved') scan.blockers.add('use-unresolved');
  if (target.kind !== 'local') {
    scan.uses.push({ use, groupOpacity, target, content: [], host: null });
    return;
  }

  const contentState: WalkState = {
    ...state,
    painted: [],
    maxPainted: SVG_BUDGET.maxUseContentElements,
    allowUse: false,
    recordAll: true,
    nestedUse: false,
  };
  // The target's own `opacity`/properties are part of the instance: walk it with a neutral parent.
  visit(target.target, contentState, 1, 0, true);
  if (contentState.nestedUse) scan.blockers.add('use-unresolved');
  scan.uses.push({
    use,
    groupOpacity,
    target,
    content: contentState.painted,
    host: target.target.parentElement,
  });
}

/**
 * One bounded walk over an outermost `<svg>`: which elements paint, which
 * `<use>` instances it holds, and whether anything makes it unsafe to adapt.
 * The work is limited structurally (`SVG_BUDGET`): the walk stops at the limit
 * and says so (`overBudget`) rather than ever returning a partial picture as if
 * it were whole.
 */
export function scanSvg(root: Element, getStyle: StyleReader): SvgScan {
  const scan: SvgScan = {
    painted: [],
    uses: [],
    blockers: new Set(),
    visited: 0,
    overBudget: false,
  };
  const state: WalkState = {
    scan,
    getStyle,
    maxDescendants: SVG_BUDGET.maxDescendants,
    maxPainted: SVG_BUDGET.maxPaintedElements,
    painted: scan.painted,
    allowUse: true,
    recordAll: false,
    nestedUse: false,
  };

  // The root's own filter/mask/blend mode counts too; its opacity is handled by the page-level chain.
  const rootStyle = getStyle(root);
  for (const reason of blockersOf(rootStyle)) scan.blockers.add(reason);
  scan.visited = 1;
  for (const child of root.children) visit(child, state, 1, 1, false);
  return scan;
}
