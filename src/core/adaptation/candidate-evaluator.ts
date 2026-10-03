import type { ColorValue, ModelConfidence, VisionAnalysis, VisionProfile } from '@domain/models';
import { calculateContrast, calculatePerceptualDistance, convertColor } from '@core/color';
import { simulatePair } from '@core/vision';
import type { AdaptationConstraints } from './constraints';
import { contrastFloor } from './constraints';
import { scoreCandidate, weightedDesignChange, type ScoreBreakdown } from './candidate-score';

export interface EvaluationContext {
  readonly original: ColorValue;
  readonly background: ColorValue;
  readonly profile: VisionProfile;
  readonly severity: number;
  readonly confidence: ModelConfidence;
  readonly constraints: AdaptationConstraints;
  readonly originalContrast: number;
  readonly originalVision: VisionAnalysis;
}

export type Rejection = 'contrast-regression' | 'design-change' | 'insufficient-improvement';

export interface CandidateEvaluation {
  readonly color: ColorValue;
  readonly vision: VisionAnalysis;
  readonly contrast: number;
  /** Plain OKLab distance from the original (the capped, reported change). */
  readonly changeDistance: number;
  readonly weightedChange: number;
  readonly breakdown: ScoreBreakdown;
  /** `null` when the candidate satisfies every hard constraint. */
  readonly rejection: Rejection | null;
}

/**
 * Scores one candidate and checks it against the hard constraints:
 * valid colors only (the generator guarantees gamut), no material WCAG
 * contrast regression, bounded design change, and a sufficient improvement
 * of the simulated distinguishability (M2 simulation, not raw RGB distance).
 */
export function evaluateCandidate(
  context: EvaluationContext,
  color: ColorValue,
): CandidateEvaluation {
  const { constraints } = context;
  const contrast = calculateContrast(color, context.background);
  const vision = simulatePair(color, context.background, context.profile, context.severity);
  const changeDistance = calculatePerceptualDistance(context.original, color);
  const weightedChange = weightedDesignChange(convertColor(context.original), convertColor(color));

  const breakdown = scoreCandidate({
    originalSimulatedDistance: context.originalVision.simulatedDistance,
    candidateSimulatedDistance: vision.simulatedDistance,
    targetSimulatedDistance: constraints.targetSimulatedDistance,
    originalContrast: context.originalContrast,
    candidateContrast: contrast,
    weightedDesignChange: weightedChange,
    maxDesignChange: constraints.maxDesignChange,
    confidence: context.confidence,
  });

  let rejection: Rejection | null = null;
  if (contrast < contrastFloor(context.originalContrast, constraints.contrastRegressionTolerance)) {
    rejection = 'contrast-regression';
  } else if (changeDistance > constraints.maxDesignChange) {
    rejection = 'design-change';
  } else if (
    vision.simulatedDistance < constraints.targetSimulatedDistance ||
    vision.simulatedDistance - context.originalVision.simulatedDistance <
      constraints.minDistanceImprovement
  ) {
    rejection = 'insufficient-improvement';
  }

  return { color, vision, contrast, changeDistance, weightedChange, breakdown, rejection };
}
