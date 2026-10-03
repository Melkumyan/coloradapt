import type { ModelConfidence } from '@domain/models';

/**
 * Engineering thresholds of the Adaptation Engine. They are tuning knobs
 * chosen for a safe MVP, NOT scientifically derived or calibrated norms, and
 * they are deliberately separate from the M1 conflict-detection thresholds
 * (`core/conflicts/thresholds.ts`), which are a different heuristic.
 * Every magic number of the optimizer lives here (see docs/ADAPTATION_ENGINE.md).
 */
export const ENGINEERING_THRESHOLDS = {
  /** Detection heuristic: a pair below this simulated OKLab distance is a "problem". */
  problemSimulatedDistance: 0.12,
  /** Adaptation target: a candidate must reach this simulated distance (hysteresis above detection). */
  targetSimulatedDistance: 0.18,
  /** A candidate must also improve the simulated distance by at least this much. */
  minDistanceImprovement: 0.04,
  /** Fraction of the original WCAG contrast a candidate may lose (see {@link contrastFloor}). */
  contrastRegressionTolerance: 0.05,
  /** Max OKLab distance between original and candidate. */
  maxDesignChange: 0.3,
  /** Structural search budget: candidates evaluated per color pair. */
  maxCandidateEvaluations: 800,
  /** Below this OKLCH chroma a color is neutral: hue is meaningless and is never searched. */
  neutralChroma: 0.02,
  /** Below this chroma hue is unstable: only small hue shifts are searched. */
  nearNeutralChroma: 0.04,
} as const;

/**
 * Standard WCAG 2.x ratio tiers (AAA, AA, large text/UI). Used only so an
 * adaptation never drops a pair below a tier the original already met. A
 * technical guard against regressions, not a legal or conformance
 * interpretation of WCAG.
 */
export const CONTRAST_TIERS: readonly number[] = [7, 4.5, 3];

/** Weights of the transparent candidate score (docs/ADAPTATION_ENGINE.md, "Scoring"). */
export const SCORE_POLICY = {
  /** Reward for distinguishability improvement; saturates (1.0) once the target is reached. */
  benefitWeight: 1,
  /** Penalty per unit of normalized design change (weighted OKLCH distance / maxDesignChange). */
  designChangeWeight: 1.5,
  /** Penalty per unit of relative WCAG contrast loss. */
  contrastLossWeight: 1,
  /** Hue shifts count this much more than equal-sized lightness/chroma shifts. */
  hueWeight: 1.6,
} as const;

/**
 * Design-change penalty multiplier by model confidence: results based on
 * weaker models must justify less change.
 */
export const CONFIDENCE_DESIGN_MULTIPLIER: Readonly<Record<ModelConfidence, number>> = {
  SUPPORTED_MODEL: 1,
  MODEL_ASSUMPTION: 1.25,
  APPROXIMATION: 1.5,
  UNSUPPORTED: 1.5,
};

export interface AdaptationConstraints {
  readonly problemSimulatedDistance: number;
  readonly targetSimulatedDistance: number;
  readonly minDistanceImprovement: number;
  readonly contrastRegressionTolerance: number;
  readonly maxDesignChange: number;
  readonly maxCandidateEvaluations: number;
}

/** Approximation models get a tighter design-change cap (weaker evidence, smaller edits). */
const APPROXIMATION_MAX_DESIGN_CHANGE = 0.2;

export function constraintsFor(
  confidence: ModelConfidence,
  overrides: Partial<AdaptationConstraints> = {},
): AdaptationConstraints {
  const base: AdaptationConstraints = {
    problemSimulatedDistance: ENGINEERING_THRESHOLDS.problemSimulatedDistance,
    targetSimulatedDistance: ENGINEERING_THRESHOLDS.targetSimulatedDistance,
    minDistanceImprovement: ENGINEERING_THRESHOLDS.minDistanceImprovement,
    contrastRegressionTolerance: ENGINEERING_THRESHOLDS.contrastRegressionTolerance,
    maxDesignChange:
      confidence === 'APPROXIMATION'
        ? APPROXIMATION_MAX_DESIGN_CHANGE
        : ENGINEERING_THRESHOLDS.maxDesignChange,
    maxCandidateEvaluations: ENGINEERING_THRESHOLDS.maxCandidateEvaluations,
  };
  return { ...base, ...overrides };
}

/**
 * Lowest WCAG contrast a candidate may have: the original ratio minus a
 * small tolerance, and never below the highest tier the original already met.
 */
export function contrastFloor(originalContrast: number, tolerance: number): number {
  const tier = CONTRAST_TIERS.find((t) => originalContrast >= t) ?? 0;
  return Math.min(originalContrast, Math.max(tier, originalContrast * (1 - tolerance)));
}
