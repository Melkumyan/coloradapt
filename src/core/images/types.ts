import type { ColorValue, ImageConfidence, ImageKind, ImageSource } from '@domain/models';

/** RGBA, 8 bits per channel, not premultiplied (what `getImageData` returns). */
export interface PixelBuffer {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** A dominant color of an image, after merging shades and dropping noise. */
export interface ColorCluster {
  /** Mean sRGB of the member pixels, opaque. */
  readonly color: ColorValue;
  readonly oklab: readonly [number, number, number];
  /** Share of visible pixels, 0-1. */
  readonly share: number;
  readonly chroma: number;
  readonly neutral: boolean;
}

/** What the pixels say: engineering signals only (docs/IMAGE_ADAPTATION.md, "Cluster analysis"). */
export interface PixelStats {
  readonly width: number;
  readonly height: number;
  readonly sampledPixels: number;
  readonly visiblePixels: number;
  /** Share of pixels that are (nearly) transparent. */
  readonly transparentShare: number;
  /** Share of visible pixels that are neutral (white, black, gray). */
  readonly neutralShare: number;
  /** Histogram cells in use (distinct quantized colors). */
  readonly distinctCells: number;
  readonly entropyBits: number;
  /** Share of neighbouring visible pairs that are the same color (flat regions). */
  readonly flatShare: number;
  /** Share of neighbouring visible pairs that form a sharp edge. */
  readonly edgeShare: number;
  readonly clusters: readonly ColorCluster[];
  /** Share of visible pixels in clusters too small to count (fringes, noise). */
  readonly noiseShare: number;
}

export type SourceFormat =
  'png' | 'jpeg' | 'gif' | 'webp' | 'avif' | 'svg' | 'bmp' | 'ico' | 'unknown';

/** What the DOM says about one image. Plain data: the core never sees a node. */
export interface ImageFacts {
  readonly source: ImageSource;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  readonly renderedWidth: number;
  readonly renderedHeight: number;
  /** `null` when the attribute is absent; `''` is an explicit "decorative". */
  readonly alt: string | null;
  readonly role: string | null;
  readonly ariaHidden: boolean;
  /** Tokens of alt, aria-label and title. */
  readonly labelTokens: readonly string[];
  /** Tokens of class, id and the file name. */
  readonly ownTokens: readonly string[];
  /** Tokens of the nearest ancestors (class, id, role, tag). */
  readonly contextTokens: readonly string[];
  /** Inside a link, button or button-like role. */
  readonly interactive: boolean;
  /** A link to the site root: the usual home of a brand mark. */
  readonly linksHome: boolean;
  readonly srcKind: 'http' | 'data' | 'blob' | 'other' | 'none';
  readonly format: SourceFormat;
  /** `srcset`, `sizes` or `<picture>`: the displayed resource follows the browser's choice. */
  readonly responsive: boolean;
  readonly imageMap: boolean;
  /** `filter`, `mix-blend-mode`, `mask`, or other CSS that changes what the pixels look like. */
  readonly cssEffects: boolean;
}

export interface ImageEvidence {
  readonly signal: string;
  /** Which kind it points to. */
  readonly supports: ImageKind;
}

export interface ImageClassification {
  readonly kind: ImageKind;
  readonly confidence: ImageConfidence;
  readonly evidence: readonly ImageEvidence[];
}
