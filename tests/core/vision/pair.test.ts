import { describe, expect, it } from 'vitest';
import type { ColorValue } from '@domain/models';
import { calculateContrast, calculatePerceptualDistance } from '@core/color';
import { detectColorConflict } from '@core/conflicts';
import { simulatePair, simulateVision } from '@core/vision';

const c = (r: number, g: number, b: number): ColorValue => ({ r, g, b, alpha: 1 });
const RED = c(1, 0, 0);
const GREEN = c(0, 0.6, 0);
const WHITE = c(1, 1, 1);

describe('simulatePair', () => {
  it('returns originals, simulations, distances and loss', () => {
    const a = simulatePair(RED, GREEN, 'deuteranopia');
    expect(a.profile).toBe('deuteranopia');
    expect(a.severity).toBe(1);
    expect(a.model).toBe('brettel1997');
    expect(a.originalForeground).toBe(RED);
    expect(a.originalBackground).toBe(GREEN);
    expect(a.simulatedForeground).toEqual(simulateVision(RED, 'deuteranopia'));
    expect(a.simulatedBackground).toEqual(simulateVision(GREEN, 'deuteranopia'));
    expect(a.originalDistance).toBeCloseTo(calculatePerceptualDistance(RED, GREEN), 12);
    expect(a.simulatedDistance).toBeCloseTo(
      calculatePerceptualDistance(a.simulatedForeground, a.simulatedBackground),
      12,
    );
    expect(a.distanceLoss).toBeCloseTo(a.originalDistance - a.simulatedDistance, 12);
  });

  it('red/green loses distinguishability for deuteranopia and protanopia, not for normal vision', () => {
    expect(simulatePair(RED, GREEN, 'deuteranopia').distanceLoss).toBeGreaterThan(0.1);
    expect(simulatePair(RED, GREEN, 'protanopia').distanceLoss).toBeGreaterThan(0.1);
    expect(Math.abs(simulatePair(RED, GREEN, 'normal').distanceLoss)).toBeLessThan(1e-12);
  });

  it('applies the severity and validates it', () => {
    const half = simulatePair(RED, GREEN, 'deuteranopia', 0.5);
    const full = simulatePair(RED, GREEN, 'deuteranopia', 1);
    expect(half.severity).toBe(0.5);
    expect(half.simulatedDistance).toBeGreaterThan(full.simulatedDistance);
    expect(() => simulatePair(RED, GREEN, 'deuteranopia', 2)).toThrow(RangeError);
  });

  it('reports the profile default severity for anomalies', () => {
    expect(simulatePair(RED, GREEN, 'protanomaly').severity).toBe(0.5);
    expect(simulatePair(RED, GREEN, 'protanomaly').model).toBe('machado2009');
  });
});

describe('perceptual distance is independent of the simulator', () => {
  it('is a symmetric continuous metric, zero for identical colors', () => {
    expect(calculatePerceptualDistance(RED, RED)).toBeCloseTo(0, 12);
    expect(calculatePerceptualDistance(RED, GREEN)).toBeCloseTo(
      calculatePerceptualDistance(GREEN, RED),
      12,
    );
  });
});

describe('WCAG contrast stays separate from CVD distinguishability', () => {
  it('conflict.contrast is the WCAG ratio of the ORIGINAL colors regardless of profile', () => {
    const pair = { foreground: RED, background: GREEN };
    const wcag = calculateContrast(RED, GREEN);
    for (const profile of ['protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia'] as const) {
      const conflict = detectColorConflict('e', pair, profile);
      if (conflict) expect(conflict.contrast).toBeCloseTo(wcag, 12);
    }
  });

  it('a pair with fine WCAG contrast can still lose color distance under simulation', () => {
    const analysis = simulatePair(c(0.8, 0.3, 0.3), c(0.3, 0.55, 0.3), 'deuteranopia');
    expect(analysis.distanceLoss).toBeGreaterThan(0);
  });
});

describe('integration with conflict analysis', () => {
  it('detectColorConflict carries a VisionAnalysis from the production engine', () => {
    const conflict = detectColorConflict(
      'el',
      { foreground: c(0.85, 0.85, 0.85), background: WHITE },
      'protanopia',
    );
    expect(conflict).not.toBeNull();
    expect(conflict!.vision.model).toBe('brettel1997');
    expect(conflict!.vision.profile).toBe('protanopia');
    expect(conflict!.vision.simulatedForeground).toEqual(
      simulateVision(c(0.85, 0.85, 0.85), 'protanopia'),
    );
  });

  it('normal vision reports no distinguishability loss', () => {
    const conflict = detectColorConflict(
      'el',
      { foreground: c(0.85, 0.85, 0.85), background: WHITE },
      'normal',
    );
    expect(Math.abs(conflict?.vision.distanceLoss ?? 0)).toBeLessThan(1e-12);
  });

  it('forwards an explicit severity', () => {
    const conflict = detectColorConflict(
      'el',
      { foreground: c(0.85, 0.85, 0.85), background: WHITE },
      'protanomaly',
      0.3,
    );
    expect(conflict?.vision.severity).toBe(0.3);
  });
});
