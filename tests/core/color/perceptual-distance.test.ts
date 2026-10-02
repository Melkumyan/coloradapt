import { describe, expect, it } from 'vitest';
import { calculatePerceptualDistance } from '@core/color';
import type { ColorValue } from '@domain/models';

const WHITE: ColorValue = { r: 1, g: 1, b: 1, alpha: 1 };
const BLACK: ColorValue = { r: 0, g: 0, b: 0, alpha: 1 };

describe('calculatePerceptualDistance', () => {
  it('is zero for identical colors', () => {
    expect(calculatePerceptualDistance(WHITE, WHITE)).toBeCloseTo(0, 10);
  });

  it('is large for black vs white', () => {
    expect(calculatePerceptualDistance(BLACK, WHITE)).toBeGreaterThan(0.5);
  });

  it('is symmetric', () => {
    const a: ColorValue = { r: 0.8, g: 0.2, b: 0.4, alpha: 1 };
    const b: ColorValue = { r: 0.3, g: 0.6, b: 0.1, alpha: 1 };
    expect(calculatePerceptualDistance(a, b)).toBeCloseTo(calculatePerceptualDistance(b, a), 10);
  });
});
