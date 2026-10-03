/**
 * sRGB transfer functions (IEC 61966-2-1), the piecewise definition rather
 * than a `pow(2.2)` approximation. Channel values are normalized to [0, 1].
 */

const DECODE_THRESHOLD = 0.04045;
const ENCODE_THRESHOLD = 0.0031308;

/** Decodes a gamma-encoded sRGB channel to linear light. Input is clamped to [0, 1]. */
export function srgbToLinear(encoded: number): number {
  const v = Math.min(1, Math.max(0, encoded));
  return v <= DECODE_THRESHOLD ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * Encodes a linear-light channel as sRGB. Values outside [0, 1] are clipped
 * first: this is the single, explicit gamut-clipping step of the vision
 * pipeline.
 */
export function linearToSrgb(linear: number): number {
  if (linear >= 1) return 1;
  const v = Math.max(0, linear);
  return v <= ENCODE_THRESHOLD ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
