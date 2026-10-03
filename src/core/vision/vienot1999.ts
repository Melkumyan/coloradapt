import type { Mat3, Vec3 } from '@core/color';
import { mat3Mul, mat3MulVec, vec3Cross } from '@core/color';
import { planeProjectionMatrix } from './brettel1997';
import { LINEAR_RGB_FROM_LMS, LMS_FROM_LINEAR_RGB } from './lms';
import type { LinearVisionModel } from './types';

/**
 * Viénot, Brettel & Mollon (1999), "Digital video colourmaps for checking
 * the legibility of displays by dichromats", Color Res. Appl. 24(4).
 *
 * Simplification of Brettel 1997 for protanopia and deuteranopia: a single
 * projection plane through black, the display blue primary and the display
 * yellow (R+G) stimulus replaces the two half-planes, so the whole pipeline
 * collapses to one 3x3 matrix in linear RGB.
 *
 * The paper does not define a tritanopia projection; this model refuses
 * `tritan` rather than inventing one (Brettel 1997 is used for tritan).
 */

function deriveVienotMatrix(family: 'protan' | 'deutan'): Mat3 {
  const blue = mat3MulVec(LMS_FROM_LINEAR_RGB, [0, 0, 1]);
  const yellow = mat3MulVec(LMS_FROM_LINEAR_RGB, [1, 1, 0]);
  const h = planeProjectionMatrix(vec3Cross(yellow, blue), family);
  return mat3Mul(LINEAR_RGB_FROM_LMS, mat3Mul(h, LMS_FROM_LINEAR_RGB));
}

const MATRICES: Readonly<Record<'protan' | 'deutan', Mat3>> = {
  protan: deriveVienotMatrix('protan'),
  deutan: deriveVienotMatrix('deutan'),
};

export function vienotMatrix(family: 'protan' | 'deutan'): Mat3 {
  return MATRICES[family];
}

export const vienot1999: LinearVisionModel = {
  id: 'vienot1999',
  supports: (family) => family === 'protan' || family === 'deutan',
  transform(linear: Vec3, family, severity) {
    if (family !== 'protan' && family !== 'deutan') {
      throw new RangeError(`Viénot 1999 does not define ${family}`);
    }
    const d = mat3MulVec(MATRICES[family], linear);
    const s = severity;
    return [
      d[0] * s + linear[0] * (1 - s),
      d[1] * s + linear[1] * (1 - s),
      d[2] * s + linear[2] * (1 - s),
    ];
  },
};
