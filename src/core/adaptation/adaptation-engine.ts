import type {
  AdaptationChange,
  AdaptationResult,
  AnalysisResult,
  ConflictSeverity,
  UserSettings,
  VisionProfile,
} from '@domain/models';
import { findAlternativeColor, toHex } from '@core/color';

const SEVERITY_RANK: Record<ConflictSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Minimum severity that gets an automatic color adjustment. Below this,
 * a conflict is still reported (see Popup UI) but left alone, since
 * low-severity conflicts are the most likely to be false positives.
 */
const AUTO_FIX_MIN_SEVERITY: ConflictSeverity = 'high';

/**
 * Turns detected conflicts into a minimal, reversible set of style
 * changes. Only adjusts the foreground color's lightness enough to reach
 * WCAG AA contrast — it never rewrites hue/saturation, so adapted colors
 * stay recognizably close to the site's original palette.
 */
export function computeAdaptation(
  analysis: AnalysisResult,
  _profile: VisionProfile,
  settings: UserSettings,
): AdaptationResult {
  if (!settings.enabled || !settings.improveUIColors) {
    return { changes: [], appliedAt: Date.now() };
  }

  const changes: AdaptationChange[] = [];

  for (const conflict of analysis.conflicts) {
    if (SEVERITY_RANK[conflict.severity] < SEVERITY_RANK[AUTO_FIX_MIN_SEVERITY]) continue;

    const targetContrast =
      4.5 * settings.adaptationStrength + conflict.contrast * (1 - settings.adaptationStrength);
    const alternative = findAlternativeColor(
      conflict.foreground,
      conflict.background,
      Math.max(targetContrast, conflict.contrast),
    );
    const adaptedHex = toHex(alternative);
    const originalHex = toHex(conflict.foreground);

    if (adaptedHex === originalHex) continue;

    changes.push({
      elementId: conflict.elementId,
      property: 'color',
      originalValue: originalHex,
      adaptedValue: adaptedHex,
      reason: conflict.reason,
    });
  }

  return { changes, appliedAt: Date.now() };
}
