/**
 * Performance budget for the DOM analyzer. See docs/PERFORMANCE.md.
 */
export const ANALYSIS_BUDGET = {
  /** Hard cap on elements inspected in a single analysis pass. */
  maxElements: 1500,
  /** Abort the pass if it runs longer than this, in milliseconds. */
  maxDurationMs: 50,
  /** Minimum time between MutationObserver-triggered re-analyses. */
  mutationDebounceMs: 500,
} as const;
