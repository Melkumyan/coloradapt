import { describe, expect, it } from 'vitest';
import { analysisSize, exceedsSourceBudget, withinTransformBudget } from '@core/images';
import { IMAGE_LIMITS } from '@shared/constants';

describe('analysisSize', () => {
  it('analyzes small images at their own size', () => {
    expect(analysisSize(24, 24)).toEqual({ width: 24, height: 24, scale: 1 });
    expect(analysisSize(512, 400)).toEqual({ width: 512, height: 400, scale: 1 });
  });

  it('never exceeds the side or pixel budget, whatever the shape', () => {
    for (const [w, h] of [
      [4000, 3000],
      [10_000, 10_000],
      [20_000, 40],
      [1, 30_000],
      [513, 513],
    ] as const) {
      const size = analysisSize(w, h);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(
        IMAGE_LIMITS.maxAnalysisDimension,
      );
      expect(size.width * size.height).toBeLessThanOrEqual(IMAGE_LIMITS.maxAnalysisPixels);
      expect(size.width).toBeGreaterThanOrEqual(1);
      expect(size.height).toBeGreaterThanOrEqual(1);
    }
  });

  it('is deterministic and keeps the aspect ratio closely', () => {
    expect(analysisSize(4000, 3000)).toEqual(analysisSize(4000, 3000));
    const size = analysisSize(4000, 2000);
    expect(size.width / size.height).toBeCloseTo(2, 1);
  });

  it('treats degenerate sizes safely', () => {
    expect(analysisSize(0, 0)).toEqual({ width: 1, height: 1, scale: 1 });
  });
});

describe('budgets', () => {
  it('rejects images too large to decode and bitmaps too large to allocate', () => {
    expect(exceedsSourceBudget(8001, 8000)).toBe(true);
    expect(exceedsSourceBudget(4000, 3000)).toBe(false);
    expect(withinTransformBudget(1000, 1000)).toBe(true);
    expect(withinTransformBudget(1001, 1000)).toBe(false);
    expect(withinTransformBudget(0, 10)).toBe(false);
  });
});
