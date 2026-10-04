import type { PatternId } from './types';

/**
 * Pattern fills for bars and slices, as data: a square tile of `size` user units with
 * a base fill (the series color) and ink strokes/dots over it. The browser layer turns a spec
 * into a `<pattern>` (SVG) or into gradients (an HTML swatch); the core never builds nodes.
 */
export interface PatternSpec {
  readonly size: number;
  /** Strokes drawn over the base, as path data in the tile's coordinates. */
  readonly strokes: readonly string[];
  readonly strokeWidth: number;
  /** Filled dots (center + radius) drawn over the base. */
  readonly dots: readonly { readonly cx: number; readonly cy: number; readonly r: number }[];
}

const SIZE = 8;

const SPECS: Readonly<Record<PatternId, PatternSpec>> = {
  diagonal: {
    size: SIZE,
    strokes: [
      `M -2 ${SIZE + 2} L ${SIZE + 2} -2`,
      `M -2 2 L 2 -2`,
      `M ${SIZE - 2} ${SIZE + 2} L ${SIZE + 2} ${SIZE - 2}`,
    ],
    strokeWidth: 1.6,
    dots: [],
  },
  'diagonal-reverse': {
    size: SIZE,
    strokes: [
      `M -2 -2 L ${SIZE + 2} ${SIZE + 2}`,
      `M -2 ${SIZE - 2} L 2 ${SIZE + 2}`,
      `M ${SIZE - 2} -2 L ${SIZE + 2} 2`,
    ],
    strokeWidth: 1.6,
    dots: [],
  },
  crosshatch: {
    size: SIZE,
    strokes: [`M 0 ${SIZE / 2} H ${SIZE}`, `M ${SIZE / 2} 0 V ${SIZE}`],
    strokeWidth: 1.4,
    dots: [],
  },
  horizontal: {
    size: SIZE,
    strokes: [`M 0 ${SIZE / 2} H ${SIZE}`],
    strokeWidth: 2,
    dots: [],
  },
  vertical: {
    size: SIZE,
    strokes: [`M ${SIZE / 2} 0 V ${SIZE}`],
    strokeWidth: 2,
    dots: [],
  },
  dots: {
    size: SIZE,
    strokes: [],
    strokeWidth: 0,
    dots: [
      { cx: 2, cy: 2, r: 1.5 },
      { cx: 6, cy: 6, r: 1.5 },
    ],
  },
};

export function patternSpec(id: PatternId): PatternSpec {
  return SPECS[id];
}

/** Patterns in preference order for bars and slices (`null` = solid, as drawn). */
export const PATTERNS: readonly PatternId[] = [
  'diagonal',
  'crosshatch',
  'dots',
  'horizontal',
  'vertical',
  'diagonal-reverse',
];
