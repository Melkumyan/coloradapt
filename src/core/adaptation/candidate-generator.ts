import type { ColorValue } from '@domain/models';
import { toHex, type OklchColor } from '@core/color';
import { ENGINEERING_THRESHOLDS } from './constraints';
import { oklchToValidColor } from './gamut';

/**
 * Progressive, deterministic search stages in OKLCH, in the order they are
 * tried. The optimizer stops at the first stage that yields a feasible
 * candidate, so hue is only touched when lightness/chroma cannot do the job.
 */
export type SearchStage = 'lightness-chroma' | 'small-hue' | 'wide-hue';

interface StageGrid {
  /** Hue offsets in degrees. */
  readonly hueOffsets: readonly number[];
  /** Lightness offsets (OKLCH L, 0-1 scale). */
  readonly lightnessOffsets: readonly number[];
  /** Multipliers of the original chroma. */
  readonly chromaScales: readonly number[];
}

function range(step: number, count: number): number[] {
  const values: number[] = [];
  for (let k = -count; k <= count; k += 1) values.push(Math.round(k * step * 1000) / 1000);
  return values;
}

function symmetric(...degrees: number[]): number[] {
  return degrees.flatMap((d) => [d, -d]);
}

const STAGE_GRIDS: Readonly<Record<SearchStage, StageGrid>> = {
  // Same hue; lightness ±0.45 in 0.03 steps, chroma kept / muted / boosted. ≤93 candidates.
  'lightness-chroma': {
    hueOffsets: [0],
    lightnessOffsets: range(0.03, 15),
    chromaScales: [1, 0.6, 1.3],
  },
  // Hue ±10..30°; lightness ±0.4 in 0.05 steps. ≤306 candidates.
  'small-hue': {
    hueOffsets: symmetric(10, 20, 30),
    lightnessOffsets: range(0.05, 8),
    chromaScales: [1, 0.7, 1.2],
  },
  // Hue ±45..150° and 180°. ≤374 candidates.
  'wide-hue': {
    hueOffsets: [...symmetric(45, 60, 90, 120, 150), 180],
    lightnessOffsets: range(0.05, 8),
    chromaScales: [1, 0.7],
  },
};

export interface Candidate {
  readonly color: ColorValue;
  readonly hex: string;
  readonly stage: SearchStage;
}

/**
 * Stages worth searching for a color. Neutral colors (white/black/gray) have
 * no meaningful hue, so only lightness is ever varied; near-neutral colors
 * have an unstable hue, so only small hue shifts are allowed.
 */
export function searchStagesFor(original: OklchColor): readonly SearchStage[] {
  if (original.c < ENGINEERING_THRESHOLDS.neutralChroma) return ['lightness-chroma'];
  if (original.c < ENGINEERING_THRESHOLDS.nearNeutralChroma) {
    return ['lightness-chroma', 'small-hue'];
  }
  return ['lightness-chroma', 'small-hue', 'wide-hue'];
}

/**
 * Candidates of one stage: valid, 8-bit, de-duplicated against `seen`
 * (which is updated; seed it with the original's hex so the original is
 * never a candidate). Order is a pure function of the input — no randomness.
 */
export function generateStage(
  stage: SearchStage,
  original: OklchColor,
  seen: Set<string>,
): Candidate[] {
  const grid = STAGE_GRIDS[stage];
  const out: Candidate[] = [];

  for (const dh of grid.hueOffsets) {
    for (const scale of grid.chromaScales) {
      for (const dl of grid.lightnessOffsets) {
        const hue = (((original.h + dh) % 360) + 360) % 360;
        const color = oklchToValidColor(original.l + dl, original.c * scale, hue);
        if (!color) continue;
        const hex = toHex(color);
        if (seen.has(hex)) continue;
        seen.add(hex);
        out.push({ color, hex, stage });
      }
    }
  }
  return out;
}
