import { describe, expect, it } from 'vitest';
import { linearToSrgb, srgbToLinear } from '@core/color';

// Expected values are hand-derived from the IEC 61966-2-1 definition, not from the code under test.
describe('sRGB transfer functions', () => {
  it('maps the endpoints', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 12);
    expect(linearToSrgb(0)).toBe(0);
    expect(linearToSrgb(1)).toBe(1);
  });

  it('uses the linear segment below the threshold (not a pure power law)', () => {
    // 0.04 < 0.04045 -> 0.04 / 12.92
    expect(srgbToLinear(0.04)).toBeCloseTo(0.04 / 12.92, 12);
    // 0.003 < 0.0031308 -> 0.003 * 12.92
    expect(linearToSrgb(0.003)).toBeCloseTo(0.003 * 12.92, 12);
  });

  it('is continuous across the threshold', () => {
    expect(srgbToLinear(0.04045)).toBeCloseTo(0.0031308, 6);
    expect(linearToSrgb(0.0031308)).toBeCloseTo(0.04045, 5);
  });

  it('decodes mid-gray 0.5 to ~0.2140411 (and not 0.5^2.2 = 0.2176)', () => {
    expect(srgbToLinear(0.5)).toBeCloseTo(0.21404114, 7);
    expect(Math.abs(srgbToLinear(0.5) - Math.pow(0.5, 2.2))).toBeGreaterThan(1e-3);
  });

  it('round-trips across the range, including the threshold region', () => {
    for (let i = 0; i <= 255; i++) {
      const v = i / 255;
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 12);
    }
    for (const v of [0.0001, 0.001, 0.0031308, 0.01, 0.2, 0.9]) {
      expect(srgbToLinear(linearToSrgb(v))).toBeCloseTo(v, 12);
    }
  });

  it('clips out-of-range input (explicit gamut clipping)', () => {
    expect(linearToSrgb(-0.2)).toBe(0);
    expect(linearToSrgb(1.7)).toBe(1);
    expect(srgbToLinear(-1)).toBe(0);
    expect(srgbToLinear(2)).toBeCloseTo(1, 12);
  });
});
