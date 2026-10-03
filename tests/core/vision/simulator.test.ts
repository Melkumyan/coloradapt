import { describe, expect, it } from 'vitest';
import type { ColorValue, VisionProfile } from '@domain/models';
import { VISION_PROFILES, VISION_PROFILE_INFO } from '@domain/models';
import {
  DEFAULT_VISION_MODEL_POLICY,
  createVisionSimulator,
  defaultVisionSimulator,
  simulateVision,
} from '@core/vision';

const c = (r: number, g: number, b: number, alpha = 1): ColorValue => ({ r, g, b, alpha });
const BLACK = c(0, 0, 0);
const WHITE = c(1, 1, 1);
const RED = c(1, 0, 0);
const GREEN = c(0, 1, 0);
const BLUE = c(0, 0, 1);
const GRAY = c(0.5, 0.5, 0.5);

const SIMULATED: VisionProfile[] = [
  'protanopia',
  'protanomaly',
  'deuteranopia',
  'deuteranomaly',
  'tritanopia',
  'tritanomaly',
  'achromatopsia',
];

const SAMPLES = [
  BLACK,
  WHITE,
  RED,
  GREEN,
  BLUE,
  c(0, 1, 1),
  c(1, 0, 1),
  c(1, 1, 0),
  GRAY,
  c(0.2, 0.4, 0.8),
  c(0.93, 0.12, 0.55),
];

function channels(x: ColorValue): number[] {
  return [x.r, x.g, x.b];
}

function expectClose(a: ColorValue, b: ColorValue, tol: number): void {
  channels(a).forEach((v, i) => expect(Math.abs(v - channels(b)[i]!)).toBeLessThanOrEqual(tol));
}

describe('identity invariants', () => {
  it('normal vision returns the input for any severity', () => {
    for (const s of [0, 0.3, 1]) {
      for (const x of SAMPLES) expectClose(simulateVision(x, 'normal', s), x, 1e-12);
    }
  });

  it('custom is explicitly unsupported and acts as identity', () => {
    expectClose(simulateVision(RED, 'custom'), RED, 1e-12);
    expect(defaultVisionSimulator.modelFor('custom')).toBe('identity');
    expect(defaultVisionSimulator.modelFor('normal')).toBe('identity');
  });

  it('severity 0 is identity for every simulated profile', () => {
    for (const p of SIMULATED) {
      for (const x of SAMPLES) expectClose(simulateVision(x, p, 0), x, 1e-12);
    }
  });
});

describe('severity semantics', () => {
  it('rejects severities outside [0, 1] and non-finite values (fail fast)', () => {
    for (const bad of [-0.01, 1.01, NaN, Infinity, -Infinity]) {
      expect(() => simulateVision(RED, 'protanopia', bad)).toThrow(RangeError);
      expect(() => simulateVision(RED, 'normal', bad)).toThrow(RangeError);
    }
  });

  it('accepts the exact bounds', () => {
    expect(() => simulateVision(RED, 'protanopia', 0)).not.toThrow();
    expect(() => simulateVision(RED, 'protanopia', 1)).not.toThrow();
  });

  it('uses the profile default when severity is omitted (1 for dichromacy, 0.5 for anomalies)', () => {
    for (const p of SIMULATED) {
      const explicit = simulateVision(RED, p, VISION_PROFILE_INFO[p].defaultSeverity);
      expectClose(simulateVision(RED, p), explicit, 0);
    }
  });

  it('severity 1 on an anomaly profile reaches (near) the dichromat result', () => {
    // Machado 2009 at 1.0 is documented as equivalent to dichromacy; it is a different
    // model than Brettel, so only a loose agreement is asserted (measured max ~0.16 for the sample set).
    for (const pair of [
      ['protanomaly', 'protanopia'],
      ['deuteranomaly', 'deuteranopia'],
    ] as const) {
      for (const x of SAMPLES) {
        expectClose(simulateVision(x, pair[0], 1), simulateVision(x, pair[1], 1), 0.2);
      }
    }
  });

  it('intermediate severity moves monotonically away from the input', () => {
    for (const p of SIMULATED) {
      const dist = (s: number): number => {
        const o = simulateVision(RED, p, s);
        return Math.abs(o.r - 1) + Math.abs(o.g) + Math.abs(o.b);
      };
      expect(dist(0.25)).toBeGreaterThan(dist(0));
      expect(dist(0.5)).toBeGreaterThan(dist(0.25));
      expect(dist(1)).toBeGreaterThan(dist(0.5));
    }
  });
});

describe('alpha, range, finiteness, determinism', () => {
  it('preserves alpha and drops the stale source string', () => {
    for (const p of VISION_PROFILES) {
      const out = simulateVision({ ...RED, alpha: 0.37, source: 'rgba(255,0,0,.37)' }, p, 0.8);
      expect(out.alpha).toBe(0.37);
      expect(out.source).toBeUndefined();
    }
  });

  it('always returns finite channels within [0, 1]', () => {
    for (const p of VISION_PROFILES) {
      for (const x of SAMPLES) {
        for (const s of [0, 0.1, 0.5, 0.999, 1]) {
          for (const v of channels(simulateVision(x, p, s))) {
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('is deterministic and does not mutate its input', () => {
    const input = Object.freeze(c(0.3, 0.6, 0.9));
    for (const p of SIMULATED) {
      expect(simulateVision(input, p, 0.7)).toEqual(simulateVision(input, p, 0.7));
    }
  });

  it('rejects non-finite channels but clamps finite out-of-range ones', () => {
    expect(() => simulateVision(c(NaN, 0, 0), 'protanopia')).toThrow(RangeError);
    expect(() => simulateVision(c(0, Infinity, 0), 'protanopia')).toThrow(RangeError);
    expectClose(
      simulateVision(c(1.4, -0.2, 0.5), 'protanopia'),
      simulateVision(c(1, 0, 0.5), 'protanopia'),
      0,
    );
  });
});

describe('fixed points', () => {
  it('black stays black and white stays white for every profile (within 1e-4)', () => {
    for (const p of VISION_PROFILES) {
      expectClose(simulateVision(BLACK, p), BLACK, 1e-12);
      expectClose(simulateVision(WHITE, p), WHITE, 1e-4);
    }
  });

  it('neutral gray stays (near) neutral gray for every profile', () => {
    for (const p of VISION_PROFILES) expectClose(simulateVision(GRAY, p, 1), GRAY, 5e-4);
  });
});

describe('gamut handling', () => {
  it('clips out-of-gamut projections instead of overflowing', () => {
    // Pure sRGB blue projected by Brettel deutan lands outside the sRGB gamut in linear
    // light for some channels; the output must still be a valid sRGB triple.
    for (const p of SIMULATED) {
      for (const x of [RED, GREEN, BLUE, c(0, 1, 1), c(1, 0, 1)]) {
        const out = simulateVision(x, p, 1);
        for (const v of channels(out)) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('clips exactly where the linear projection leaves the gamut', () => {
    // Reference linear outputs (DaltonLens): protan green -> R = 1.1955 (>1), protan blue -> R = -0.3074 (<0).
    expect(simulateVision(GREEN, 'protanopia', 1).r).toBe(1);
    expect(simulateVision(BLUE, 'protanopia', 1).r).toBe(0);
  });
});

describe('achromatopsia approximation', () => {
  it('produces neutral gray whose linear value is the Rec. 709 luminance', () => {
    const out = simulateVision(RED, 'achromatopsia', 1);
    expect(out.r).toBeCloseTo(out.g, 12);
    expect(out.g).toBeCloseTo(out.b, 12);
    // Independent expectation: encode(0.2126) with the sRGB formula.
    const expected = 1.055 * Math.pow(0.2126, 1 / 2.4) - 0.055;
    expect(out.r).toBeCloseTo(expected, 9);
  });

  it('is marked as an approximation, distinct from published models', () => {
    expect(defaultVisionSimulator.modelFor('achromatopsia')).toBe('luminance-approximation');
  });

  it('does not use the old gamma-space luma weights', () => {
    const old = 0.299 * 0 + 0.587 * 1 + 0.114 * 0; // gray of green under the M1 heuristic
    expect(Math.abs(simulateVision(GREEN, 'achromatopsia', 1).r - old)).toBeGreaterThan(0.05);
  });
});

describe('model policy', () => {
  it('uses the documented default model per profile', () => {
    expect(DEFAULT_VISION_MODEL_POLICY).toEqual({
      protanopia: 'brettel1997',
      deuteranopia: 'brettel1997',
      tritanopia: 'brettel1997',
      protanomaly: 'machado2009',
      deuteranomaly: 'machado2009',
      tritanomaly: 'brettel1997-interpolated',
      achromatopsia: 'luminance-approximation',
    });
    for (const p of SIMULATED) {
      expect(defaultVisionSimulator.modelFor(p)).toBe(
        DEFAULT_VISION_MODEL_POLICY[p as 'protanopia'],
      );
    }
  });

  it('tritanomaly is labeled as an interpolated approximation, not a validated model', () => {
    expect(defaultVisionSimulator.modelFor('tritanomaly')).toBe('brettel1997-interpolated');
  });

  it('models are replaceable via policy', () => {
    const vienot = createVisionSimulator({ protanopia: 'vienot1999' });
    expect(vienot.modelFor('protanopia')).toBe('vienot1999');
    const a = vienot.simulate(RED, 'protanopia');
    const b = defaultVisionSimulator.simulate(RED, 'protanopia');
    expectClose(a, b, 0.15); // same family of projection, different plane construction
    expect(a).not.toEqual(b);
  });

  it('refuses unsupported or unknown model assignments', () => {
    expect(() => createVisionSimulator({ tritanopia: 'vienot1999' })).toThrow(RangeError);
    expect(() => createVisionSimulator({ protanopia: 'luminance-approximation' })).not.toThrow();
    expect(() => createVisionSimulator({ protanopia: 'nope' as never })).toThrow(RangeError);
  });
});

describe('default engine regression (M2 replaces the M1 heuristic)', () => {
  it('protanopia of pure red is the Brettel 1997 result, not the old 3x3 on gamma values', () => {
    const out = simulateVision(RED, 'protanopia', 1);
    // Independent expectation from DaltonLens-Python (reference-vectors.json: brettel1997 protan, red).
    expect(out.r).toBeCloseTo(0.4233, 3);
    expect(out.g).toBeCloseTo(0.3618, 3);
    // The M1 heuristic produced (0.567, 0.558, 0).
    expect(Math.abs(out.r - 0.567)).toBeGreaterThan(0.1);
  });

  it('exposes one production entry point', async () => {
    const color = await import('@core/color');
    expect('simulateVision' in color).toBe(false);
  });
});
