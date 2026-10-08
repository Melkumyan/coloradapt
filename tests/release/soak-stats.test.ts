import { describe, expect, it } from 'vitest';
import { median, theilSen, trendOf } from '../../realworld/m12/stats';

/** The statistics the M12 soak verdict is computed with must themselves be right (and robust to a sawtooth). */
describe('soak statistics', () => {
  it('median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
  });

  it('theil-sen recovers an exact slope and ignores an outlier', () => {
    const line = Array.from({ length: 20 }, (_v, i) => [i, 3 * i + 5] as const);
    expect(theilSen(line)).toBeCloseTo(3, 10);
    const withOutlier = line.map((p, i) => (i === 10 ? ([p[0], 1e6] as const) : p));
    expect(theilSen(withOutlier)).toBeCloseTo(3, 1);
  });

  it('a flat series with a garbage-collection sawtooth is flat', () => {
    const hour = 3_600_000;
    const series = Array.from(
      { length: 120 },
      (_v, i) => [(i * 2 * hour) / 120, 100 + (i % 10) * 3] as const,
    );
    const t = trendOf(series);
    expect(t.ratio).toBeGreaterThan(0.9);
    expect(t.ratio).toBeLessThan(1.1);
    expect(Math.abs(t.slopePerHour)).toBeLessThan(0.05);
  });

  it('a leak is measured as growth: +20% per hour is reported as such', () => {
    const hour = 3_600_000;
    const series = Array.from({ length: 120 }, (_v, i) => {
      const t = (i * 2 * hour) / 120;
      return [t, 100 * (1 + 0.2 * (t / hour))] as const;
    });
    const t = trendOf(series);
    expect(t.ratio).toBeGreaterThan(1.25);
    expect(t.slopePerHour).toBeGreaterThan(0.12);
  });

  it('warm-up growth is excluded', () => {
    const hour = 3_600_000;
    const series = Array.from(
      { length: 100 },
      (_v, i) => [(i * hour) / 50, i < 15 ? 50 + i * 10 : 200] as const,
    );
    expect(trendOf(series).ratio).toBeCloseTo(1, 5);
  });
});
