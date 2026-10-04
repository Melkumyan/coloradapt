/**
 * Plain data of the raster-image layer (M8, docs/IMAGE_ADAPTATION.md). The pure core
 * (`core/images`) and the browser layer (`features/images`) share these; neither needs the
 * other's code. Pixels never appear here: only counts, categories and decisions.
 */

/**
 * What an image probably is. These are engineering categories chosen from deterministic
 * signals (docs/IMAGE_ADAPTATION.md, "Classification"), not a statement about the picture.
 */
export type ImageKind =
  | 'unknown'
  | 'photograph'
  | 'decorative'
  | 'logo'
  | 'illustration'
  /** Small multi-color bitmap that belongs to a user interface. */
  | 'ui-raster'
  /** Small bitmap with exactly one chromatic paint (plus transparency / neutrals): the only kind M8 recolors. */
  | 'monochrome-icon'
  | 'status-graphic'
  | 'diagram'
  | 'chart-raster'
  | 'screenshot'
  | 'complex-artwork';

/** How sure the classifier is. Only `HIGH` can lead to a pixel transformation. */
export type ImageConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

/** What the image layer did (or decided not to do) with one image. */
export type ImageAction =
  /** Looked at and deliberately left alone (a photograph, a logo, ...). */
  | 'unchanged'
  /** A functional image whose colors already tell apart under the profile. */
  | 'not-needed'
  /** Cannot be handled safely (unreadable, animated, masked, ...). */
  | 'unsupported'
  /** Recolored: a generated bitmap is shown instead of the original. */
  | 'pixel-adapted'
  /** Reserved. A non-color marker over a status image belongs to M6; M8 never produces it. */
  | 'overlay-cue'
  /** Not decided yet (waiting for load or for its turn). */
  | 'pending';

/** Why an image has the action it has. Engineering classifications, never claims about the picture. */
export type ImageReason =
  // unchanged
  | 'decorative'
  | 'photograph'
  | 'logo'
  | 'screenshot'
  | 'illustration'
  | 'complex-artwork'
  | 'ui-raster'
  | 'low-confidence'
  /** A status graphic: the semantic layer (M6) owns its non-color cue; pixels are left alone. */
  | 'status-defers-to-semantics'
  | 'adapt-images-off'
  // not-needed
  | 'normal-vision'
  | 'already-distinguishable'
  // unsupported
  | 'not-loaded'
  | 'unavailable'
  | 'unreadable'
  | 'too-large'
  | 'animated'
  | 'svg-source'
  | 'css-background'
  /** `<input type="image">`: recognized, not adapted in M8. */
  | 'input-image'
  | 'responsive-source'
  | 'image-map'
  | 'css-effects'
  | 'chart-raster'
  | 'diagram'
  | 'insufficient-context'
  | 'format-unknown'
  | 'no-safe-candidate'
  /** More than one chromatic paint: what each color means is not known. */
  | 'not-monochrome'
  /** Only neutral colors (white, black, gray): nothing in the image depends on hue. */
  | 'achromatic'
  /** Strength 0: nothing to apply. */
  | 'strength-zero'
  | 'verification-failed'
  | 'load-failed'
  | 'budget'
  | 'queue-full'
  // adapted
  | 'adapted';

/** Where an image comes from. Only `img` is adapted; the others get an explicit policy. */
export type ImageSource = 'img' | 'input-image' | 'css-background';

/** Can the page's pixels be read by the browser's rules? (docs/IMAGE_ADAPTATION.md, "Readability") */
export type ImageReadability =
  | 'readable'
  /** Cross-origin without CORS (or any other canvas taint): never read, never transformed. */
  | 'tainted'
  | 'unavailable'
  | 'not-loaded'
  | 'unknown';

/** Counters and gauges of the image layer, for tests and debugging only. No telemetry. */
export interface ImageDiagnostics {
  /** Counters (only grow). */
  readonly imagesDiscovered: number;
  readonly imagesReadable: number;
  readonly imagesUnreadable: number;
  readonly imagesClassified: number;
  readonly imagesFunctional: number;
  readonly imagesAdapted: number;
  readonly imagesUnsupported: number;
  readonly pixelsSampled: number;
  readonly blobsCreated: number;
  readonly blobsRevoked: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  /** Results discarded because the image changed (source, context) while they were computed. */
  readonly staleResultsDiscarded: number;
  /** Generated bitmaps the browser refused to show (strict page CSP, ...); rolled back. */
  readonly loadFailures: number;
  /** Raster charts / screenshots / photographs recognized (detect-only). */
  readonly rasterCharts: number;
  readonly photographs: number;
  readonly backgroundImages: number;
  /** Gauges (right now). */
  readonly imagesTracked: number;
  /** Images showing a generated bitmap. */
  readonly imageOwners: number;
  /** Object URLs created by ColorAdapt and not revoked yet. */
  readonly ownedUrls: number;
  readonly cachedImages: number;
  readonly pendingReads: number;
  readonly queuedImages: number;
  /** Elements the load/error bridge listens for (always 0 or 1 listener). */
  readonly loadListeners: number;
  /** Listeners on the OS color-scheme query (0 or 1; only while the layer is active). */
  readonly themeListeners: number;
  /** Re-evaluations of background-dependent images caused by an OS color-scheme change. */
  readonly themeReevaluations: number;
}

export const EMPTY_IMAGE_DIAGNOSTICS: ImageDiagnostics = {
  imagesDiscovered: 0,
  imagesReadable: 0,
  imagesUnreadable: 0,
  imagesClassified: 0,
  imagesFunctional: 0,
  imagesAdapted: 0,
  imagesUnsupported: 0,
  pixelsSampled: 0,
  blobsCreated: 0,
  blobsRevoked: 0,
  cacheHits: 0,
  cacheMisses: 0,
  staleResultsDiscarded: 0,
  loadFailures: 0,
  rasterCharts: 0,
  photographs: 0,
  backgroundImages: 0,
  imagesTracked: 0,
  imageOwners: 0,
  ownedUrls: 0,
  cachedImages: 0,
  pendingReads: 0,
  queuedImages: 0,
  loadListeners: 0,
  themeListeners: 0,
  themeReevaluations: 0,
};
