import { converter, formatHex, formatHex8 } from 'culori';
import type { ColorValue } from '@domain/models';
import { toCuloriRgb } from './internal';

const toOklch = converter('oklch');

export interface OklchColor {
  readonly l: number;
  readonly c: number;
  readonly h: number;
  readonly alpha: number;
}

/** Converts a {@link ColorValue} to the perceptually-uniform OKLCH space. */
export function convertColor(color: ColorValue): OklchColor {
  const oklch = toOklch(toCuloriRgb(color));
  return {
    l: oklch.l ?? 0,
    c: oklch.c ?? 0,
    h: oklch.h ?? 0,
    alpha: oklch.alpha ?? color.alpha,
  };
}

export function oklchToColor(oklch: OklchColor, source?: string): ColorValue {
  const rgb = converter('rgb')({
    mode: 'oklch',
    l: oklch.l,
    c: oklch.c,
    h: oklch.h,
    alpha: oklch.alpha,
  });
  return {
    r: rgb.r ?? 0,
    g: rgb.g ?? 0,
    b: rgb.b ?? 0,
    alpha: rgb.alpha ?? oklch.alpha,
    source,
  };
}

/** Formats a {@link ColorValue} as a CSS hex color string. */
export function toHex(color: ColorValue): string {
  const rgb = toCuloriRgb(color);
  return color.alpha < 1 ? formatHex8(rgb) : formatHex(rgb);
}
