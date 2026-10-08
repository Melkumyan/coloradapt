/**
 * Trend statistics of the M12 resource and soak runs (docs/m12/protocol.md, P24 and P25). Pure functions,
 * unit-tested in tests/release/soak-stats.test.ts; the verdict rules live in the protocol, not here.
 */

export const median = (values: readonly number[]): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Theil-Sen slope (median of pairwise slopes): robust against the sawtooth a garbage collector draws. Units: y per x. */
export function theilSen(points: ReadonlyArray<readonly [number, number]>): number {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j]![0] - points[i]![0];
      if (dx !== 0) slopes.push((points[j]![1] - points[i]![1]) / dx);
    }
  }
  return median(slopes);
}

export interface Trend {
  /** Samples used (after warm-up). */
  readonly n: number;
  /** Median of the first and of the last fifth of those samples. */
  readonly early: number;
  readonly late: number;
  /** late / early (1 = flat). */
  readonly ratio: number;
  /** Theil-Sen slope as a fraction of the overall median per hour. */
  readonly slopePerHour: number;
}

/**
 * Trend of one series after a warm-up: the median of the last fifth against the median of the first fifth, and the
 * robust slope per hour relative to the median. `t` is in milliseconds.
 */
export function trendOf(
  series: ReadonlyArray<readonly [number, number]>,
  warmupFraction = 0.15,
): Trend {
  const skip = Math.floor(series.length * warmupFraction);
  const used = series.slice(skip);
  const fifth = Math.max(1, Math.floor(used.length / 5));
  const early = median(used.slice(0, fifth).map((p) => p[1]));
  const late = median(used.slice(-fifth).map((p) => p[1]));
  const center = median(used.map((p) => p[1]));
  const slope = theilSen(used.map(([t, v]) => [t / 3_600_000, v] as const));
  return {
    n: used.length,
    early,
    late,
    ratio: early === 0 ? (late === 0 ? 1 : Number.POSITIVE_INFINITY) : late / early,
    slopePerHour: center === 0 ? 0 : slope / center,
  };
}
