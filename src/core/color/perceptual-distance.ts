import { differenceEuclidean } from 'culori';
import type { ColorValue } from '@domain/models';
import { toCuloriRgb } from './internal';

const oklabDistance = differenceEuclidean('oklab');

/**
 * Perceptual distance between two colors in OKLab, roughly on the same
 * scale as CIE76 Delta E (0 = identical, >~0.1 is noticeable, >~0.3 is
 * clearly distinct for most observers). Used to estimate whether two
 * colors remain distinguishable after a vision simulation is applied.
 */
export function calculatePerceptualDistance(a: ColorValue, b: ColorValue): number {
  return oklabDistance(toCuloriRgb(a), toCuloriRgb(b));
}
