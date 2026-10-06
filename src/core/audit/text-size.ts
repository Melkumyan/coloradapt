/**
 * Large-text classification (WCAG 2.x SC 1.4.3 numbers, ColorAdapt's own engineering target): at least 24
 * CSS px, or at least 14 pt (18.666… px) and bold (weight 700 or more).
 *
 * It reads the *computed* values (`getComputedStyle`), so inheritance, `em`/`rem`/`%`, keywords such as
 * `larger` and `font-size: calc(...)` are already resolved to px, and a variable font's weight arrives as a
 * number. CSS px are the unit: browser zoom and the device pixel ratio change neither (`zoom` as a CSS
 * property is the page's own styling and is reflected by the browser in what it reports).
 */

/** 14 pt in CSS px is 18.666…; the margin only absorbs the browser's rounding of that number. */
const LARGE_BOLD_PX = 18.66;
const LARGE_PX = 24;
const BOLD_WEIGHT = 700;

/** A computed `font-weight` as a number: `normal` 400, `bold` 700, a number as is, anything else null. */
export function parseFontWeight(value: string): number | null {
  const text = value.trim().toLowerCase();
  if (text === 'normal') return 400;
  if (text === 'bold') return 700;
  const number = Number(text);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function isLargeTextStyle(fontSize: string, fontWeight: string): boolean {
  const size = Number.parseFloat(fontSize);
  if (!Number.isFinite(size)) return false;
  if (size >= LARGE_PX) return true;
  const weight = parseFontWeight(fontWeight);
  return weight !== null && size >= LARGE_BOLD_PX && weight >= BOLD_WEIGHT;
}
