import type { ColorValue } from '@domain/models';
import { convertColor } from '@core/color';
import { clamp01 } from '@shared/utils';
import type { Box, MarkFacts, PaintFacts } from './types';

const byte = (channel: number) => Math.round(clamp01(channel) * 255);

/** `#rrggbb` of a color (alpha ignored): the identity two paints are compared by. */
export function colorHex(color: ColorValue): string {
  const hex = (channel: number) => byte(channel).toString(16).padStart(2, '0');
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
}

/** Chroma (OKLCH) below which a color is a gray: axes, gridlines, text. */
const NEUTRAL_CHROMA = 0.04;

export function isNeutral(color: ColorValue): boolean {
  return convertColor(color).c < NEUTRAL_CHROMA;
}

export function paintKeyOf(paint: PaintFacts): string | null {
  if (paint.kind === 'solid' && paint.color && paint.color.alpha > 0) return colorHex(paint.color);
  if ((paint.kind === 'pattern' || paint.kind === 'other') && paint.ref) return `ref:${paint.ref}`;
  return null;
}

export function strokeVisible(mark: MarkFacts): boolean {
  return (
    mark.stroke.kind === 'solid' &&
    mark.strokeWidth > 0 &&
    mark.stroke.opacity > 0 &&
    (mark.stroke.color?.alpha ?? 0) > 0
  );
}

export function fillVisible(mark: MarkFacts): boolean {
  return (
    (mark.fill.kind === 'solid' && mark.fill.opacity > 0 && (mark.fill.color?.alpha ?? 0) > 0) ||
    ((mark.fill.kind === 'pattern' || mark.fill.kind === 'other') && mark.fill.opacity > 0)
  );
}

/** Paints anything at all: a solid, a gradient, a pattern or another paint server (not just a plain color). */
export function isPainted(mark: MarkFacts): boolean {
  const painted = (paint: PaintFacts) => paint.kind !== 'none' && paint.opacity > 0;
  return painted(mark.fill) || (painted(mark.stroke) && mark.strokeWidth > 0);
}

export function isStraight(mark: MarkFacts): boolean {
  return mark.tag === 'line' || (mark.vertices <= 2 && mark.arcCount === 0);
}

/** A mark that draws only an outline-less line: stroke, no fill, open. */
export function isOpenStroke(mark: MarkFacts): boolean {
  return strokeVisible(mark) && !fillVisible(mark) && !mark.closed;
}

export function unionBox(boxes: readonly (Box | null)[]): Box | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const box of boxes) {
    if (!box) continue;
    x0 = Math.min(x0, box.x);
    y0 = Math.min(y0, box.y);
    x1 = Math.max(x1, box.x + box.w);
    y1 = Math.max(y1, box.y + box.h);
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function inflate(box: Box, by: number): Box {
  return { x: box.x - by, y: box.y - by, w: box.w + 2 * by, h: box.h + 2 * by };
}

export function contains(box: Box, x: number, y: number): boolean {
  return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

export function center(box: Box): { x: number; y: number } {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

export function approxEqual(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}

/**
 * Words in a class, id or aria label that say "this is a chart". Never enough on its own. Generic
 * UI words (`bar`, `line`, `pie`, `donut`: `top-bar`, `progress-bar`, `header-line`) are not on the
 * list: `bar-chart` is, through `chart`.
 */
const CHART_HINT =
  /(?:^|[^a-z])(?:chart|graph|plot|series|axis|axes|legend|sparkline|dataviz|recharts|highcharts|apexcharts|nvd3|vega|plotly|echarts)(?:[^a-z]|$)/;

export function hasChartHint(hints: readonly string[]): boolean {
  return hints.some((hint) => CHART_HINT.test(hint));
}

/** Text that reads as a tick label: a number, a percentage, a year, a short month/day name. */
const TICK_TEXT =
  /^[\s$€£¥+\-−]*\d[\d\s.,:/]*(?:%|k|m|b|ms|s)?$|^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?(?:\s+\d+)?$|^q[1-4]$/i;

export function looksLikeTick(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 12 && TICK_TEXT.test(trimmed);
}
