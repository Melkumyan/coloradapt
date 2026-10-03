import { converter } from 'culori';
import type { ColorValue } from '@domain/models';

const toRgb = converter('rgb');
const GAMUT_EPSILON = 1e-6;
const CHROMA_BISECTIONS = 14;

function rgbOf(l: number, c: number, h: number): [number, number, number] | null {
  const rgb = toRgb({ mode: 'oklch', l, c, h });
  const { r, g, b } = rgb;
  if (![r, g, b].every((v) => Number.isFinite(v))) return null;
  return [r, g, b];
}

function inGamut(rgb: readonly number[]): boolean {
  return rgb.every((v) => v >= -GAMUT_EPSILON && v <= 1 + GAMUT_EPSILON);
}

/** Rounds to the 8-bit grid so evaluated candidates are exactly what gets applied. */
function quantize(channel: number): number {
  return Math.round(Math.min(1, Math.max(0, channel)) * 255) / 255;
}

/**
 * Converts OKLCH to a valid, opaque, 8-bit-quantized sRGB color, or `null`
 * for non-finite input. Gamut policy: an out-of-gamut color keeps its
 * lightness and hue and loses chroma (deterministic bisection), instead of
 * per-channel clipping, which would shift hue and invalidate the score
 * computed for the requested color. Lightness outside [0, 1] is clamped.
 */
export function oklchToValidColor(l: number, c: number, h: number): ColorValue | null {
  if (![l, c, h].every((v) => Number.isFinite(v))) return null;
  const lightness = Math.min(1, Math.max(0, l));
  const chroma = Math.max(0, c);

  let rgb = rgbOf(lightness, chroma, h);
  if (!rgb) return null;

  if (!inGamut(rgb)) {
    let low = 0;
    let high = chroma;
    let best = rgbOf(lightness, 0, h);
    for (let i = 0; i < CHROMA_BISECTIONS; i += 1) {
      const mid = (low + high) / 2;
      const candidate = rgbOf(lightness, mid, h);
      if (candidate && inGamut(candidate)) {
        low = mid;
        best = candidate;
      } else {
        high = mid;
      }
    }
    if (!best) return null;
    rgb = best;
  }

  return { r: quantize(rgb[0]), g: quantize(rgb[1]), b: quantize(rgb[2]), alpha: 1 };
}

/** OKLab variant of {@link oklchToValidColor}, used for strength interpolation. */
export function oklabToValidColor(l: number, a: number, b: number): ColorValue | null {
  const chroma = Math.hypot(a, b);
  const hue = (Math.atan2(b, a) * 180) / Math.PI;
  return oklchToValidColor(l, chroma, hue < 0 ? hue + 360 : hue);
}
