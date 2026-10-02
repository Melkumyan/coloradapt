import { parse as culoriParse, converter } from 'culori';
import type { ColorValue } from '@domain/models';
import { fromCuloriRgb } from './internal';

const toRgb = converter('rgb');

/**
 * Parses any valid CSS color string (hex, rgb(), hsl(), oklch(), named
 * colors, `transparent`, ...) into a normalized {@link ColorValue}.
 * Returns `null` when the string cannot be parsed as a color.
 */
export function parseColor(cssColor: string): ColorValue | null {
  const trimmed = cssColor.trim();
  if (!trimmed) return null;
  if (trimmed === 'transparent') {
    return { r: 0, g: 0, b: 0, alpha: 0, source: trimmed };
  }

  const parsed = culoriParse(trimmed);
  if (!parsed) return null;

  const rgb = toRgb(parsed);
  if (!rgb) return null;

  return fromCuloriRgb(rgb, trimmed);
}
