import { describe, expect, it } from 'vitest';
import {
  contrastFloor,
  ENGINEERING_THRESHOLDS,
  evaluateCandidate,
  findAdaptation,
  generateStage,
  searchStagesFor,
  type EvaluationContext,
  constraintsFor,
} from '@core/adaptation';
import { calculateContrast, convertColor, parseColor, toHex } from '@core/color';
import { simulatePair } from '@core/vision';
import type { AdaptationResult, ColorValue, VisionProfile } from '@domain/models';
import { VISION_PROFILES } from '@domain/models';

function color(css: string): ColorValue {
  const parsed = parseColor(css);
  if (!parsed) throw new Error(`bad color ${css}`);
  return parsed;
}

function adapt(
  fg: string,
  bg: string,
  profile: VisionProfile,
  extra: Partial<Parameters<typeof findAdaptation>[0]> = {},
): AdaptationResult {
  return findAdaptation({ foreground: color(fg), background: color(bg), profile, ...extra });
}

function assertAdapted(result: AdaptationResult) {
  if (result.status !== 'adapted') throw new Error(`expected adapted, got ${result.status}`);
  return result;
}

/** Invariants that must hold for EVERY result, whatever its status. */
function expectSafeOutput(result: AdaptationResult): void {
  const { outputColor } = result;
  for (const channel of [outputColor.r, outputColor.g, outputColor.b]) {
    expect(Number.isFinite(channel)).toBe(true);
    expect(channel).toBeGreaterThanOrEqual(0);
    expect(channel).toBeLessThanOrEqual(1);
    // On the 8-bit grid: what is evaluated is exactly what is applied.
    expect(Math.abs(channel * 255 - Math.round(channel * 255))).toBeLessThan(1e-9);
  }
  expect(outputColor.alpha).toBe(1);
  expect(result.stats.candidateCount).toBeLessThanOrEqual(
    ENGINEERING_THRESHOLDS.maxCandidateEvaluations,
  );

  if (result.status === 'adapted') {
    expect(result.adaptedContrast).toBeGreaterThanOrEqual(
      contrastFloor(result.originalContrast, ENGINEERING_THRESHOLDS.contrastRegressionTolerance) -
        1e-9,
    );
    expect(result.adaptedVisionAnalysis.simulatedDistance).toBeGreaterThan(
      result.originalVisionAnalysis.simulatedDistance,
    );
    expect(result.changeDistance).toBeLessThanOrEqual(
      ENGINEERING_THRESHOLDS.maxDesignChange + 1e-9,
    );
  } else {
    expect(outputColor).toEqual(result.originalColor);
  }
}

// Pairs from the M3 spec; expected behavior follows from the metrics, not from the names.
const REGRESSION_PAIRS: readonly [string, string, string][] = [
  ['red / green', '#d13b3b', '#2e8b2e'],
  ['red / green (alt)', '#c0392b', '#27ae60'],
  ['green / brown', '#2e8b2e', '#8b5a2b'],
  ['blue / purple', '#3355cc', '#7a3fa0'],
  ['cyan / gray', '#40c8c8', '#8a8a8a'],
  ['yellow / light green', '#e6e66a', '#b7e08a'],
  ['red / black', '#d13b3b', '#000000'],
  ['light gray / white', '#dddddd', '#ffffff'],
];

describe('findAdaptation — statuses', () => {
  it('leaves an already distinguishable pair unchanged without searching', () => {
    const result = adapt('#000000', '#ffffff', 'deuteranopia');
    expect(result.status).toBe('unchanged');
    expect(result.reason).toBe('already-distinguishable');
    expect(result.stats.candidateCount).toBe(0);
    expect(result.outputColor).toEqual(color('#000000'));
  });

  it('never adapts for normal vision', () => {
    const result = adapt('#dddddd', '#ffffff', 'normal');
    expect(result.status).toBe('unchanged');
    expect(result.reason).toBe('normal-vision');
  });

  it('adapts a pair that is hard to distinguish under the profile', () => {
    const result = assertAdapted(adapt('#c0392b', '#27ae60', 'deuteranopia'));
    expect(result.reason).toBe('improved');
    expect(toHex(result.outputColor)).not.toBe('#c0392b');
    expectSafeOutput(result);
  });

  it('improves simulated distance to the target using the M2 simulation', () => {
    const result = assertAdapted(adapt('#c0392b', '#27ae60', 'deuteranopia'));
    const check = simulatePair(result.outputColor, result.background, 'deuteranopia');
    expect(check.simulatedDistance).toBeCloseTo(result.adaptedVisionAnalysis.simulatedDistance, 10);
    expect(result.originalVisionAnalysis.simulatedDistance).toBeLessThan(
      ENGINEERING_THRESHOLDS.problemSimulatedDistance,
    );
    expect(check.simulatedDistance).toBeGreaterThanOrEqual(
      ENGINEERING_THRESHOLDS.targetSimulatedDistance,
    );
  });

  it('keeps the background untouched and reports it', () => {
    const bg = color('#27ae60');
    const result = adapt('#c0392b', '#27ae60', 'deuteranopia');
    expect(result.background).toEqual(bg);
  });

  it('returns no-safe-candidate (and the original) when the constraints cannot be met', () => {
    const result = adapt('#c0392b', '#27ae60', 'deuteranopia', {
      constraints: { maxDesignChange: 0.001 },
    });
    expect(result.status).toBe('no-safe-candidate');
    expect(result.reason).toBe('no-candidate-meets-constraints');
    expect(result.outputColor).toEqual(color('#c0392b'));
  });

  it('reports an exhausted structural budget instead of searching on', () => {
    const result = adapt('#c0392b', '#27ae60', 'deuteranopia', {
      constraints: { maxCandidateEvaluations: 5 },
    });
    expect(result.status).toBe('no-safe-candidate');
    expect(result.reason).toBe('search-budget-exhausted');
    expect(result.stats.candidateCount).toBe(5);
  });

  it('finds no safe candidate where an approximation model forbids a large edit', () => {
    // Real case: yellow on light green under the tritanomaly approximation.
    const result = adapt('#e6e66a', '#b7e08a', 'tritanomaly');
    expect(result.status).toBe('no-safe-candidate');
    expect(result.confidence).toBe('APPROXIMATION');
    expect(result.outputColor).toEqual(color('#e6e66a'));
  });

  it('refuses the custom profile', () => {
    const result = adapt('#c0392b', '#27ae60', 'custom');
    expect(result.status).toBe('unsupported');
    expect(result.reason).toBe('custom-profile-unsupported');
    expect(result.confidence).toBe('UNSUPPORTED');
    expect(result.stats.candidateCount).toBe(0);
    expect(result.outputColor).toEqual(color('#c0392b'));
  });

  it('refuses invalid or non-opaque input instead of guessing', () => {
    const nan = findAdaptation({
      foreground: { r: Number.NaN, g: 0, b: 0, alpha: 1 },
      background: color('#fff'),
      profile: 'deuteranopia',
    });
    const translucent = findAdaptation({
      foreground: { r: 0.5, g: 0.5, b: 0.5, alpha: 0.5 },
      background: color('#fff'),
      profile: 'deuteranopia',
    });
    expect(nan.status).toBe('unsupported');
    expect(nan.reason).toBe('invalid-color');
    expect(translucent.status).toBe('unsupported');
  });

  it('rejects an out-of-range strength', () => {
    expect(() => adapt('#c0392b', '#27ae60', 'deuteranopia', { strength: 1.5 })).toThrow(
      RangeError,
    );
    expect(() => adapt('#c0392b', '#27ae60', 'deuteranopia', { strength: Number.NaN })).toThrow(
      RangeError,
    );
  });
});

describe('findAdaptation — strength', () => {
  const args = ['#c0392b', '#27ae60', 'deuteranopia'] as const;

  it('strength 0 returns the original color exactly and does not search', () => {
    const result = adapt(...args, { strength: 0 });
    expect(result.status).toBe('unchanged');
    expect(result.reason).toBe('strength-zero');
    expect(result.outputColor).toBe(result.originalColor);
    expect(result.stats.candidateCount).toBe(0);
  });

  it('strength 1 returns the optimized candidate', () => {
    const result = assertAdapted(adapt(...args, { strength: 1 }));
    expect(result.outputColor).toBe(result.optimizedColor);
    expect(toHex(adapt(...args).outputColor)).toBe(toHex(result.outputColor));
  });

  it('strength 0.5 is a deterministic intermediate between original and optimized', () => {
    const full = assertAdapted(adapt(...args, { strength: 1 }));
    const half = assertAdapted(adapt(...args, { strength: 0.5 }));
    const again = assertAdapted(adapt(...args, { strength: 0.5 }));

    expect(toHex(half.outputColor)).toBe(toHex(again.outputColor));
    expect(toHex(half.outputColor)).not.toBe(toHex(full.outputColor));
    expect(toHex(half.outputColor)).not.toBe(toHex(half.originalColor));
    expect(half.changeDistance).toBeGreaterThan(0);
    expect(half.changeDistance).toBeLessThan(full.changeDistance);
    expect(half.optimizedColor).toEqual(full.optimizedColor);
    expectSafeOutput(half);
  });

  it('change distance grows monotonically with strength', () => {
    const distances = [0.25, 0.5, 0.75, 1].map(
      (strength) => assertAdapted(adapt(...args, { strength })).changeDistance,
    );
    for (let i = 1; i < distances.length; i += 1) {
      expect(distances[i]).toBeGreaterThan(distances[i - 1] ?? 0);
    }
  });

  it('a strength too small to change the 8-bit color reports no visible change', () => {
    const result = adapt(...args, { strength: 0.001 });
    expect(result.status).toBe('unchanged');
    expect(result.reason).toBe('below-visible-change');
  });
});

describe('findAdaptation — minimal change & hue preservation', () => {
  it('prefers a small edit over a maximally distant color', () => {
    const result = assertAdapted(adapt('#c0392b', '#27ae60', 'deuteranopia'));
    const toBlack = findAdaptation({
      foreground: color('#000000'),
      background: color('#27ae60'),
      profile: 'deuteranopia',
    });
    expect(toBlack.status).toBe('unchanged'); // black is far more distinguishable...
    // ...but the optimizer did not jump there: it stayed in the red family.
    expect(result.changeDistance).toBeLessThan(0.2);
    const original = convertColor(result.originalColor);
    const adapted = convertColor(result.outputColor);
    const hueShift = Math.abs(((adapted.h - original.h + 540) % 360) - 180);
    expect(hueShift).toBeLessThanOrEqual(20);
  });

  it('is the best-scoring feasible candidate of the first feasible stage', () => {
    const fg = color('#c0392b');
    const bg = color('#27ae60');
    const profile = 'deuteranopia';
    const result = assertAdapted(findAdaptation({ foreground: fg, background: bg, profile }));

    const constraints = constraintsFor('SUPPORTED_MODEL');
    const originalVision = simulatePair(fg, bg, profile);
    const context: EvaluationContext = {
      original: fg,
      background: bg,
      profile,
      severity: 1,
      confidence: 'SUPPORTED_MODEL',
      constraints,
      originalContrast: calculateContrast(fg, bg),
      originalVision,
    };
    const oklch = convertColor(fg);
    const stage = searchStagesFor(oklch)[0]!;
    const feasible = generateStage(stage, oklch, new Set([toHex(fg)]))
      .map((candidate) => evaluateCandidate(context, candidate.color))
      .filter((evaluation) => evaluation.rejection === null);

    expect(feasible.length).toBeGreaterThan(1);
    const bestScore = Math.max(...feasible.map((evaluation) => evaluation.breakdown.score));
    expect(result.score).toBeCloseTo(bestScore, 10);
    // Benefit saturates at the target, so "more distinguishable" is never rewarded for itself.
    for (const evaluation of feasible) expect(evaluation.breakdown.benefit).toBe(1);
  });

  it('stays within the first stage (no hue change) when lightness/chroma suffice', () => {
    expect(assertAdapted(adapt('#c0392b', '#27ae60', 'deuteranopia')).stats.stagesSearched).toBe(1);
  });
});

describe('findAdaptation — WCAG contrast guard', () => {
  it('floors never allow a drop below a tier the original met', () => {
    expect(contrastFloor(7, 0.05)).toBe(7);
    expect(contrastFloor(7.5, 0.05)).toBeCloseTo(7.125, 10);
    expect(contrastFloor(4.6, 0.05)).toBe(4.5);
    expect(contrastFloor(3.05, 0.05)).toBe(3);
    expect(contrastFloor(3.2, 0.05)).toBeCloseTo(3.04, 10);
    expect(contrastFloor(2, 0.05)).toBeCloseTo(1.9, 10);
    expect(contrastFloor(1, 0.05)).toBeCloseTo(0.95, 10);
  });

  it('rejects a candidate that improves CVD distance at the cost of contrast (7.0 -> 2.0)', () => {
    const fg = color('#595959'); // ~7:1 on white
    const bg = color('#ffffff');
    expect(calculateContrast(fg, bg)).toBeGreaterThan(6.9);
    const context: EvaluationContext = {
      original: fg,
      background: bg,
      profile: 'deuteranopia',
      severity: 1,
      confidence: 'SUPPORTED_MODEL',
      constraints: constraintsFor('SUPPORTED_MODEL'),
      originalContrast: calculateContrast(fg, bg),
      originalVision: simulatePair(fg, bg, 'deuteranopia'),
    };
    const lowContrast = color('#aaaaaa'); // ~2.3:1
    const evaluation = evaluateCandidate(context, lowContrast);
    expect(calculateContrast(lowContrast, bg)).toBeLessThan(3);
    expect(evaluation.rejection).toBe('contrast-regression');
  });

  it('never lowers contrast below the floor across the regression pairs and profiles', () => {
    for (const profile of VISION_PROFILES) {
      for (const [, fg, bg] of REGRESSION_PAIRS) {
        const result = adapt(fg, bg, profile);
        if (result.status === 'adapted') {
          expect(result.adaptedContrast).toBeGreaterThanOrEqual(
            contrastFloor(
              result.originalContrast,
              ENGINEERING_THRESHOLDS.contrastRegressionTolerance,
            ) - 1e-9,
          );
        }
      }
    }
  });
});

describe('findAdaptation — profile-specific behavior', () => {
  it('adapts the same pair differently (or not at all) per profile', () => {
    const outcomes = (['normal', 'protanopia', 'deuteranopia', 'tritanopia'] as const).map(
      (profile) => {
        const result = adapt('#d13b3b', '#2e8b2e', profile);
        return `${profile}:${result.status}:${toHex(result.outputColor)}`;
      },
    );
    expect(new Set(outcomes).size).toBe(4);
    expect(outcomes.find((o) => o.startsWith('normal'))).toContain('unchanged');
    expect(outcomes.find((o) => o.startsWith('deuteranopia'))).toContain('adapted');
  });

  it('picks different colors for protanopia and deuteranopia on blue / purple', () => {
    const protan = assertAdapted(adapt('#3355cc', '#7a3fa0', 'protanopia'));
    const deutan = assertAdapted(adapt('#3355cc', '#7a3fa0', 'deuteranopia'));
    expect(toHex(protan.outputColor)).not.toBe(toHex(deutan.outputColor));
    expect(protan.adaptedVisionAnalysis.profile).toBe('protanopia');
    expect(deutan.adaptedVisionAnalysis.profile).toBe('deuteranopia');
  });

  it('adapts light gray on white and the result differs from the original', () => {
    const result = assertAdapted(adapt('#dddddd', '#ffffff', 'protanopia'));
    expect(toHex(result.outputColor)).not.toBe('#dddddd');
  });
});

describe('findAdaptation — model confidence metadata', () => {
  it.each([
    ['protanopia', 'SUPPORTED_MODEL'],
    ['deuteranopia', 'SUPPORTED_MODEL'],
    ['tritanopia', 'SUPPORTED_MODEL'],
    ['protanomaly', 'MODEL_ASSUMPTION'],
    ['deuteranomaly', 'MODEL_ASSUMPTION'],
    ['tritanomaly', 'APPROXIMATION'],
    ['achromatopsia', 'APPROXIMATION'],
    ['custom', 'UNSUPPORTED'],
  ] as const)('%s result carries %s', (profile, expected) => {
    const results = [
      adapt('#dddddd', '#ffffff', profile), // adaptable when supported
      adapt('#000000', '#ffffff', profile), // unchanged
      adapt('#c0392b', '#27ae60', profile),
    ];
    for (const result of results) expect(result.confidence).toBe(expected);
  });

  it('keeps MODEL_ASSUMPTION on an adapted deuteranomaly result', () => {
    const result = adapt('#dddddd', '#ffffff', 'deuteranomaly');
    expect(result.status).toBe('adapted');
    expect(result.confidence).toBe('MODEL_ASSUMPTION');
  });

  it('keeps APPROXIMATION on an adapted achromatopsia result and applies a tighter cap', () => {
    const result = assertAdapted(adapt('#888888', '#8c8c8c', 'achromatopsia'));
    expect(result.confidence).toBe('APPROXIMATION');
    expect(result.changeDistance).toBeLessThanOrEqual(0.2 + 1e-9);
  });
});

describe('findAdaptation — neutrals, gamut and determinism', () => {
  it('keeps neutral input neutral and searches lightness only', () => {
    const result = assertAdapted(adapt('#888888', '#8c8c8c', 'deuteranopia'));
    const { r, g, b } = result.outputColor;
    expect(r).toBeCloseTo(g, 2);
    expect(g).toBeCloseTo(b, 2);
    expect(result.stats.stagesSearched).toBe(1);
  });

  it('does not invent a hue for black or white', () => {
    for (const [fg, bg] of [
      ['#111111', '#161616'],
      ['#eeeeee', '#f2f2f2'],
    ] as const) {
      const result = adapt(fg, bg, 'protanopia');
      if (result.status === 'adapted') {
        const { r, g, b } = result.outputColor;
        expect(Math.abs(r - g)).toBeLessThan(0.01);
        expect(Math.abs(g - b)).toBeLessThan(0.01);
      }
      expectSafeOutput(result);
    }
  });

  it('limits near-neutral colors to small hue shifts', () => {
    expect(searchStagesFor(convertColor(color('#888888')))).toEqual(['lightness-chroma']);
    expect(searchStagesFor({ l: 0.6, c: 0.03, h: 300, alpha: 1 })).toEqual([
      'lightness-chroma',
      'small-hue',
    ]);
    expect(searchStagesFor(convertColor(color('#c0392b')))).toEqual([
      'lightness-chroma',
      'small-hue',
      'wide-hue',
    ]);
  });

  it('produces valid, in-gamut, finite output for every pair/profile/strength', () => {
    for (const profile of VISION_PROFILES) {
      for (const [, fg, bg] of REGRESSION_PAIRS) {
        for (const strength of [0, 0.3, 0.7, 1]) {
          expectSafeOutput(adapt(fg, bg, profile, { strength }));
        }
      }
    }
  });

  it('is deterministic', () => {
    for (const [, fg, bg] of REGRESSION_PAIRS) {
      const a = adapt(fg, bg, 'deuteranopia', { strength: 0.7 });
      const b = adapt(fg, bg, 'deuteranopia', { strength: 0.7 });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it('never evaluates more than the structural budget', () => {
    for (const profile of VISION_PROFILES) {
      for (const [, fg, bg] of REGRESSION_PAIRS) {
        expect(adapt(fg, bg, profile).stats.candidateCount).toBeLessThanOrEqual(
          ENGINEERING_THRESHOLDS.maxCandidateEvaluations,
        );
      }
    }
  });
});

describe('findAdaptation — golden behavioral cases', () => {
  const cases: readonly [string, string, string, VisionProfile, 'adapted' | 'unchanged'][] = [
    ['red on green', '#c0392b', '#27ae60', 'deuteranopia', 'adapted'],
    ['green on brown', '#2e8b2e', '#8b5a2b', 'deuteranopia', 'adapted'],
    ['blue on purple', '#3355cc', '#7a3fa0', 'protanopia', 'adapted'],
    ['yellow on light green', '#e6e66a', '#b7e08a', 'protanopia', 'adapted'],
    ['red on black', '#d13b3b', '#000000', 'protanopia', 'unchanged'],
    ['black on white', '#000000', '#ffffff', 'protanopia', 'unchanged'],
    ['white on green button', '#ffffff', '#2e8b2e', 'deuteranopia', 'unchanged'],
  ];

  it.each(cases)('%s (%s on %s, %s)', (_name, fg, bg, profile, expected) => {
    const result = adapt(fg, bg, profile);
    expect(result.status).toBe(expected);
    expectSafeOutput(result);
    if (result.status === 'adapted') {
      expect(result.adaptedVisionAnalysis.simulatedDistance).toBeGreaterThanOrEqual(
        ENGINEERING_THRESHOLDS.targetSimulatedDistance,
      );
    }
  });
});
