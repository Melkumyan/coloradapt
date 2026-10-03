import type { ColorValue, VisionAnalysis, VisionProfile } from '@domain/models';
import { VISION_PROFILE_INFO } from '@domain/models';
import { calculatePerceptualDistance } from '@core/color';
import type { VisionSimulator } from './simulator';
import { assertValidSeverity, defaultVisionSimulator } from './simulator';

/**
 * Simulates both colors of a pair and reports how far apart they are before
 * and after. This is distinguishability only; WCAG contrast is computed
 * separately and must not be derived from (or replaced by) these numbers.
 */
export function simulatePair(
  foreground: ColorValue,
  background: ColorValue,
  profile: VisionProfile,
  severity?: number,
  simulator: VisionSimulator = defaultVisionSimulator,
): VisionAnalysis {
  const resolvedSeverity = severity ?? VISION_PROFILE_INFO[profile].defaultSeverity;
  assertValidSeverity(resolvedSeverity);

  const simulatedForeground = simulator.simulate(foreground, profile, resolvedSeverity);
  const simulatedBackground = simulator.simulate(background, profile, resolvedSeverity);
  const originalDistance = calculatePerceptualDistance(foreground, background);
  const simulatedDistance = calculatePerceptualDistance(simulatedForeground, simulatedBackground);

  return {
    profile,
    severity: resolvedSeverity,
    model: simulator.modelFor(profile),
    originalForeground: foreground,
    originalBackground: background,
    simulatedForeground,
    simulatedBackground,
    originalDistance,
    simulatedDistance,
    distanceLoss: originalDistance - simulatedDistance,
  };
}
