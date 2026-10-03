import type { Mat3, Vec3 } from '@core/color';
import { MACHADO_2009_MATRICES, MACHADO_2009_SEVERITY_STEPS } from './machado2009-data';
import type { CvdFamily, LinearVisionModel } from './types';

/**
 * Machado, Oliveira & Fernandes (2009), "A Physiologically-based Model for
 * Simulation of Color Vision Deficiency", IEEE TVCG 15(6).
 *
 * The model shifts the peak sensitivity of one cone class (severity 1.0 =
 * 20 nm, equivalent to dichromacy) and is distributed by the authors as
 * pre-computed 3x3 matrices for severities 0.0, 0.1, ..., 1.0 (Table 1).
 * The matrices are applied to LINEAR RGB (the project page does not spell
 * this out; it is how the independent DaltonLens implementation applies
 * them, and linear light is what a cone-response model implies).
 *
 * Intermediate severities: the authors state that interpolating linearly
 * between the two nearest tabulated matrices is "very accurate" for a 0.1
 * step. That is what is done here; it approximates evaluating the model at
 * the exact shift and is not a separate physiological claim.
 */

export function machadoMatrix(family: CvdFamily, severity: number): Mat3 {
  const table = MACHADO_2009_MATRICES[family];
  const scaled = severity * MACHADO_2009_SEVERITY_STEPS;
  const lower = Math.min(Math.floor(scaled), MACHADO_2009_SEVERITY_STEPS);
  const upper = Math.min(lower + 1, MACHADO_2009_SEVERITY_STEPS);
  const w = scaled - lower;
  const a = table[lower]!;
  const b = table[upper]!;
  const out = new Array<number>(9);
  for (let i = 0; i < 9; i++) out[i] = a[i]! * (1 - w) + b[i]! * w;
  return out as unknown as Mat3;
}

export const machado2009: LinearVisionModel = {
  id: 'machado2009',
  supports: (family) => family !== 'mono',
  transform(linear: Vec3, family, severity) {
    if (family === 'mono') throw new RangeError('Machado 2009 has no monochromacy model');
    const m = machadoMatrix(family, severity);
    return [
      m[0] * linear[0] + m[1] * linear[1] + m[2] * linear[2],
      m[3] * linear[0] + m[4] * linear[1] + m[5] * linear[2],
      m[6] * linear[0] + m[7] * linear[1] + m[8] * linear[2],
    ];
  },
};
