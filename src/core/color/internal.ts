import type { Rgb } from 'culori';
import type { ColorValue } from '@domain/models';
import { clamp01 } from '@shared/utils';

export function toCuloriRgb(color: ColorValue): Rgb {
  return {
    mode: 'rgb',
    r: color.r,
    g: color.g,
    b: color.b,
    alpha: color.alpha,
  };
}

export function fromCuloriRgb(rgb: Partial<Rgb>, source?: string): ColorValue {
  return {
    r: clamp01(rgb.r ?? 0),
    g: clamp01(rgb.g ?? 0),
    b: clamp01(rgb.b ?? 0),
    alpha: clamp01(rgb.alpha ?? 1),
    source,
  };
}
