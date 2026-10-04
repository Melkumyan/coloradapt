import type {
  ImageAction,
  ImageKind,
  ImageReadability,
  ImageReason,
  VisionProfile,
} from '@domain/models';
import { IMAGE_LIMITS } from '@shared/constants';
import { exceedsSourceBudget } from './sampling';
import type { ImageClassification, ImageFacts } from './types';

export interface ImagePolicyInput {
  readonly facts: ImageFacts;
  readonly classification: ImageClassification;
  readonly readability: ImageReadability;
  readonly adaptImages: boolean;
  readonly profile: VisionProfile;
}

export interface ImageDecision {
  readonly action: ImageAction;
  readonly reason: ImageReason;
  /** True only when the image may proceed to a transformation plan. */
  readonly candidate: boolean;
}

function decision(action: ImageAction, reason: ImageReason, candidate = false): ImageDecision {
  return { action, reason, candidate };
}

/**
 * What may be known before any pixel is read. Nothing here needs the image's bytes, so a refusal
 * costs nothing and, by construction, reads nothing: decorative images, a switched-off layer, a
 * normal-vision profile, a CSS background (explicit policy: detect only), an image that is not
 * (yet) loaded, broken, or absurdly large.
 */
export function gateBeforeRead(
  facts: ImageFacts,
  adaptImages: boolean,
  profile: VisionProfile,
  loaded: 'loaded' | 'loading' | 'broken',
  decorative: boolean,
): ImageDecision | null {
  if (!adaptImages) return decision('unchanged', 'adapt-images-off');
  if (facts.source === 'css-background') return decision('unsupported', 'css-background');
  if (decorative) return decision('unchanged', 'decorative');
  if (profile === 'normal') return decision('not-needed', 'normal-vision');
  if (loaded === 'loading') return decision('pending', 'not-loaded');
  if (loaded === 'broken') return decision('unsupported', 'unavailable');
  if (exceedsSourceBudget(facts.naturalWidth, facts.naturalHeight)) {
    return decision('unsupported', 'too-large');
  }
  return null;
}

const UNCHANGED_BY_KIND: Partial<Record<ImageKind, ImageReason>> = {
  photograph: 'photograph',
  logo: 'logo',
  screenshot: 'screenshot',
  illustration: 'illustration',
  'complex-artwork': 'complex-artwork',
  'ui-raster': 'ui-raster',
  'status-graphic': 'status-defers-to-semantics',
};

/**
 * The decision once the image has been read and classified. The default is "leave it alone":
 * only a `monochrome-icon` classified with `HIGH` confidence, whose source and presentation are
 * safe to replace, becomes a candidate; everything else says why it was left.
 *
 * Why status graphics are not recolored: what a red/green bitmap *means* comes from the page,
 * and the non-color cue for that meaning belongs to M6 (semantic cues), which already works on
 * images through an outline pattern. Recoloring pixels on top would duplicate that cue and
 * invent a meaning for the new colors (docs/IMAGE_ADAPTATION.md, "Status graphics").
 */
export function decideImage(input: ImagePolicyInput): ImageDecision {
  const { facts, classification, readability } = input;

  if (readability === 'tainted' || readability === 'unknown') {
    return decision('unsupported', 'unreadable');
  }
  if (readability === 'unavailable') return decision('unsupported', 'unavailable');
  if (readability === 'not-loaded') return decision('pending', 'not-loaded');

  const kind = classification.kind;
  if (kind === 'decorative') return decision('unchanged', 'decorative');
  if (kind === 'chart-raster') return decision('unsupported', 'chart-raster');
  if (kind === 'diagram') return decision('unsupported', 'diagram');
  const unchangedReason = UNCHANGED_BY_KIND[kind];
  if (unchangedReason) return decision('unchanged', unchangedReason);
  if (kind !== 'monochrome-icon' || classification.confidence !== 'HIGH') {
    return decision('unchanged', 'low-confidence');
  }

  // A functional monochrome icon. Can its source be replaced without breaking the page?
  if (facts.format === 'svg') return decision('unsupported', 'svg-source');
  if (facts.format === 'gif') return decision('unsupported', 'animated');
  if (facts.source !== 'img') return decision('unsupported', 'input-image');
  if (facts.responsive) return decision('unsupported', 'responsive-source');
  if (facts.imageMap) return decision('unsupported', 'image-map');
  if (facts.cssEffects) return decision('unsupported', 'css-effects');
  if (facts.srcKind === 'other' || facts.srcKind === 'none') {
    return decision('unsupported', 'format-unknown');
  }
  if (Math.max(facts.naturalWidth, facts.naturalHeight) > IMAGE_LIMITS.maxIconDimension) {
    return decision('unsupported', 'too-large');
  }
  return decision('pending', 'adapted', true);
}
