import { describe, expect, it } from 'vitest';
import { calculateContrast, flattenOnBackground } from '@core/color';
import type { ColorValue } from '@domain/models';

const WHITE: ColorValue = { r: 1, g: 1, b: 1, alpha: 1 };
const BLACK: ColorValue = { r: 0, g: 0, b: 0, alpha: 1 };

describe('calculateContrast', () => {
  it('returns 21 for black on white', () => {
    expect(calculateContrast(BLACK, WHITE)).toBeCloseTo(21, 1);
  });

  it('returns 1 for identical colors', () => {
    expect(calculateContrast(WHITE, WHITE)).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(calculateContrast(BLACK, WHITE)).toBeCloseTo(calculateContrast(WHITE, BLACK), 10);
  });
});

describe('flattenOnBackground', () => {
  it('returns the opaque color unchanged', () => {
    expect(flattenOnBackground(BLACK, WHITE)).toMatchObject({ r: 0, g: 0, b: 0, alpha: 1 });
  });

  it('blends a semi-transparent color toward the backdrop', () => {
    const halfBlack: ColorValue = { r: 0, g: 0, b: 0, alpha: 0.5 };
    const result = flattenOnBackground(halfBlack, WHITE);
    expect(result.r).toBeCloseTo(0.5, 5);
    expect(result.alpha).toBe(1);
  });
});
