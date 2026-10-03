import type { ColorConflict, ColorPair, ConflictSeverity, VisionProfile } from '@domain/models';
import { calculateContrast } from '@core/color';
import { simulatePair } from '@core/vision';
import { CONTRAST_THRESHOLDS, PERCEPTUAL_DISTANCE_THRESHOLDS } from './thresholds';

function determineSeverity(contrast: number, perceptualDistance: number): ConflictSeverity | null {
  const lowContrast = contrast < CONTRAST_THRESHOLDS.aaNormalText;
  const veryLowContrast = contrast < CONTRAST_THRESHOLDS.aaLargeText;

  if (veryLowContrast && perceptualDistance < PERCEPTUAL_DISTANCE_THRESHOLDS.indistinguishable) {
    return 'critical';
  }
  if (lowContrast && perceptualDistance < PERCEPTUAL_DISTANCE_THRESHOLDS.hardToDistinguish) {
    return 'high';
  }
  if (lowContrast || perceptualDistance < PERCEPTUAL_DISTANCE_THRESHOLDS.hardToDistinguish) {
    return 'medium';
  }
  if (perceptualDistance < PERCEPTUAL_DISTANCE_THRESHOLDS.mildlyDistinguishable) {
    return 'low';
  }
  return null;
}

function describeReason(
  severity: ConflictSeverity,
  contrast: number,
  perceptualDistance: number,
): string {
  const contrastPart = `contrast ${contrast.toFixed(2)}:1`;
  const distancePart = `simulated color distance ${perceptualDistance.toFixed(3)}`;
  switch (severity) {
    case 'critical':
      return `Very low ${contrastPart} and colors are estimated to be indistinguishable (${distancePart}).`;
    case 'high':
      return `Low ${contrastPart} and colors are estimated to be hard to distinguish (${distancePart}).`;
    case 'medium':
      return `Below-recommended ${contrastPart} or reduced color distinguishability (${distancePart}).`;
    case 'low':
      return `Colors are estimated to be only mildly distinguishable (${distancePart}).`;
  }
}

/**
 * Estimates whether a foreground/background pair is likely to be a poor
 * combination for the given vision profile, combining WCAG contrast with
 * perceptual distance under a vision simulation (kept as separate signals:
 * `contrast` is WCAG, `vision` is the color vision simulation result). Returns `null` when no
 * conflict is detected. This is a heuristic estimate, not a diagnosis.
 */
export function detectColorConflict(
  elementId: string,
  pair: ColorPair,
  profile: VisionProfile,
  visionSeverity?: number,
): ColorConflict | null {
  const contrast = calculateContrast(pair.foreground, pair.background);
  const vision = simulatePair(pair.foreground, pair.background, profile, visionSeverity);
  const perceptualDistance = vision.simulatedDistance;

  const severity = determineSeverity(contrast, perceptualDistance);
  if (!severity) return null;

  return {
    elementId,
    foreground: pair.foreground,
    background: pair.background,
    vision,
    contrast,
    severity,
    reason: describeReason(severity, contrast, perceptualDistance),
  };
}
