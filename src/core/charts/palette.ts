import type { ColorValue, ModelConfidence, VisionModel, VisionProfile } from '@domain/models';
import { VISION_PROFILE_CONFIDENCE, VISION_PROFILE_INFO } from '@domain/models';
import { calculatePerceptualDistance, convertColor } from '@core/color';
import { defaultVisionSimulator } from '@core/vision';
import { CHART_PAIR_DISTANCE } from '@shared/constants';
import { dashArrayFor } from './line-style';
import type { ChartSeries, Encoding, ExistingEncoding, PairReport } from './types';

/** Profiles with a simulation behind them; `normal` and `custom` simulate nothing. */
export function isSimulated(profile: VisionProfile): boolean {
  return profile !== 'normal' && profile !== 'custom';
}

export interface PairwiseResult {
  readonly profile: VisionProfile;
  readonly model: VisionModel | null;
  /** M2's own status for the profile, passed through unchanged. */
  readonly modelConfidence: ModelConfidence;
  readonly pairs: ReadonlyArray<
    Pick<PairReport, 'a' | 'b' | 'originalDistance' | 'simulatedDistance' | 'problematic'>
  >;
}

function simulate(color: ColorValue, profile: VisionProfile, severity?: number): ColorValue {
  return isSimulated(profile) ? defaultVisionSimulator.simulate(color, profile, severity) : color;
}

/**
 * Pairwise distinguishability of all series colors under the profile (M2 simulation, OKLab
 * distance), not each series against the background. Colors that simulate to within
 * {@link CHART_PAIR_DISTANCE} of each other are `problematic`. Opacity is ignored: a series is
 * its paint; what the page composites it over is not the question here.
 */
export function analyzePairs(
  series: readonly ChartSeries[],
  profile: VisionProfile,
  severity?: number,
): PairwiseResult {
  const resolved = severity ?? VISION_PROFILE_INFO[profile].defaultSeverity;
  const opaque = (color: ColorValue): ColorValue => ({ ...color, alpha: 1 });
  const simulated = series.map((s) => simulate(opaque(s.color), profile, resolved));
  const pairs: PairwiseResult['pairs'][number][] = [];
  for (let i = 0; i < series.length; i += 1) {
    for (let j = i + 1; j < series.length; j += 1) {
      const a = series[i] as ChartSeries;
      const b = series[j] as ChartSeries;
      const originalDistance = calculatePerceptualDistance(opaque(a.color), opaque(b.color));
      const simulatedDistance = calculatePerceptualDistance(
        simulated[i] as ColorValue,
        simulated[j] as ColorValue,
      );
      pairs.push({
        a: a.id,
        b: b.id,
        originalDistance,
        simulatedDistance,
        problematic: simulatedDistance < CHART_PAIR_DISTANCE,
      });
    }
  }
  return {
    profile,
    model: isSimulated(profile) ? defaultVisionSimulator.modelFor(profile) : null,
    modelConfidence: VISION_PROFILE_CONFIDENCE[profile],
    pairs,
  };
}

// ------------------------------------------------- non-color signatures of series

/** What a series looks like once color is taken away. */
export interface Signature {
  readonly dash: string | null;
  readonly marker: string | null;
  readonly pattern: string | null;
  readonly pointShape: string | null;
  readonly strokeWidth: number;
  readonly directLabel: boolean;
}

/** The signature of the series as the page drew it. */
export function existingSignature(existing: ExistingEncoding): Signature {
  return {
    dash: existing.dash,
    marker: existing.markerRef,
    pattern: existing.patternRef,
    pointShape: existing.pointShape,
    strokeWidth: existing.strokeWidth,
    directLabel: existing.directLabel,
  };
}

/** The signature after `encoding` is written on top of what the page drew. */
export function effectiveSignature(series: ChartSeries, encoding: Encoding): Signature {
  const base = existingSignature(series.existing);
  const dash =
    encoding.dash !== 'solid' ? dashArrayFor(encoding.dash, base.strokeWidth) : base.dash;
  if (series.kind === 'point') {
    return {
      ...base,
      dash,
      pointShape: encoding.marker ? `enc:${encoding.marker}` : base.pointShape,
    };
  }
  return {
    ...base,
    dash,
    marker: encoding.marker ? `enc:${encoding.marker}` : base.marker,
    pattern: encoding.pattern ? `enc:${encoding.pattern}` : base.pattern,
  };
}

/** A stroke at least this many times thicker than another is told apart by thickness. */
const WIDTH_RATIO = 2;

/**
 * Whether two series differ in at least one channel other than color. `mixed` (a series whose
 * own marks disagree) is never evidence: an unknown is not a difference.
 */
export function signaturesDistinct(a: Signature, b: Signature, kind: ChartSeries['kind']): boolean {
  const differs = (x: string | null, y: string | null) => x !== y && x !== 'mixed' && y !== 'mixed';
  if (differs(a.dash, b.dash)) return true;
  if (differs(a.marker, b.marker)) return true;
  if (differs(a.pattern, b.pattern)) return true;
  if (
    kind === 'point' &&
    a.pointShape !== null &&
    b.pointShape !== null &&
    differs(a.pointShape, b.pointShape)
  ) {
    return true;
  }
  if (a.directLabel && b.directLabel) return true;
  if (kind === 'line') {
    const thin = Math.min(a.strokeWidth, b.strokeWidth);
    const thick = Math.max(a.strokeWidth, b.strokeWidth);
    if (thin > 0 && thick / thin >= WIDTH_RATIO) return true;
  }
  return false;
}

/** Chroma (OKLCH) below which a color is a gray. */
const GRAY_CHROMA = 0.04;
/** Largest hue spread, in degrees, of what is read as one hue. */
const ONE_HUE = 25;
/** Fewer series than this are never a ramp. */
const MIN_RAMP = 4;

/**
 * Whether a palette reads as one ramp (a single hue, or all grays) rather than as categories: the
 * way sequential and diverging encodings look. Categorical redundancy (patterns) on a ramp would
 * suggest categories where the colors mean magnitude, so such a chart is refused, not adapted
 * (docs/CHARTS.md, "Sequential and diverging palettes"). The pale end of a ramp is nearly gray and
 * carries no hue, so hues are compared among the clearly colored members only (at least two of
 * them; their spread, on the circle, within {@link ONE_HUE} degrees). Any other mix is categorical.
 */
export function isSequentialPalette(colors: readonly ColorValue[]): boolean {
  if (colors.length < MIN_RAMP) return false;
  const lch = colors.map((color) => convertColor({ ...color, alpha: 1 }));
  const colored = lch.filter((c) => c.c >= GRAY_CHROMA);
  if (colored.length === 0) return true;
  if (colored.length < 2) return false;
  const hues = colored.map((c) => ((c.h % 360) + 360) % 360).sort((a, b) => a - b);
  let largestGap = 360 - (hues[hues.length - 1] as number) + (hues[0] as number);
  for (let i = 1; i < hues.length; i += 1) {
    largestGap = Math.max(largestGap, (hues[i] as number) - (hues[i - 1] as number));
  }
  return 360 - largestGap <= ONE_HUE;
}

// ------------------------------------------------ diverging and ordered ramps

/** Largest hue spread, in degrees, of one arm of a diverging palette. */
const ARM_SPREAD = 40;
/** Two arms of a diverging palette are at least this far apart in hue. */
const ARM_SEPARATION = 90;
/** Lightness (OKLCH) from which a color is the pale midpoint of a diverging palette (white, a pale yellow). */
const PALE = 0.85;
/** ... and the chroma it stays under (a saturated yellow is a category, not a midpoint). */
const PALE_CHROMA = 0.15;
/** Lightness steps smaller than this do not count as a step. */
const LIGHTNESS_STEP = 0.02;
/** A hue ramp turns in one direction by at most this per step, and this in all. */
const RAMP_STEP = 120;
const RAMP_TOTAL = 300;

function hueOf(c: { h: number }): number {
  return ((c.h % 360) + 360) % 360;
}

/** Splits sorted hues into arms wherever the gap exceeds {@link ARM_SPREAD}; the circle closes. */
function hueArms(hues: readonly number[]): number[][] {
  if (hues.length === 0) return [];
  const sorted = [...hues].sort((a, b) => a - b);
  const arms: number[][] = [[sorted[0] as number]];
  for (let i = 1; i < sorted.length; i += 1) {
    const hue = sorted[i] as number;
    const arm = arms[arms.length - 1] as number[];
    if (hue - (arm[arm.length - 1] as number) > ARM_SPREAD) arms.push([hue]);
    else arm.push(hue);
  }
  const first = arms[0] as number[];
  const last = arms[arms.length - 1] as number[];
  if (
    arms.length > 1 &&
    (first[0] as number) + 360 - (last[last.length - 1] as number) <= ARM_SPREAD
  ) {
    arms[0] = [...last, ...first];
    arms.pop();
  }
  return arms;
}

/**
 * Diverging palette (red - white - blue, brown - teal): two opposite hue arms, joined by a pale
 * neutral midpoint, or by lightness ramps of at least two steps in each arm. Color there encodes
 * the distance from a midpoint, so a pattern per bar would suggest categories that are not there.
 */
export function isDivergingPalette(colors: readonly ColorValue[]): boolean {
  if (colors.length < MIN_RAMP) return false;
  const lch = colors.map((color) => convertColor({ ...color, alpha: 1 }));
  const isPale = (c: { l: number; c: number }) => c.l >= PALE && c.c < PALE_CHROMA;
  const pales = lch.filter(isPale);
  const colored = lch.filter((c) => c.c >= GRAY_CHROMA && !isPale(c));
  if (colored.length < 2) return false;
  const arms = hueArms(colored.map(hueOf));
  if (arms.length !== 2) return false;
  const [one, two] = arms as [number[], number[]];
  const centre = (arm: number[]) => arm.reduce((sum, h) => sum + h, 0) / arm.length;
  const apart = Math.abs(centre(one) - centre(two));
  if (Math.min(apart, 360 - apart) < ARM_SEPARATION) return false;
  if (pales.length > 0) return true;
  // No pale midpoint: each arm has to be a lightness ramp of its own (at least two distinct steps).
  if (colors.length < 5) return false;
  return arms.every((arm) => {
    const members = colored.filter((c) => arm.includes(hueOf(c)));
    const lightness = members.map((c) => c.l).sort((a, b) => a - b);
    return (
      members.length >= 2 &&
      (lightness[lightness.length - 1] as number) - (lightness[0] as number) >= 0.1
    );
  });
}

/**
 * An ordered ramp that is not one hue: lightness rises (or falls) in series order *and* the hue
 * turns one way (blue - cyan - green - yellow - red, viridis, a temperature scale). Categorical
 * palettes are not sorted by lightness and hue at once.
 */
export function isOrderedRamp(colors: readonly ColorValue[]): boolean {
  if (colors.length < MIN_RAMP) return false;
  const lch = colors.map((color) => convertColor({ ...color, alpha: 1 }));
  const steps = lch.slice(1).map((c, i) => c.l - (lch[i] as { l: number }).l);
  const rising = steps.every((step) => step >= LIGHTNESS_STEP);
  const falling = steps.every((step) => step <= -LIGHTNESS_STEP);
  if (!rising && !falling) return false;
  if (lch.some((c) => c.c < GRAY_CHROMA)) return true; // grays in a lightness order: a gray ramp
  const turns = lch.slice(1).map((c, i) => {
    const delta = hueOf(c) - hueOf(lch[i] as { h: number });
    return ((delta + 540) % 360) - 180;
  });
  const sameWay = turns.every((t) => t >= 0) || turns.every((t) => t <= 0);
  const small = turns.every((t) => Math.abs(t) <= RAMP_STEP);
  const total = turns.reduce((sum, t) => sum + Math.abs(t), 0);
  return sameWay && small && total <= RAMP_TOTAL;
}

/** One ramp, a diverging palette, or an ordered scale: color means magnitude, not category. */
export function readsAsOrdered(colors: readonly ColorValue[]): boolean {
  return isSequentialPalette(colors) || isDivergingPalette(colors) || isOrderedRamp(colors);
}
