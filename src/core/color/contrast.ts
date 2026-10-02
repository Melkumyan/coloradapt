import type { ColorValue } from '@domain/models';

function linearize(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance, assuming the background shows through alpha. */
export function relativeLuminance(color: ColorValue): number {
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

/**
 * WCAG 2.x contrast ratio between two colors, from 1 (identical luminance)
 * to 21 (black on white). Ignores alpha — callers should flatten
 * semi-transparent foregrounds onto their background first.
 */
export function calculateContrast(a: ColorValue, b: ColorValue): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Alpha-composites `color` over `backdrop` (e.g. a semi-transparent foreground). */
export function flattenOnBackground(color: ColorValue, backdrop: ColorValue): ColorValue {
  const a = color.alpha;
  return {
    r: color.r * a + backdrop.r * (1 - a),
    g: color.g * a + backdrop.g * (1 - a),
    b: color.b * a + backdrop.b * (1 - a),
    alpha: 1,
  };
}
