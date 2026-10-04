import { IMAGE_LIMITS } from '@shared/constants';

export interface AnalysisSize {
  readonly width: number;
  readonly height: number;
  /** Scale applied to the natural size (1 = not downsampled). */
  readonly scale: number;
}

/**
 * The size of the canvas an image is drawn onto for analysis. Deterministic: a pure function of
 * the natural size and the structural budget. Small images (icons) are analyzed at their own
 * size; large ones are scaled so neither side nor the pixel count exceeds the budget. Dominant
 * colors and major regions survive a downsample; fine detail does not, and nothing here claims it.
 */
export function analysisSize(naturalWidth: number, naturalHeight: number): AnalysisSize {
  const w = Math.max(1, Math.floor(naturalWidth));
  const h = Math.max(1, Math.floor(naturalHeight));
  const scale = Math.min(
    1,
    IMAGE_LIMITS.maxAnalysisDimension / Math.max(w, h),
    Math.sqrt(IMAGE_LIMITS.maxAnalysisPixels / (w * h)),
  );
  if (scale >= 1) return { width: w, height: h, scale: 1 };
  return {
    width: Math.max(1, Math.floor(w * scale)),
    height: Math.max(1, Math.floor(h * scale)),
    scale,
  };
}

/** True when an image is too big to be decoded onto any canvas of ours. */
export function exceedsSourceBudget(naturalWidth: number, naturalHeight: number): boolean {
  return naturalWidth * naturalHeight > IMAGE_LIMITS.maxSourcePixels;
}

/** True when a bitmap of this size may be allocated for a transformation. */
export function withinTransformBudget(width: number, height: number): boolean {
  return width > 0 && height > 0 && width * height <= IMAGE_LIMITS.maxTransformPixels;
}
