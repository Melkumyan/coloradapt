import type { ColorValue } from './color';

export type ConflictSeverity = 'low' | 'medium' | 'high' | 'critical';

export const CONFLICT_SEVERITIES: readonly ConflictSeverity[] = [
  'low',
  'medium',
  'high',
  'critical',
];

/**
 * A detected color combination that is estimated to be poorly
 * distinguishable for a given vision profile and/or fails WCAG contrast
 * guidelines. This is a heuristic estimate, not a diagnostic result.
 */
export interface ColorConflict {
  readonly elementId: string;
  readonly foreground: ColorValue;
  readonly background: ColorValue;
  readonly simulatedForeground: ColorValue;
  readonly simulatedBackground: ColorValue;
  /** Perceptual distance (OKLab Euclidean) between simulated colors. */
  readonly perceptualDistance: number;
  /** WCAG 2.x contrast ratio (1-21) between the original colors. */
  readonly contrast: number;
  readonly severity: ConflictSeverity;
  readonly reason: string;
}
