/**
 * M10 performance budgets. They were fixed before any M10 measurement was taken (git history of this file shows
 * when) and are never loosened to make a run pass: a number above its budget is reported as a failure.
 *
 * The product's own budgets (docs/PERFORMANCE.md) are *structural* (elements per pass, roots, rules): they
 * deliberately avoid the wall clock. These are the wall-clock expectations a real browser has to meet on top of
 * them, derived from the product statement "an analysis pass must not visibly block the page".
 */
export const BUDGETS = {
  /** Enabling adaptation (message round trip + analysis + planning + apply) on a page of up to 3000 elements. */
  enableMsP95: 500,
  /** The longest single main-thread task caused while enabling, pages up to 3000 elements (Chrome long-task API). */
  longTaskMs: 200,
  /** Same, for a 10,000-element page. */
  longTaskLargeMs: 500,
  /** From the end of a 1,000-mutation burst until the dynamic pipeline is idle. */
  dynamicIdle1kMs: 2_000,
  /** From the end of a 10,000-mutation burst until idle. */
  dynamicIdle10kMs: 5_000,
  /** Extra worst-case frame gap with adaptation on versus off during a 1,000-mutation burst. */
  frameGapExtraMs: 250,
  /** Passes started by the pipeline during 5 s of idle after it settled (a busy loop would show here). */
  idleBatchesIn5s: 0,
  /** A developer-audit pass on a page of up to 5,000 elements. */
  auditMsP95: 1_000,
  /** Post-GC JS heap after 500 SPA route changes versus after 50 (1.10 = at most +10%). */
  heapGrowthRatio: 1.1,
  /** DOM nodes and event listeners after 500 route changes versus after 50. */
  domGrowthRatio: 1.1,
} as const;

/** How many repetitions the performance suite takes of each measurement (median and p95 are over these). */
export const REPEATS = 7;

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Nearest-rank percentile (p in 0..100). */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}
