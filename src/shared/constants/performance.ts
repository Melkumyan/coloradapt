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

export interface DynamicBudget {
  readonly maxQueuedRecords: number;
  readonly maxAffectedRoots: number;
  readonly fullRescanMinIntervalMs: number;
  readonly maxPassesPerFlush: number;
  readonly stylesheetRepairMinIntervalMs: number;
}
