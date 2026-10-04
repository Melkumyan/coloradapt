import type {
  ColorValue,
  ImageAction,
  ImageReason,
  ModelConfidence,
  VisionAnalysis,
  VisionProfile,
} from '@domain/models';
import { VISION_PROFILE_INFO } from '@domain/models';
import { findAdaptation } from '@core/adaptation';
import { oklabToValidColor } from '@core/adaptation/gamut';
import { simulatePair } from '@core/vision';
import { IMAGE_THRESHOLDS } from '@shared/constants';
import { analyzePixels } from './palette';
import { labChroma, labDistance, rgbBytesToOklab, type Lab } from './oklab';
import { withinTransformBudget } from './sampling';
import type { PixelBuffer } from './types';

export interface IconPlanInput {
  /** Full-resolution pixels of the original image, never of a previous adaptation. */
  readonly buffer: PixelBuffer;
  /** The opaque, solid color the icon is painted over. */
  readonly background: ColorValue;
  readonly profile: VisionProfile;
  readonly severity?: number;
  readonly strength: number;
}

export type IconPlan =
  | {
      readonly status: 'adapted';
      /** A new RGBA array of the same size; alpha identical to the input's. */
      readonly pixels: Uint8ClampedArray;
      readonly from: ColorValue;
      readonly to: ColorValue;
      readonly before: VisionAnalysis;
      readonly after: VisionAnalysis;
      readonly changedPixels: number;
      readonly confidence: ModelConfidence;
    }
  | {
      readonly status: 'declined';
      readonly action: ImageAction;
      readonly reason: ImageReason;
    };

function declined(action: ImageAction, reason: ImageReason): IconPlan {
  return { status: 'declined', action, reason };
}

function byte(channel: number): number {
  return Math.round(Math.min(1, Math.max(0, channel)) * 255);
}

/**
 * Plans the recoloring of a monochrome raster icon: one chromatic paint over transparency (plus
 * neutrals). The paint's color is run through the M3 optimizer against the page background, and
 * only the pixels that belong to that paint are remapped:
 *
 * - alpha is copied byte for byte (geometry, coverage and edge smoothness stay);
 * - neutral pixels (white, black, gray) and anything farther than `remapRadius` from the paint
 *   are untouched;
 * - pixels inside the paint's own cluster receive the full OKLab shift of the paint, pixels in
 *   the ring around it a linearly fading part of it, so shading and antialiased edges keep their
 *   relative structure and no halo appears;
 * - the result is verified (same size, same alpha, target changed, simulated distance really
 *   better) or the plan is declined.
 *
 * Pure: pixels in, pixels out.
 */
export function planMonochromeIcon(input: IconPlanInput): IconPlan {
  const { buffer, background, profile } = input;
  const { width, height, data } = buffer;
  if (!withinTransformBudget(width, height) || data.length !== width * height * 4) {
    return declined('unsupported', 'too-large');
  }
  if (background.alpha !== 1) return declined('unsupported', 'insufficient-context');

  const stats = analyzePixels(buffer);
  const chromatic = stats.clusters.filter((cluster) => !cluster.neutral);
  if (chromatic.length === 0 && stats.visiblePixels > 0)
    return declined('not-needed', 'achromatic');
  if (chromatic.length !== 1) return declined('unsupported', 'not-monochrome');
  const target = chromatic[0]!;
  const targetLab: Lab = target.oklab;
  const minAlpha = IMAGE_THRESHOLDS.minVisibleAlpha * 255;

  // Which pixels are the paint itself, and is its interior opaque (else the visible color depends on alpha)?
  const total = width * height;
  const isCore = new Uint8Array(total);
  let core = 0;
  let opaqueCore = 0;
  for (let i = 0; i < total; i += 1) {
    const o = i * 4;
    if (data[o + 3]! < minAlpha) continue;
    const lab = rgbBytesToOklab(data[o]!, data[o + 1]!, data[o + 2]!);
    if (
      labChroma(lab) >= IMAGE_THRESHOLDS.neutralChroma &&
      labDistance(lab, targetLab) <= IMAGE_THRESHOLDS.clusterMergeDistance
    ) {
      isCore[i] = 1;
      core += 1;
      if (data[o + 3]! >= 242) opaqueCore += 1;
    }
  }
  if (core === 0 || opaqueCore * 2 < core) return declined('unsupported', 'insufficient-context');

  const search = findAdaptation({
    foreground: target.color,
    background,
    profile,
    ...(input.severity !== undefined ? { severity: input.severity } : {}),
    strength: input.strength,
  });
  if (search.status === 'unchanged') {
    if (search.reason === 'normal-vision') return declined('not-needed', 'normal-vision');
    if (search.reason === 'strength-zero') return declined('not-needed', 'strength-zero');
    return declined('not-needed', 'already-distinguishable');
  }
  if (search.status !== 'adapted') return declined('unsupported', 'no-safe-candidate');

  const to = search.outputColor;
  const toLab = rgbBytesToOklab(byte(to.r), byte(to.g), byte(to.b));
  const shift: Lab = [toLab[0] - targetLab[0], toLab[1] - targetLab[1], toLab[2] - targetLab[2]];
  const memo = new Map<number, number>();
  const pixels = new Uint8ClampedArray(data);
  let changed = 0;
  const merge = IMAGE_THRESHOLDS.clusterMergeDistance;
  const radius = IMAGE_THRESHOLDS.remapRadius;

  for (let i = 0; i < total; i += 1) {
    const o = i * 4;
    if (data[o + 3] === 0) continue;
    const r = data[o]!;
    const g = data[o + 1]!;
    const b = data[o + 2]!;
    const rgb = (r << 16) | (g << 8) | b;
    let mapped = memo.get(rgb);
    if (mapped === undefined) {
      mapped = rgb;
      const lab = rgbBytesToOklab(r, g, b);
      if (labChroma(lab) >= IMAGE_THRESHOLDS.neutralChroma) {
        const d = labDistance(lab, targetLab);
        if (d < radius) {
          const weight = d <= merge ? 1 : (radius - d) / (radius - merge);
          const moved = oklabToValidColor(
            lab[0] + shift[0] * weight,
            lab[1] + shift[1] * weight,
            lab[2] + shift[2] * weight,
          );
          if (moved) mapped = (byte(moved.r) << 16) | (byte(moved.g) << 8) | byte(moved.b);
        }
      }
      memo.set(rgb, mapped);
    }
    if (mapped !== rgb) {
      pixels[o] = (mapped >> 16) & 255;
      pixels[o + 1] = (mapped >> 8) & 255;
      pixels[o + 2] = mapped & 255;
      changed += 1;
    }
  }

  // Verification: what was promised, measured on the output.
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (let i = 0; i < total; i += 1) {
    const o = i * 4;
    if (pixels[o + 3] !== data[o + 3]) return declined('unsupported', 'verification-failed');
    if (isCore[i]) {
      sumR += pixels[o]!;
      sumG += pixels[o + 1]!;
      sumB += pixels[o + 2]!;
    }
  }
  const resulting: ColorValue = {
    r: sumR / core / 255,
    g: sumG / core / 255,
    b: sumB / core / 255,
    alpha: 1,
  };
  const severity = input.severity ?? VISION_PROFILE_INFO[profile].defaultSeverity;
  const before = simulatePair(target.color, background, profile, severity);
  const after = simulatePair(resulting, background, profile, severity);
  if (
    changed === 0 ||
    after.simulatedDistance <= before.simulatedDistance + IMAGE_THRESHOLDS.verifyEpsilon
  ) {
    return declined('unsupported', 'verification-failed');
  }
  return {
    status: 'adapted',
    pixels,
    from: target.color,
    to: resulting,
    before,
    after,
    changedPixels: changed,
    confidence: search.confidence,
  };
}
