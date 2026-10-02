import type { ColorValue, VisionProfile } from '@domain/models';
import { VISION_PROFILE_INFO } from '@domain/models';
import { clamp01, lerp } from '@shared/utils';

type DichromacyMatrix = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

/**
 * Simplified sRGB simulation matrices for full dichromacy. These are a
 * widely used approximation (not a clinically validated perceptual model)
 * suitable for estimating "is this combination likely distinguishable",
 * not for diagnosing or precisely reproducing a person's actual vision.
 */
const DICHROMACY_MATRICES: Record<'protanopia' | 'deuteranopia' | 'tritanopia', DichromacyMatrix> =
  {
    protanopia: [
      [0.567, 0.433, 0],
      [0.558, 0.442, 0],
      [0, 0.242, 0.758],
    ],
    deuteranopia: [
      [0.625, 0.375, 0],
      [0.7, 0.3, 0],
      [0, 0.3, 0.7],
    ],
    tritanopia: [
      [0.95, 0.05, 0],
      [0, 0.433, 0.567],
      [0, 0.475, 0.525],
    ],
  };

function applyMatrix(color: ColorValue, matrix: DichromacyMatrix): ColorValue {
  const [row0, row1, row2] = matrix;
  return {
    r: clamp01(row0[0] * color.r + row0[1] * color.g + row0[2] * color.b),
    g: clamp01(row1[0] * color.r + row1[1] * color.g + row1[2] * color.b),
    b: clamp01(row2[0] * color.r + row2[1] * color.g + row2[2] * color.b),
    alpha: color.alpha,
  };
}

function mix(a: ColorValue, b: ColorValue, t: number): ColorValue {
  return {
    r: lerp(a.r, b.r, t),
    g: lerp(a.g, b.g, t),
    b: lerp(a.b, b.b, t),
    alpha: a.alpha,
  };
}

function baseDichromacy(
  profile: VisionProfile,
): 'protanopia' | 'deuteranopia' | 'tritanopia' | null {
  if (profile === 'protanopia' || profile === 'protanomaly') return 'protanopia';
  if (profile === 'deuteranopia' || profile === 'deuteranomaly') return 'deuteranopia';
  if (profile === 'tritanopia' || profile === 'tritanomaly') return 'tritanopia';
  return null;
}

/**
 * Estimates how `color` would appear to someone with the given vision
 * profile. This is a simulation / accessibility heuristic, not a medical
 * model of human perception.
 *
 * @param severity 0 (no effect) to 1 (full dichromacy). Defaults to the
 *   profile's typical severity (anomalies are partial, dichromacies are full).
 */
export function simulateVision(
  color: ColorValue,
  profile: VisionProfile,
  severity?: number,
): ColorValue {
  if (profile === 'normal' || profile === 'custom') return color;

  const amount = clamp01(severity ?? VISION_PROFILE_INFO[profile].defaultSeverity);
  if (amount === 0) return color;

  if (profile === 'achromatopsia') {
    const gray = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
    return mix(color, { r: gray, g: gray, b: gray, alpha: color.alpha }, amount);
  }

  const base = baseDichromacy(profile);
  if (!base) return color;

  const simulated = applyMatrix(color, DICHROMACY_MATRICES[base]);
  return mix(color, simulated, amount);
}
