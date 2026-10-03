import type { Mat3, Vec3 } from '@core/color';
import { mat3Inverse, mat3Mul } from '@core/color';

/**
 * Colorimetric constants shared by the Brettel 1997 and Viénot 1999
 * implementations. All values are immutable and documented.
 *
 * Assumptions (see docs/COLOR_VISION_SIMULATION.md):
 *  - Display primaries and white: sRGB / Rec. 709 (D65), converted to Judd-Vos
 *    XYZ with the matrix Viénot 1999 derived for these primaries.
 *  - Cone fundamentals: Smith & Pokorny (1975), as used by Viénot et al.
 *  - These are the same constants used by DaltonLens, so results can be
 *    cross-checked against that independent implementation.
 */

/**
 * Linear sRGB -> Judd-Vos corrected XYZ. Smith & Pokorny (1975) cone
 * fundamentals are defined on the Judd-Vos modified XYZ, not on CIE 1931 XYZ,
 * so feeding them plain XYZ (a common mistake) skews the LMS axes.
 *
 * Values are the matrix published by Viénot, Brettel & Mollon (1999),
 * computed from the sRGB/BT.709 primaries (x,y: 0.64,0.33 / 0.30,0.60 /
 * 0.15,0.06) and D65 white. Rows normalized so that Y of white is 1.
 */
export const XYZ_JUDD_VOS_FROM_LINEAR_SRGB: Mat3 = [
  0.409568, 0.355041, 0.179167, 0.213389, 0.706743, 0.079868, 0.0186297, 0.11462, 0.912367,
];

/** Judd-Vos XYZ -> Smith & Pokorny (1975) cone fundamentals (Smith & Pokorny 1975; Smith 2003). */
export const LMS_FROM_XYZ_JUDD_VOS_SMITH_POKORNY_1975: Mat3 = [
  0.15514, 0.54312, -0.03286, -0.15514, 0.45684, 0.03286, 0, 0, 0.01608,
];

export const LMS_FROM_LINEAR_RGB: Mat3 = mat3Mul(
  LMS_FROM_XYZ_JUDD_VOS_SMITH_POKORNY_1975,
  XYZ_JUDD_VOS_FROM_LINEAR_SRGB,
);

export const LINEAR_RGB_FROM_LMS: Mat3 = mat3Inverse(LMS_FROM_LINEAR_RGB);

/**
 * Judd-Vos corrected 2-degree XYZ of the monochromatic anchor stimuli used by
 * Brettel et al. (1997) to define the two half-planes of each dichromat's
 * color surface: 475 nm / 575 nm for protan & deutan, 485 nm / 660 nm for
 * tritan. Tabulated (5 significant digits) by DaltonLens from the Judd-Vos
 * modified CMFs.
 */
export const ANCHOR_XYZ: Readonly<Record<'nm475' | 'nm575' | 'nm485' | 'nm660', Vec3>> = {
  nm475: [0.13287, 0.11284, 0.9422],
  nm575: [0.84394, 0.91558, 0.00197],
  nm485: [0.05699, 0.16987, 0.5864],
  nm660: [0.16161, 0.061, 0.00001],
};
