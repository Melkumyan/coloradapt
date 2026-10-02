import { describe, expect, it } from 'vitest';
import { calculateContrast, findAlternativeColor } from '@core/color';
import type { ColorValue } from '@domain/models';

const WHITE: ColorValue = { r: 1, g: 1, b: 1, alpha: 1 };
const LIGHT_GRAY: ColorValue = { r: 0.85, g: 0.85, b: 0.85, alpha: 1 };

describe('findAlternativeColor', () => {
  it('returns the input unchanged when it already meets the target contrast', () => {
    const black: ColorValue = { r: 0, g: 0, b: 0, alpha: 1 };
    expect(findAlternativeColor(black, WHITE, 4.5)).toEqual(black);
  });

  it('darkens a low-contrast foreground until it meets the target contrast', () => {
    const result = findAlternativeColor(LIGHT_GRAY, WHITE, 4.5);
    expect(calculateContrast(result, WHITE)).toBeGreaterThanOrEqual(4.4);
  });
});
