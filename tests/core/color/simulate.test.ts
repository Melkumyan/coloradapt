import { describe, expect, it } from 'vitest';
import { simulateVision } from '@core/color';
import type { ColorValue } from '@domain/models';

const RED: ColorValue = { r: 1, g: 0, b: 0, alpha: 1 };

describe('simulateVision', () => {
  it('returns the original color for "normal" profile', () => {
    expect(simulateVision(RED, 'normal')).toEqual(RED);
  });

  it('returns the original color for "custom" profile', () => {
    expect(simulateVision(RED, 'custom')).toEqual(RED);
  });

  it('changes the color for protanopia', () => {
    const result = simulateVision(RED, 'protanopia');
    expect(result).not.toEqual(RED);
    expect(result.alpha).toBe(1);
  });

  it('applies partial severity for anomaly variants by default', () => {
    const full = simulateVision(RED, 'protanopia', 1);
    const partial = simulateVision(RED, 'protanomaly');
    // Partial severity should land strictly between the original and full effect.
    expect(partial.g).toBeGreaterThan(RED.g);
    expect(partial.g).toBeLessThan(full.g);
  });

  it('severity 0 is a no-op', () => {
    expect(simulateVision(RED, 'deuteranopia', 0)).toEqual(RED);
  });

  it('converts toward grayscale for achromatopsia', () => {
    const result = simulateVision(RED, 'achromatopsia', 1);
    expect(result.r).toBeCloseTo(result.g, 5);
    expect(result.g).toBeCloseTo(result.b, 5);
  });
});
