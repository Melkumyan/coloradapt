import type { BackgroundKind, ColorValue } from '@domain/models';
import { parseColor } from '@core/color';
import { clamp01 } from '@shared/utils';

/** Bound on how far up the ancestor chain a single resolution may walk. */
const MAX_ANCESTOR_DEPTH = 200;

/** Alpha at/above which a layer is treated as fully opaque. */
const OPAQUE_ALPHA = 0.999;

/** Alpha below which a layer is treated as not painting anything. */
const NEGLIGIBLE_ALPHA = 0.004;

const TRANSPARENT: ColorValue = { r: 0, g: 0, b: 0, alpha: 0 };
const OPAQUE_WHITE: ColorValue = { r: 1, g: 1, b: 1, alpha: 1 };

/** One element's own paint inputs, parsed once and reused by every descendant. */
interface OwnLayer {
  readonly background: ColorValue;
  readonly opacity: number;
}

/**
 * CSS `opacity` composites an element *and its descendants* as one group,
 * so a chain is evaluated as nested groups, inside-out, rather than as a
 * flat stack of independently-dimmed layers: for each element from the
 * target up to the root, `group = opacity * (content over own background)`,
 * where `content` is the group of the child below it. The final group is
 * painted over the opaque white page canvas.
 */
interface ChainState {
  /** This element's own parsed layer (ancestors' layers are looked up in the cache). */
  readonly layer: OwnLayer;
  /** True if an `html`/`body` opacity makes canvas background propagation ambiguous. */
  readonly approximate: boolean;
  /** Worst background kind seen since the last fully-opaque solid layer. */
  readonly kind: BackgroundKind;
  /** Product of this element's and every ancestor's own `opacity`. */
  readonly cumulativeOpacity: number;
  /** True if an ancestor-depth budget cut this chain short. */
  readonly truncated: boolean;
}

const ROOT_STATE: ChainState = {
  layer: { background: TRANSPARENT, opacity: 1 },
  approximate: false,
  kind: 'none',
  cumulativeOpacity: 1,
  truncated: false,
};

export type BackgroundResolutionCache = Map<Element, ChainState>;

function classifyBackgroundImage(backgroundImage: string): 'none' | 'gradient' | 'image' | 'mixed' {
  const value = backgroundImage.trim();
  if (!value || value === 'none') return 'none';

  const hasGradient = /gradient\s*\(/i.test(value);
  const hasImage = /url\s*\(/i.test(value);

  if (hasGradient && hasImage) return 'mixed';
  if (hasGradient) return 'gradient';
  if (hasImage) return 'image';
  // Some other painted layer we don't recognize (e.g. `paint()`, `cross-fade()`,
  // `image-set()`). Treat conservatively as an unsupported "image"-like layer
  // rather than silently assuming it's empty.
  return 'image';
}

function combineKind(
  previous: BackgroundKind,
  next: 'gradient' | 'image' | 'mixed',
): BackgroundKind {
  if (previous === 'none' || previous === 'solid') return next;
  if (previous === next) return previous;
  return 'mixed';
}

/** Applies one element's own background layer on top of its parent's resolved state. */
function applyOwnLayer(
  element: Element,
  parentState: ChainState,
  style: CSSStyleDeclaration,
): ChainState {
  const ownOpacity = clamp01(Number.parseFloat(style.opacity || '1') || 0);
  const imageKind = classifyBackgroundImage(style.backgroundImage || 'none');
  const bgColor = parseColor(style.backgroundColor || 'transparent') ?? TRANSPARENT;
  // Occlusion within the element's own opacity stack (not a compositing weight).
  const occlusionAlpha = clamp01(bgColor.alpha * ownOpacity * parentState.cumulativeOpacity);

  let kind = parentState.kind;
  if (imageKind !== 'none') {
    kind = combineKind(kind, imageKind);
  } else if (occlusionAlpha > NEGLIGIBLE_ALPHA && kind === 'none') {
    kind = 'solid';
  }
  // A fully opaque solid layer occludes everything painted behind it, so any
  // gradient/image taint accumulated from ancestors no longer matters.
  if (imageKind === 'none' && occlusionAlpha >= OPAQUE_ALPHA) {
    kind = 'solid';
  }

  const isRootElement = element.tagName === 'HTML' || element.tagName === 'BODY';

  return {
    layer: { background: bgColor, opacity: ownOpacity },
    approximate: parentState.approximate || (isRootElement && ownOpacity < OPAQUE_ALPHA),
    kind,
    cumulativeOpacity: parentState.cumulativeOpacity * ownOpacity,
    truncated: parentState.truncated,
  };
}

/**
 * Resolves the full ancestor-chain state for `element` (its composited
 * background including its own layer, and its cumulative opacity),
 * memoizing per element so shared ancestors across many analyzed elements
 * are only ever folded once per analysis pass.
 */
function resolveChainState(
  element: Element,
  getStyle: (el: Element) => CSSStyleDeclaration,
  cache: BackgroundResolutionCache,
): ChainState {
  const cached = cache.get(element);
  if (cached) return cached;

  const toApply: Element[] = [];
  let current: Element | null = element;
  let depth = 0;

  while (current && !cache.has(current) && depth < MAX_ANCESTOR_DEPTH) {
    toApply.push(current);
    current = current.parentElement;
    depth += 1;
  }

  let state: ChainState;
  if (current) {
    const cachedAncestor = cache.get(current);
    // `current` is non-null but uncached only when the depth budget cut the
    // walk short before reaching a cached or root ancestor.
    state = cachedAncestor ?? { ...ROOT_STATE, truncated: true };
  } else {
    state = ROOT_STATE;
  }

  for (let i = toApply.length - 1; i >= 0; i -= 1) {
    const el = toApply[i];
    if (!el) continue;
    state = applyOwnLayer(el, state, getStyle(el));
    cache.set(el, state);
  }

  return state;
}

export interface ResolvedBackground {
  /** Fully opaque, best-effort effective background color. */
  readonly color: ColorValue;
  readonly kind: BackgroundKind;
  /** True if resolution had to fall back on a depth budget rather than
   * reaching a definitive answer. */
  readonly truncated: boolean;
  /** True if the model can't be exact (e.g. `opacity` on `html`/`body`). */
  readonly approximate: boolean;
}

/**
 * Resolves the effective visual background behind `element`'s content: its
 * own background painted over its resolved ancestor stack, with alpha
 * compositing through any semi-transparent layers, falling back to an
 * opaque white page canvas if nothing in the stack is ever fully opaque
 * (see docs/CSS_ANALYSIS.md's html/body policy).
 */
export function resolveEffectiveBackground(
  element: Element,
  getStyle: (el: Element) => CSSStyleDeclaration,
  cache: BackgroundResolutionCache,
): ResolvedBackground {
  const state = resolveChainState(element, getStyle, cache);

  return {
    color: composeOverPage(element, TRANSPARENT, cache),
    kind: state.kind === 'none' ? 'solid' : state.kind,
    truncated: state.truncated,
    approximate: state.approximate,
  };
}

/**
 * Evaluates the nested opacity groups from `element` up to the root with
 * `content` painted at the innermost level, then flattens onto the opaque
 * white page. Colors are handled premultiplied internally. Requires the
 * chain to already be in `cache` (see {@link resolveChainState}).
 */
function composeOverPage(
  element: Element,
  content: ColorValue,
  cache: BackgroundResolutionCache,
): ColorValue {
  let r = content.r * content.alpha;
  let g = content.g * content.alpha;
  let b = content.b * content.alpha;
  let a = content.alpha;

  let current: Element | null = element;
  for (let depth = 0; current && depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    const layer = cache.get(current)?.layer;
    if (!layer) break;
    const { background: bg, opacity } = layer;
    const under = 1 - a;
    r = opacity * (r + under * bg.r * bg.alpha);
    g = opacity * (g + under * bg.g * bg.alpha);
    b = opacity * (b + under * bg.b * bg.alpha);
    a = opacity * (a + under * bg.alpha);
    current = current.parentElement;
  }

  const rest = 1 - a;
  return {
    r: clamp01(r + rest * OPAQUE_WHITE.r),
    g: clamp01(g + rest * OPAQUE_WHITE.g),
    b: clamp01(b + rest * OPAQUE_WHITE.b),
    alpha: 1,
  };
}

/**
 * The color a pixel of `element`'s text actually shows: its computed
 * `color` (alpha included) painted over the element's own background
 * *inside* the same opacity groups, then dimmed by those groups together
 * with the background — never dimmed separately and flattened on an
 * already-dimmed background, which would double-apply opacity.
 */
export function resolveEffectiveTextColor(
  element: Element,
  text: ColorValue,
  getStyle: (el: Element) => CSSStyleDeclaration,
  cache: BackgroundResolutionCache,
): ColorValue {
  resolveChainState(element, getStyle, cache);
  return composeOverPage(element, text, cache);
}

/**
 * Cumulative opacity (this element's own `opacity` times every ancestor's)
 * — the multiplier CSS `opacity` applies to an element's rendered content,
 * as distinct from an explicit `rgba()`/`color` alpha. Shares the same
 * memoized chain as {@link resolveEffectiveBackground}.
 */
export function resolveCumulativeOpacity(
  element: Element,
  getStyle: (el: Element) => CSSStyleDeclaration,
  cache: BackgroundResolutionCache,
): number {
  return resolveChainState(element, getStyle, cache).cumulativeOpacity;
}

export function createBackgroundResolutionCache(): BackgroundResolutionCache {
  return new Map();
}
