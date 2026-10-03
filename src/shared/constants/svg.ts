/**
 * Structural limits of the inline-SVG layer (docs/SVG_ANALYSIS.md). These are
 * engineering thresholds of what ColorAdapt can model safely and cheaply, not
 * standards and not judgements about artwork. Nothing here is a wall-clock
 * value; an SVG over a limit is classified `complex-svg`, never half-analyzed.
 */
export const SVG_BUDGET = {
  /** Elements visited inside one outermost `<svg>` (and, together, inside its `<use>` targets). */
  maxDescendants: 200,
  /** Painted shapes + text elements + `<use>` instances in one `<svg>`. */
  maxPaintedElements: 24,
  /** Painted elements inside one `<use>` target. */
  maxUseContentElements: 24,
  /**
   * Distinct effective paints. Two or more is `multi-paint` (not adapted in M5);
   * more than this is `complex-svg`.
   */
  maxDistinctPaints: 4,
  /** Text elements + shapes at which an SVG is called `chart-like` (diagnostic label only). */
  chartLikeMinTextElements: 3,
  chartLikeMinShapes: 3,
  /** Nesting depth the traversal follows (a deeper tree is `complex-svg`). */
  maxDepth: 32,
} as const;
