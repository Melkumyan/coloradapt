/**
 * Plain-data model of the SVG layer (docs/SVG_ANALYSIS.md). The analyzer fills
 * it in; the planner reads it. Neither needs the other's code.
 */

/**
 * Why an inline SVG is never adapted. These are *engineering* classifications
 * of what ColorAdapt can model safely, not statements about the artwork.
 */
export type SvgUnsupportedReason =
  /** `fill`/`stroke` is a gradient (`url(#linearGradient)`). */
  | 'paint-gradient'
  /** `fill`/`stroke` is a `<pattern>`. */
  | 'paint-pattern'
  /** `fill`/`stroke` is a `url(...)` that is neither (missing, external, `<meshgradient>`...). */
  | 'paint-server'
  /** `context-fill` / `context-stroke`: the paint comes from somewhere we do not model. */
  | 'paint-context'
  | 'filter'
  | 'mask'
  | 'blend-mode'
  | 'marker'
  | 'foreign-object'
  | 'embedded-image'
  /** SMIL or a CSS/Web animation drives a paint property. */
  | 'animated'
  /** More than one distinct visible paint, within the engineering thresholds. */
  | 'multi-paint'
  /** Over a structural threshold (descendants, painted elements, distinct paints). */
  | 'complex-svg'
  /** Text labels next to several shapes: looks like data visualization (M7). */
  | 'chart-like'
  /** `<use href="file.svg#id">` / `data:` — not resolvable without new permissions. */
  | 'use-external'
  /** `<use>` whose target is missing, nested, or part of a reference cycle. */
  | 'use-unresolved'
  /** The referenced content declares its own paint: it is shared by every instance. */
  | 'use-shared-paint';

/** Why an SVG is analyzed but its colors are not trustworthy enough to rewrite. */
export type SvgPartialReason =
  /** Opacity / `fill-opacity` / alpha: the visible color is a composite no single value reproduces. */
  | 'translucent-paint'
  /** Nothing can tell which declaration drives a paint (no style probe available). */
  | 'derivation-unknown';

/** Element-level role inside an SVG (docs/SVG_ANALYSIS.md, "Element roles"). */
export type SvgElementRole = 'icon' | 'text' | 'shape' | 'container' | 'use-instance' | 'unknown';

/** The CSS property a rule writes to change one paint. */
export type SvgPaintProperty = 'color' | 'fill' | 'stroke';

/** One rule's target: the element and the property that owns a paint. */
export interface SvgPaintTarget {
  readonly elementId: string;
  readonly property: SvgPaintProperty;
}

/**
 * What the analyzer learned about one outermost inline `<svg>`. Present on
 * its {@link ElementDescriptor}; the descriptor's `colorPair` is the unit's
 * single effective paint over its resolved background.
 */
export interface SvgUnitInfo {
  /** `text` only when every painted element is SVG text; otherwise `icon`. */
  readonly kind: 'icon' | 'text';
  /** Set => the unit is never adapted. */
  readonly unsupportedReason?: SvgUnsupportedReason;
  /** Set => analyzed, but not adapted. */
  readonly partialReason?: SvgPartialReason;
  /** Distinct effective visible paints. */
  readonly paintCount: number;
  /** Painted shapes / text elements / `<use>` instances. */
  readonly shapeCount: number;
  readonly textCount: number;
  readonly useCount: number;
  /** Which kind of paint server blocked the unit, for diagnostics. */
  readonly paintServer?: 'gradient' | 'pattern' | 'other';
  /** Rules that change the unit's paint (empty unless the unit is a single, adaptable paint). */
  readonly targets: readonly SvgPaintTarget[];
}

/** Gauges of the SVG layer, for tests and debugging. Never leave the device. */
export interface SvgDiagnostics {
  /** Inline SVG units currently tracked. */
  readonly svgAnalyzed: number;
  /** Units with at least one rule in the stylesheet. */
  readonly svgAdapted: number;
  /** Units classified `unsupported` (see {@link SvgUnsupportedReason}). */
  readonly svgUnsupported: number;
  /** Units whose planned paint the browser did not reproduce. */
  readonly svgNotApplied: number;
  /** Units blocked by a gradient, pattern or other paint server. */
  readonly svgPaintServers: number;
}

export const EMPTY_SVG_DIAGNOSTICS: SvgDiagnostics = {
  svgAnalyzed: 0,
  svgAdapted: 0,
  svgUnsupported: 0,
  svgNotApplied: 0,
  svgPaintServers: 0,
};
