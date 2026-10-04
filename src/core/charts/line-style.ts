import type { LineStyleId } from './types';

/** Line styles in preference order. `solid` is "as drawn" and never written. */
export const LINE_STYLES: readonly LineStyleId[] = [
  'solid',
  'dashed',
  'dotted',
  'dash-dot',
  'long-dash',
];

/**
 * Dash and gap lengths as multiples of the stroke width (so thick lines get proportionally long dashes).
 * The painted share is kept high (50-77 %): the gaps of a dashed stroke are not hit-testable, so a
 * line with a tooltip stays easy to point at (docs/CHARTS.md, "Interaction safety").
 */
const PATTERN: Readonly<Record<Exclude<LineStyleId, 'solid'>, readonly number[]>> = {
  dashed: [5, 2],
  dotted: [1.5, 1.5],
  'dash-dot': [6, 2, 1.5, 2],
  'long-dash': [10, 3],
};

/** Smallest unit, in user units: a hairline would otherwise get dashes nobody can see. */
const MIN_UNIT = 1.5;

/**
 * The `stroke-dasharray` of a style for a stroke of `strokeWidth`, as numbers
 * separated by spaces (`'6 3.75'`), or null for `solid`. Deterministic and
 * rounded, so the same series always gets the same text.
 */
export function dashArrayFor(style: LineStyleId, strokeWidth: number): string | null {
  if (style === 'solid') return null;
  const unit = Math.max(MIN_UNIT, Number.isFinite(strokeWidth) ? strokeWidth : MIN_UNIT);
  return PATTERN[style].map((part) => formatNumber(part * unit)).join(' ');
}

function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * Normalizes a computed `stroke-dasharray` (`'6px, 3px'`, `'6 3'`, `'none'`) to numbers
 * separated by spaces, or null for none. An odd list is repeated, as the SVG spec says
 * it is read, so `'5'` and `'5 5'` are the same style.
 */
export function normalizeDashArray(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'none') return null;
  const numbers = trimmed
    .split(/[\s,]+/)
    .map((part) => Number.parseFloat(part))
    .filter((number) => Number.isFinite(number));
  if (numbers.length === 0 || numbers.every((number) => number === 0)) return null;
  const list = numbers.length % 2 === 1 ? [...numbers, ...numbers] : numbers;
  return list.map(formatNumber).join(' ');
}
