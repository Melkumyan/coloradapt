import type { Mat3, Vec3 } from '@core/color';
import { mat3Mul, mat3MulVec, mat3Transpose, vec3Cross, vec3Dot } from '@core/color';
import {
  ANCHOR_XYZ,
  LINEAR_RGB_FROM_LMS,
  LMS_FROM_LINEAR_RGB,
  LMS_FROM_XYZ_JUDD_VOS_SMITH_POKORNY_1975,
} from './lms';
import type { CvdFamily, LinearVisionModel } from './types';

/**
 * Brettel, Viénot & Mollon (1997), "Computerized simulation of color
 * appearance for dichromats", JOSA A 14(10).
 *
 * A dichromat's colors lie on a surface in LMS space made of two half-planes
 * that both contain the neutral (achromatic) axis and one spectral anchor
 * each. Each color is projected, along the axis of the missing cone, onto the
 * half-plane on its side of the separation plane (the plane containing the
 * neutral axis and the missing-cone axis).
 *
 * Deliberate deviation: the neutral axis is the display white (R=G=B) rather
 * than the equal-energy stimulus E, as in Viénot et al. (1999). This keeps
 * achromatic colors achromatic and fits more projected colors inside the sRGB
 * gamut.
 */

const CONFUSION_AXIS: Readonly<Record<CvdFamily, Vec3>> = {
  protan: [1, 0, 0],
  deutan: [0, 1, 0],
  tritan: [0, 0, 1],
};

/** Projection of an LMS color onto plane `n` (through the origin) along the missing cone's axis. */
export function planeProjectionMatrix(n: Vec3, family: CvdFamily): Mat3 {
  switch (family) {
    case 'protan':
      return [0, -n[1] / n[0], -n[2] / n[0], 0, 1, 0, 0, 0, 1];
    case 'deutan':
      return [1, 0, 0, -n[0] / n[1], 0, -n[2] / n[1], 0, 0, 1];
    case 'tritan':
      return [1, 0, 0, 0, 1, 0, -n[0] / n[2], -n[1] / n[2], 0];
  }
}

export interface BrettelParams {
  /** Linear RGB -> linear RGB projecting onto half-plane 1 (rgbFromLms . H1 . lmsFromRgb). */
  readonly plane1: Mat3;
  /** Same for half-plane 2. */
  readonly plane2: Mat3;
  /** Separation-plane normal expressed for linear RGB input: dot >= 0 selects plane 1. */
  readonly separationNormalRgb: Vec3;
}

function lmsFromXyz(xyz: Vec3): Vec3 {
  return mat3MulVec(LMS_FROM_XYZ_JUDD_VOS_SMITH_POKORNY_1975, xyz);
}

export function deriveBrettelParams(family: CvdFamily): BrettelParams {
  const neutral = mat3MulVec(LMS_FROM_LINEAR_RGB, [1, 1, 1]);
  let wing1 = lmsFromXyz(family === 'tritan' ? ANCHOR_XYZ.nm485 : ANCHOR_XYZ.nm475);
  let wing2 = lmsFromXyz(family === 'tritan' ? ANCHOR_XYZ.nm660 : ANCHOR_XYZ.nm575);

  const separation = vec3Cross(neutral, CONFUSION_AXIS[family]);
  // Make wing1 the anchor on the positive side of the separation plane.
  if (vec3Dot(separation, wing1) < 0) [wing1, wing2] = [wing2, wing1];

  const h1 = planeProjectionMatrix(vec3Cross(neutral, wing1), family);
  const h2 = planeProjectionMatrix(vec3Cross(neutral, wing2), family);
  const toRgb = (h: Mat3): Mat3 => mat3Mul(LINEAR_RGB_FROM_LMS, mat3Mul(h, LMS_FROM_LINEAR_RGB));

  return {
    plane1: toRgb(h1),
    plane2: toRgb(h2),
    separationNormalRgb: mat3MulVec(mat3Transpose(LMS_FROM_LINEAR_RGB), separation),
  };
}

const PARAMS: Readonly<Record<CvdFamily, BrettelParams>> = {
  protan: deriveBrettelParams('protan'),
  deutan: deriveBrettelParams('deutan'),
  tritan: deriveBrettelParams('tritan'),
};

export function brettelParams(family: CvdFamily): BrettelParams {
  return PARAMS[family];
}

/** Full dichromacy for a linear-RGB color (unclamped). */
export function brettelDichromacy(linear: Vec3, family: CvdFamily): Vec3 {
  const p = PARAMS[family];
  return mat3MulVec(vec3Dot(p.separationNormalRgb, linear) >= 0 ? p.plane1 : p.plane2, linear);
}

/**
 * Brettel 1997 dichromacy; severity < 1 blends it with the unmodified color
 * in linear RGB (identical to blending in LMS because the projection is
 * linear). The blend is a pragmatic approximation of anomalous trichromacy,
 * not part of the 1997 paper.
 */
export const brettel1997: LinearVisionModel = {
  id: 'brettel1997',
  supports: (family) => family !== 'mono',
  transform(linear, family, severity) {
    if (family === 'mono') throw new RangeError('Brettel 1997 is a dichromacy model');
    const d = brettelDichromacy(linear, family);
    const s = severity;
    return [
      d[0] * s + linear[0] * (1 - s),
      d[1] * s + linear[1] * (1 - s),
      d[2] * s + linear[2] * (1 - s),
    ];
  },
};

/** Same transform, labeled as the approximation it is when used for anomalous trichromacy. */
export const brettel1997Interpolated: LinearVisionModel = {
  ...brettel1997,
  id: 'brettel1997-interpolated',
};
