/**
 * Structural limits and engineering thresholds of the raster-image layer
 * (docs/IMAGE_ADAPTATION.md, "Budgets and thresholds"). They describe what ColorAdapt can
 * model safely and cheaply, not standards and not judgements about pictures. Nothing here is a
 * wall-clock value: an image over a limit is classified and left alone, never half-processed.
 */
export const IMAGE_LIMITS = {
  /** Pixels of the analysis surface: larger images are downsampled to fit (deterministic grid). */
  maxAnalysisPixels: 262_144,
  /** Longest side of the analysis surface. */
  maxAnalysisDimension: 512,
  /** Natural pixels above which an image is not even decoded onto a canvas (`too-large`). */
  maxSourcePixels: 64_000_000,
  /** Largest bitmap ColorAdapt ever allocates to transform (hard allocation ceiling). */
  maxTransformPixels: 1_000_000,
  /** Longest natural side of an icon-like image (the only kind that is recolored). */
  maxIconDimension: 128,
  /** Longest rendered side of an icon-like image. */
  maxIconRenderedDimension: 160,
  /** Dominant color clusters kept per image. */
  maxClusters: 8,
  /** Generated bitmaps kept in memory (one per source + context + profile). */
  maxCachedImages: 32,
  /** Pixels of all cached generated bitmaps together. */
  maxCachedPixels: 2_000_000,
  /** Pixel analyses (statistics only, no pixels) kept per source. */
  maxCachedAnalyses: 256,
  /** Images read at the same time. */
  maxConcurrentReads: 3,
  /** Images waiting for their turn; beyond this they are skipped (`queue-full`). */
  maxQueuedImages: 400,
  /** Images taken from one root per pass (the rest of that pass's roots are still scanned). */
  maxImagesPerPass: 500,
  /** Elements examined while looking for images under one root. */
  maxScannedPerRoot: 5000,
  /** Image elements the load/error bridge may ask M4 about per second burst (queue bound). */
  maxInvalidationsPerFlush: 200,
  /** Ancestor levels read for context evidence (brand, interactive container, ...). */
  contextLevels: 4,
  /** Bytes read to recognise a format and look for animation markers. */
  maxSniffBytes: 262_144,
} as const;

/** Engineering thresholds of pixel analysis (OKLab units unless stated). */
export const IMAGE_THRESHOLDS = {
  /** Alpha (0-1) below which a pixel counts as transparent: no color information. */
  minVisibleAlpha: 0.5,
  /** Edge length of an OKLab histogram cell; also the quantization of the entropy estimate. */
  cellSize: 0.04,
  /** Cells closer than this to a cluster centroid join it (antialiasing shades are not new colors). */
  clusterMergeDistance: 0.09,
  /** A cluster below this share of visible pixels is noise (fringes, JPEG artifacts). */
  minClusterShare: 0.012,
  /** OKLab chroma under which a color counts as neutral (white, black, gray). */
  neutralChroma: 0.04,
  /** Neighbouring pixels closer than this are "flat" (same region). */
  flatDistance: 0.012,
  /** Neighbouring pixels farther than this are a sharp edge. */
  edgeDistance: 0.1,
  /** Pixels within this distance of the target cluster are remapped (smooth falloff). */
  remapRadius: 0.14,
  /** Distinct histogram cells above which an image looks photographic. */
  photoCells: 140,
  /** Entropy (bits, over the histogram) above which an image looks photographic. */
  photoEntropy: 6.2,
  /** Largest simulated-distance loss tolerated as "no worse" when verifying a remap. */
  verifyEpsilon: 1e-6,
} as const;
