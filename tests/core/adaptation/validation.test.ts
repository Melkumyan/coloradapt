import { describe, expect, it } from 'vitest';
import {
  constraintsFor,
  createAdaptationPlan,
  evaluateCandidate,
  findAdaptation,
  generateStage,
  oklchToValidColor,
  searchStagesFor,
  type EvaluationContext,
} from '@core/adaptation';
import { calculateContrast, convertColor, parseColor, toHex } from '@core/color';
import { simulatePair } from '@core/vision';
import {
  DEFAULT_USER_SETTINGS,
  VISION_PROFILE_CONFIDENCE,
  type AnalysisResult,
  type ColorValue,
  type ElementDescriptor,
  type ModelConfidence,
  type VisionProfile,
} from '@domain/models';
import { ADAPTATION_PAIRS } from '../../benchmarks/adaptation-pairs';

/** M3.R1 validation: properties of the optimizer that the browser relies on. */

function color(css: string): ColorValue {
  const parsed = parseColor(css);
  if (!parsed) throw new Error(`bad color ${css}`);
  return { ...parsed, alpha: 1 };
}

function contextFor(fg: ColorValue, bg: ColorValue, profile: VisionProfile): EvaluationContext {
  const confidence = VISION_PROFILE_CONFIDENCE[profile];
  return {
    original: fg,
    background: bg,
    profile,
    severity: 1,
    confidence,
    constraints: constraintsFor(confidence),
    originalContrast: calculateContrast(fg, bg),
    originalVision: simulatePair(fg, bg, profile, 1),
  };
}

const DICHROMATS: readonly VisionProfile[] = ['protanopia', 'deuteranopia', 'tritanopia'];

describe('minimal change: constraint satisfaction first, then smallest design change', () => {
  it('stops at the first stage that has any feasible candidate, for every benchmark pair', () => {
    for (const profile of DICHROMATS) {
      for (const pair of ADAPTATION_PAIRS) {
        const fg = color(pair.foreground);
        const bg = color(pair.background);
        const result = findAdaptation({ foreground: fg, background: bg, profile });
        if (result.status !== 'adapted') continue;

        // Independent re-derivation of "first stage with a feasible candidate".
        const context = contextFor(fg, bg, profile);
        const oklch = convertColor(fg);
        const seen = new Set([toHex(fg)]);
        const stages = searchStagesFor(oklch);
        let firstFeasible = -1;
        stages.forEach((stage, index) => {
          const candidates = generateStage(stage, oklch, seen);
          if (
            firstFeasible < 0 &&
            candidates.some((c) => evaluateCandidate(context, c.color).rejection === null)
          ) {
            firstFeasible = index;
          }
        });
        expect(result.stats.stagesSearched, `${profile}/${pair.id}`).toBe(firstFeasible + 1);
      }
    }
  });

  it('does not pick a later-stage candidate just because it has a higher raw CVD distance', () => {
    const fg = color('#c0392b');
    const bg = color('#27ae60');
    const profile = 'deuteranopia';
    const result = findAdaptation({ foreground: fg, background: bg, profile });
    if (result.status !== 'adapted') throw new Error('expected adapted');

    const context = contextFor(fg, bg, profile);
    const oklch = convertColor(fg);
    const seen = new Set([toHex(fg)]);
    const [first, ...later] = searchStagesFor(oklch);
    generateStage(first!, oklch, seen);
    const laterFeasible = later
      .flatMap((stage) => generateStage(stage, oklch, seen))
      .map((c) => evaluateCandidate(context, c.color))
      .filter((e) => e.rejection === null);

    // There ARE feasible later-stage candidates, and some are more distinguishable...
    expect(laterFeasible.length).toBeGreaterThan(0);
    const farthest = laterFeasible.reduce((a, b) =>
      b.vision.simulatedDistance > a.vision.simulatedDistance ? b : a,
    );
    expect(farthest.vision.simulatedDistance).toBeGreaterThan(
      result.adaptedVisionAnalysis.simulatedDistance,
    );
    // ...yet the chosen one is the smaller edit from the first stage.
    expect(result.stats.stagesSearched).toBe(1);
    expect(result.changeDistance).toBeLessThan(farthest.changeDistance);
    expect(toHex(result.outputColor)).not.toBe(toHex(farthest.color));
  });

  it('among feasible candidates of the winning stage, none has a smaller weighted design change at an equal or better score', () => {
    const fg = color('#2e8b57');
    const bg = color('#8b6914');
    const profile = 'protanopia';
    const result = findAdaptation({ foreground: fg, background: bg, profile });
    if (result.status !== 'adapted') throw new Error('expected adapted');

    const context = contextFor(fg, bg, profile);
    const oklch = convertColor(fg);
    const stage = searchStagesFor(oklch)[0]!;
    const feasible = generateStage(stage, oklch, new Set([toHex(fg)]))
      .map((c) => evaluateCandidate(context, c.color))
      .filter((e) => e.rejection === null);
    const chosen = feasible.find((e) => toHex(e.color) === toHex(result.optimizedColor))!;
    expect(chosen).toBeDefined();
    for (const other of feasible) {
      expect(other.breakdown.score).toBeLessThanOrEqual(chosen.breakdown.score + 1e-12);
    }
  });
});

describe('quantization: the evaluated color is the applied color', () => {
  it('every generated candidate is already on the 8-bit grid', () => {
    for (const pair of ADAPTATION_PAIRS) {
      const oklch = convertColor(color(pair.foreground));
      const seen = new Set<string>();
      for (const stage of searchStagesFor(oklch)) {
        for (const candidate of generateStage(stage, oklch, seen)) {
          for (const channel of [candidate.color.r, candidate.color.g, candidate.color.b]) {
            expect(Math.abs(channel * 255 - Math.round(channel * 255))).toBeLessThan(1e-9);
          }
        }
      }
    }
  });

  it('an adapted result re-evaluates identically after a hex round trip (what CSS receives)', () => {
    for (const profile of DICHROMATS) {
      for (const strength of [0.25, 0.5, 0.75, 1]) {
        for (const pair of ADAPTATION_PAIRS) {
          const fg = color(pair.foreground);
          const bg = color(pair.background);
          const result = findAdaptation({ foreground: fg, background: bg, profile, strength });
          if (result.status !== 'adapted') continue;

          const applied = color(toHex(result.outputColor));
          expect(applied).toMatchObject({
            r: result.outputColor.r,
            g: result.outputColor.g,
            b: result.outputColor.b,
          });
          expect(calculateContrast(applied, bg)).toBeCloseTo(result.adaptedContrast, 10);
          expect(simulatePair(applied, bg, profile, 1).simulatedDistance).toBeCloseTo(
            result.adaptedVisionAnalysis.simulatedDistance,
            10,
          );
        }
      }
    }
  });

  it('a floating-point color can be safe while its 8-bit rounding is not — and only the rounded one is ever used', () => {
    const fg = color('#c0392b');
    const bg = color('#27ae60');
    const profile = 'deuteranopia';
    const context = contextFor(fg, bg, profile);
    const base = convertColor(fg);

    // Scan lightness finely for a spot where float and quantized feasibility disagree.
    let flip: { l: number; floatSafe: boolean; quantizedSafe: boolean } | null = null;
    for (let step = -3000; step <= 3000 && !flip; step += 1) {
      const l = base.l + step / 10000;
      const quantized = oklchToValidColor(l, base.c, base.h);
      if (!quantized) continue;
      const exact = oklchToFloatColor(l, base.c, base.h);
      if (!exact) continue;
      const floatSafe = evaluateCandidate(context, exact).rejection === null;
      const quantizedSafe = evaluateCandidate(context, quantized).rejection === null;
      if (floatSafe !== quantizedSafe) flip = { l, floatSafe, quantizedSafe };
    }
    expect(flip, 'expected at least one float/8-bit disagreement on this pair').not.toBeNull();

    // The optimizer's answer is judged on the rounded color, so the reported
    // metrics are those of exactly what CSS will receive.
    const result = findAdaptation({ foreground: fg, background: bg, profile });
    if (result.status !== 'adapted') throw new Error('expected adapted');
    const verdict = evaluateCandidate(context, result.outputColor);
    expect(verdict.rejection).toBeNull();
    expect(verdict.contrast).toBeCloseTo(result.adaptedContrast, 12);
  });
});

describe('strength interpolation is safe and explainable', () => {
  it('every intermediate result passes the same checks as a full-strength one, or is no-safe-candidate with a reason', () => {
    for (const profile of DICHROMATS) {
      for (const strength of [0.25, 0.5, 0.75]) {
        for (const pair of ADAPTATION_PAIRS) {
          const fg = color(pair.foreground);
          const bg = color(pair.background);
          const result = findAdaptation({ foreground: fg, background: bg, profile, strength });
          const again = findAdaptation({ foreground: fg, background: bg, profile, strength });
          expect(again).toEqual(result); // stable

          if (result.status === 'no-safe-candidate') {
            expect(result.reason).toBe('strength-interpolation-unsafe');
            expect(toHex(result.outputColor)).toBe(toHex(fg));
          }
          if (result.status === 'unchanged') {
            expect(toHex(result.outputColor)).toBe(toHex(fg));
          }
        }
      }
    }
  });
});

describe('model confidence propagates end to end', () => {
  const EXPECTED: ReadonlyArray<[VisionProfile, ModelConfidence]> = [
    ['protanopia', 'SUPPORTED_MODEL'],
    ['deuteranopia', 'SUPPORTED_MODEL'],
    ['tritanopia', 'SUPPORTED_MODEL'],
    ['protanomaly', 'MODEL_ASSUMPTION'],
    ['deuteranomaly', 'MODEL_ASSUMPTION'],
    ['tritanomaly', 'APPROXIMATION'],
    ['achromatopsia', 'APPROXIMATION'],
    ['custom', 'UNSUPPORTED'],
  ];

  function descriptor(id: string): ElementDescriptor {
    return {
      id,
      tagName: 'p',
      role: 'text',
      colorPair: { foreground: color('#c0392b'), background: color('#27ae60') },
      backgroundKind: 'solid',
      analysisStatus: 'resolved',
      isVisible: true,
      hasTextContent: true,
    };
  }
  const analysis: AnalysisResult = {
    url: 'https://example.com',
    timestamp: 0,
    elements: [descriptor('a'), descriptor('b')],
    conflicts: [],
    truncated: false,
    unresolvedCount: 0,
  };

  it.each(EXPECTED)('%s -> %s in the result, every change and the plan', (profile, confidence) => {
    const fg = color('#c0392b');
    const bg = color('#27ae60');
    const result = findAdaptation({ foreground: fg, background: bg, profile });
    expect(result.confidence).toBe(confidence);

    const plan = createAdaptationPlan(analysis, {
      ...DEFAULT_USER_SETTINGS,
      visionProfile: profile,
      adaptationStrength: 1,
    });
    expect(plan.confidence).toBe(confidence);
    for (const change of plan.changes) expect(change.confidence).toBe(confidence);
    if (confidence === 'UNSUPPORTED') {
      expect(plan.changes).toHaveLength(0);
      expect(result.status).toBe('unsupported');
    }
  });

  it('keeps the vision-analysis provenance for anomalies (Machado) and approximations', () => {
    const fg = color('#c0392b');
    const bg = color('#27ae60');
    const model = (profile: VisionProfile) =>
      findAdaptation({ foreground: fg, background: bg, profile }).status === 'unsupported'
        ? null
        : (
            findAdaptation({ foreground: fg, background: bg, profile }) as {
              originalVisionAnalysis: { model: string };
            }
          ).originalVisionAnalysis.model;
    expect(model('deuteranopia')).not.toBe('machado2009');
    expect(model('deuteranomaly')).toBe('machado2009');
    expect(model('tritanomaly')).toBe('brettel1997-interpolated');
    expect(model('custom')).toBeNull();
  });
});

/** Un-quantized sRGB color for an in-gamut OKLCH value (test-only; the product never uses one). */
function oklchToFloatColor(l: number, c: number, h: number): ColorValue | null {
  const quantized = oklchToValidColor(l, c, h);
  if (!quantized) return null;
  const hue = (h * Math.PI) / 180;
  const a = c * Math.cos(hue);
  const b = c * Math.sin(hue);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const enc = (x: number): number =>
    x <= 0.0031308 ? 12.92 * x : 1.055 * Math.max(0, x) ** (1 / 2.4) - 0.055;
  const rgb = lin.map(enc);
  if (rgb.some((v) => v < 0 || v > 1)) return null;
  return { r: rgb[0]!, g: rgb[1]!, b: rgb[2]!, alpha: 1 };
}
