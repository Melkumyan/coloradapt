/**
 * Performance budget for the DOM analyzer. See docs/PERFORMANCE.md.
 */
export const ANALYSIS_BUDGET = {
  /** Hard cap on elements inspected in a single analysis pass. */
  maxElements: 1500,
  /** Abort the pass if it runs longer than this, in milliseconds. */
  maxDurationMs: 50,
};

/**
 * Structural limits of the dynamic-site pipeline (docs/DYNAMIC_ANALYSIS.md).
 * Correctness never depends on the wall clock: the only time-based value
 * only spaces out full rescans, which are always eventually performed.
 */
export const DYNAMIC_BUDGET: DynamicBudget = {
  /** Mutation records queued between flushes; beyond this the queue is coalesced into one full rescan. */
  maxQueuedRecords: 5000,
  /** Distinct affected roots in one batch; beyond this the batch becomes one full rescan. */
  maxAffectedRoots: 512,
  /** Minimum gap between two mutation-driven full rescans (throttle only; never drops one). */
  fullRescanMinIntervalMs: 500,
  /** Safety bound on consecutive passes inside one forced flush. */
  maxPassesPerFlush: 64,
  /**
   * Minimum gap between two repairs of our `<style>` after the page deleted it. A page that
   * deletes it again every time would otherwise cost one repair per frame, forever; the repair
   * is postponed, never dropped.
   */
  stylesheetRepairMinIntervalMs: 500,
} as const;

/**
 * Slice budget of the dynamic pipeline (M12.5, docs/PERFORMANCE.md): one scheduled flush is one slice, and the
 * browser paints and handles input between slices. Frozen before the formal run (the gates are in
 * `realworld/m125/budgets.ts`). They only decide how many regions share a slice; none changes what is analyzed.
 */
export const SLICE_BUDGET = {
  /** Structural: elements one slice may inspect once its first region is in (a region after the first must fit). */
  maxElements: 600,
  /**
   * An inline SVG unit weighs `svgWeight + svgDescendantWeight x its descendants` elements in that count: its analysis
   * (probes, inheritance, a chart's marks) costs far more than a text element's (measured: about 0.8 ms for an icon,
   * 2.6 ms for a small line chart, 0.05 ms for a text element).
   */
  svgWeight: 12,
  svgDescendantWeight: 3,
  /** Descendants beyond this add nothing: a larger SVG is `complex-svg` (SVG_BUDGET) and is not analyzed in depth. */
  svgDescendantCap: 60,
  /** A semantic-cue candidate weighs this many elements: reading it, its peers and its pseudo-elements costs far more. */
  semanticWeight: 5,
  /** A further region is started only while the slice has used less than this of the clock (batching only). */
  maxStartMs: 10,
} as const;

export interface DynamicBudget {
  readonly maxQueuedRecords: number;
  readonly maxAffectedRoots: number;
  readonly fullRescanMinIntervalMs: number;
  readonly maxPassesPerFlush: number;
  readonly stylesheetRepairMinIntervalMs: number;
}
