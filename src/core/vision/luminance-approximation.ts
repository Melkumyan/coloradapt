import type { Vec3 } from '@core/color';
import type { LinearVisionModel } from './types';

/**
 * Achromatopsia APPROXIMATION: replaces a color by its relative luminance
 * (Rec. 709 weights on linear RGB, which is the correct space for
 * luminance) and blends toward it with severity.
 *
 * Limitations: rod monochromacy is governed by the scotopic spectral
 * sensitivity and by glare/acuity effects that a gray image does not
 * capture. This is a documented approximation of "no chromatic
 * discrimination", with lower scientific standing than Brettel or Machado.
 */
export const LUMINANCE_WEIGHTS: Vec3 = [0.2126, 0.7152, 0.0722];

export const luminanceApproximation: LinearVisionModel = {
  id: 'luminance-approximation',
  supports: () => true,
  transform(linear: Vec3, _family, severity) {
    const y =
      LUMINANCE_WEIGHTS[0] * linear[0] +
      LUMINANCE_WEIGHTS[1] * linear[1] +
      LUMINANCE_WEIGHTS[2] * linear[2];
    return [
      y * severity + linear[0] * (1 - severity),
      y * severity + linear[1] * (1 - severity),
      y * severity + linear[2] * (1 - severity),
    ];
  },
};
