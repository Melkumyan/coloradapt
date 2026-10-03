import type { ModelConfidence } from '@domain/models';
import type { OklchColor } from '@core/color';
import { clamp01 } from '@shared/utils';
import { CONFIDENCE_DESIGN_MULTIPLIER, SCORE_POLICY } from './constraints';

/**
 * Weighted OKLCH distance between two colors. Equals the plain OKLab
 * distance except that the hue component is scaled by
 * {@link SCORE_POLICY.hueWeight}, so a hue shift costs more than an equally
 * large lightness/chroma shift. The hue term uses the chord
 * `2·sqrt(C1·C2)·sin(Δh/2)`, which vanishes for neutral colors (their hue is
 * meaningless) and shrinks for low chroma.
 */
export function weightedDesignChange(original: OklchColor, candidate: OklchColor): number {
  const dL = candidate.l - original.l;
  const dC = candidate.c - original.c;
  const dHueRad = ((candidate.h - original.h) * Math.PI) / 180;
  const dH = 2 * Math.sqrt(original.c * candidate.c) * Math.sin(dHueRad / 2);
  return Math.hypot(dL, dC, SCORE_POLICY.hueWeight * dH);
}

export interface ScoreInput {
  readonly originalSimulatedDistance: number;
  readonly candidateSimulatedDistance: number;
  readonly targetSimulatedDistance: number;
  readonly originalContrast: number;
  readonly candidateContrast: number;
  readonly weightedDesignChange: number;
  readonly maxDesignChange: number;
  readonly confidence: ModelConfidence;
}

export interface ScoreBreakdown {
  /** 0..1, saturates at the target distance: extra distance is not rewarded. */
  readonly benefit: number;
  readonly designPenalty: number;
  readonly confidencePenalty: number;
  readonly contrastPenalty: number;
  readonly score: number;
}

/**
 * Candidate score, higher is better:
 *
 *   score = benefitWeight · benefit
 *         − designChangeWeight · designChange/maxDesignChange
 *         − (confidenceMultiplier − 1) · designChangeWeight · designChange/maxDesignChange
 *         − contrastLossWeight · max(0, (origContrast − candContrast)/origContrast)
 *
 * Because `benefit` saturates once the target is reached, among candidates
 * that reach it the smallest design change wins — "best ≠ maximum distance".
 */
export function scoreCandidate(input: ScoreInput): ScoreBreakdown {
  const gap = input.targetSimulatedDistance - input.originalSimulatedDistance;
  const benefit =
    gap <= 0
      ? 1
      : clamp01((input.candidateSimulatedDistance - input.originalSimulatedDistance) / gap);

  const normalizedChange = input.weightedDesignChange / input.maxDesignChange;
  const designPenalty = SCORE_POLICY.designChangeWeight * normalizedChange;
  const confidencePenalty =
    (CONFIDENCE_DESIGN_MULTIPLIER[input.confidence] - 1) *
    SCORE_POLICY.designChangeWeight *
    normalizedChange;
  const contrastLoss =
    input.originalContrast > 0
      ? Math.max(0, (input.originalContrast - input.candidateContrast) / input.originalContrast)
      : 0;
  const contrastPenalty = SCORE_POLICY.contrastLossWeight * contrastLoss;

  return {
    benefit,
    designPenalty,
    confidencePenalty,
    contrastPenalty,
    score:
      SCORE_POLICY.benefitWeight * benefit - designPenalty - confidencePenalty - contrastPenalty,
  };
}
