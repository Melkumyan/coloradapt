import { converter } from 'culori';
import type {
  AdaptationResult,
  ColorValue,
  ModelConfidence,
  SearchStats,
  VisionAnalysis,
  VisionProfile,
} from '@domain/models';
import { VISION_PROFILE_CONFIDENCE, VISION_PROFILE_INFO } from '@domain/models';
import { calculateContrast, convertColor, toHex } from '@core/color';
import { simulatePair } from '@core/vision';
import {
  evaluateCandidate,
  type CandidateEvaluation,
  type EvaluationContext,
} from './candidate-evaluator';
import { generateStage, searchStagesFor } from './candidate-generator';
import { constraintsFor, contrastFloor, type AdaptationConstraints } from './constraints';
import { oklabToValidColor } from './gamut';

const toOklab = converter('oklab');

export interface FindAdaptationInput {
  /** Effective, opaque foreground (from M1 analysis). */
  readonly foreground: ColorValue;
  /** Effective, opaque, solid background. It is never modified. */
  readonly background: ColorValue;
  readonly profile: VisionProfile;
  /** Vision model severity in [0, 1]; defaults to the profile's default. */
  readonly severity?: number;
  /** Adaptation strength in [0, 1]; defaults to 1 (full optimizer-selected adaptation). */
  readonly strength?: number;
  readonly constraints?: Partial<AdaptationConstraints>;
  /** Precomputed M2 analysis of the original pair; computed when omitted. */
  readonly originalVisionAnalysis?: VisionAnalysis;
}

const NO_SEARCH: SearchStats = { candidateCount: 0, stagesSearched: 0 };

function isValidOpaqueColor(color: ColorValue): boolean {
  return [color.r, color.g, color.b, color.alpha].every(Number.isFinite) && color.alpha === 1;
}

/** Orders evaluations: higher score, then smaller design change, then hex (total, deterministic). */
function compareEvaluations(a: CandidateEvaluation, b: CandidateEvaluation): number {
  return (
    b.breakdown.score - a.breakdown.score ||
    a.weightedChange - b.weightedChange ||
    toHex(a.color).localeCompare(toHex(b.color))
  );
}

/**
 * Interpolates original -> optimized in OKLab (perceptually uniform, no hue
 * wrap-around), never in gamma-encoded RGB. `t = 1` returns the optimized
 * color itself.
 */
function interpolateInOklab(from: ColorValue, to: ColorValue, t: number): ColorValue | null {
  if (t >= 1) return to;
  const a = toOklab({ mode: 'rgb', r: from.r, g: from.g, b: from.b });
  const b = toOklab({ mode: 'rgb', r: to.r, g: to.g, b: to.b });
  return oklabToValidColor(
    a.l + (b.l - a.l) * t,
    (a.a ?? 0) + ((b.a ?? 0) - (a.a ?? 0)) * t,
    (a.b ?? 0) + ((b.b ?? 0) - (a.b ?? 0)) * t,
  );
}

/**
 * Finds the smallest perceptual modification of `foreground`, against a
 * fixed `background`, that:
 *  1. raises the simulated (M2) distinguishability to the target;
 *  2. does not materially regress WCAG contrast;
 *  3. stays in valid sRGB and within the design-change cap;
 *  4. respects the configured adaptation strength.
 *
 * Deterministic, bounded (structural evaluation budget, no wall clock), and
 * fail-safe: when nothing satisfies the constraints the result is
 * `no-safe-candidate` and the original color stays the output.
 * Pure TypeScript — see docs/ADAPTATION_ENGINE.md.
 */
export function findAdaptation(input: FindAdaptationInput): AdaptationResult {
  const { foreground, background, profile } = input;
  const severity = input.severity ?? VISION_PROFILE_INFO[profile].defaultSeverity;
  const strength = input.strength ?? 1;
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
    throw new RangeError(`Adaptation strength must be a number in [0, 1], got ${String(strength)}`);
  }
  const confidence: ModelConfidence = VISION_PROFILE_CONFIDENCE[profile];

  const base = {
    originalColor: foreground,
    background,
    profile,
    severity,
    confidence,
    outputColor: foreground,
  };

  if (!isValidOpaqueColor(foreground) || !isValidOpaqueColor(background)) {
    return { ...base, status: 'unsupported', reason: 'invalid-color', stats: NO_SEARCH };
  }
  if (confidence === 'UNSUPPORTED') {
    return {
      ...base,
      status: 'unsupported',
      reason: 'custom-profile-unsupported',
      stats: NO_SEARCH,
    };
  }

  const constraints = constraintsFor(confidence, input.constraints);
  const originalVision =
    input.originalVisionAnalysis ?? simulatePair(foreground, background, profile, severity);
  const originalContrast = calculateContrast(foreground, background);
  const analyzed = { ...base, originalContrast, originalVisionAnalysis: originalVision };

  // Early exits: no search is run.
  if (profile === 'normal') {
    return { ...analyzed, status: 'unchanged', reason: 'normal-vision', stats: NO_SEARCH };
  }
  if (strength === 0) {
    return { ...analyzed, status: 'unchanged', reason: 'strength-zero', stats: NO_SEARCH };
  }
  if (originalVision.simulatedDistance >= constraints.problemSimulatedDistance) {
    return {
      ...analyzed,
      status: 'unchanged',
      reason: 'already-distinguishable',
      stats: NO_SEARCH,
    };
  }

  // Bounded, progressive search; stops at the first stage with a feasible candidate.
  const context: EvaluationContext = {
    original: foreground,
    background,
    profile,
    severity,
    confidence,
    constraints,
    originalContrast,
    originalVision,
  };
  const originalOklch = convertColor(foreground);
  const seen = new Set<string>([toHex(foreground)]);
  let candidateCount = 0;
  let stagesSearched = 0;
  let budgetExhausted = false;
  let best: CandidateEvaluation | null = null;

  for (const stage of searchStagesFor(originalOklch)) {
    stagesSearched += 1;
    const feasible: CandidateEvaluation[] = [];
    for (const candidate of generateStage(stage, originalOklch, seen)) {
      if (candidateCount >= constraints.maxCandidateEvaluations) {
        budgetExhausted = true;
        break;
      }
      candidateCount += 1;
      const evaluation = evaluateCandidate(context, candidate.color);
      if (evaluation.rejection === null) feasible.push(evaluation);
    }
    if (feasible.length > 0) {
      best = feasible.sort(compareEvaluations)[0] ?? null;
      break;
    }
    if (budgetExhausted) break;
  }

  const stats: SearchStats = { candidateCount, stagesSearched };

  if (!best) {
    return {
      ...analyzed,
      status: 'no-safe-candidate',
      reason: budgetExhausted ? 'search-budget-exhausted' : 'no-candidate-meets-constraints',
      stats,
    };
  }

  // Apply strength: interpolate original -> optimized in OKLab.
  const output = interpolateInOklab(foreground, best.color, strength);
  if (!output) {
    return {
      ...analyzed,
      status: 'no-safe-candidate',
      reason: 'strength-interpolation-unsafe',
      stats,
    };
  }
  if (toHex(output) === toHex(foreground)) {
    return { ...analyzed, status: 'unchanged', reason: 'below-visible-change', stats };
  }

  const finalEvaluation = output === best.color ? best : evaluateCandidate(context, output);
  const safe =
    finalEvaluation.contrast >=
      contrastFloor(originalContrast, constraints.contrastRegressionTolerance) &&
    finalEvaluation.changeDistance <= constraints.maxDesignChange &&
    finalEvaluation.vision.simulatedDistance >= originalVision.simulatedDistance;
  if (!safe) {
    return {
      ...analyzed,
      status: 'no-safe-candidate',
      reason: 'strength-interpolation-unsafe',
      stats,
    };
  }

  return {
    ...analyzed,
    status: 'adapted',
    reason: 'improved',
    outputColor: output,
    optimizedColor: best.color,
    adaptedVisionAnalysis: finalEvaluation.vision,
    adaptedContrast: finalEvaluation.contrast,
    changeDistance: finalEvaluation.changeDistance,
    score: finalEvaluation.breakdown.score,
    stats,
  };
}
