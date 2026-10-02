/**
 * Heuristic thresholds for conflict detection. These are tuning knobs, not
 * scientifically derived cutoffs — see docs/PRODUCT.md for caveats.
 */
export const CONTRAST_THRESHOLDS = {
  /** WCAG AA minimum for normal text. */
  aaNormalText: 4.5,
  /** WCAG AA minimum for large text / UI components. */
  aaLargeText: 3,
} as const;

export const PERCEPTUAL_DISTANCE_THRESHOLDS = {
  /** Below this, colors are estimated to be effectively indistinguishable. */
  indistinguishable: 0.05,
  /** Below this, colors are estimated to be hard to tell apart. */
  hardToDistinguish: 0.1,
  /** Below this, colors are estimated to be only mildly distinguishable. */
  mildlyDistinguishable: 0.18,
} as const;
