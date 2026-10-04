import type { PixelBuffer } from '@core/images';

/** Outcome of reading an image's pixels the way the browser allows (docs/IMAGE_ADAPTATION.md). */
export type ReadResult =
  | { readonly status: 'readable'; readonly buffer: PixelBuffer }
  /** A canvas that drew this image would be tainted: cross-origin without CORS. Never read around. */
  | { readonly status: 'tainted' }
  /** The resource did not load (404, revoked blob, blocked by CSP, not an image). */
  | { readonly status: 'unavailable' };

export interface ReadRequest {
  readonly url: string;
  /** The page's own `crossorigin` attribute; the read never asks for more access than the page did. */
  readonly crossOrigin: string | null;
  readonly width: number;
  readonly height: number;
}

/**
 * What the image layer needs from the browser. The default implementation (`raster-reader.ts`)
 * uses an offscreen canvas and `fetch`; tests pass a fake. Nothing here talks to the network on
 * its own account beyond reloading the image the page already displays (docs/PRIVACY.md).
 */
export interface ImageEnvironment {
  /** Loads `request.url` into a fresh image and draws it, scaled, onto an offscreen canvas. */
  readPixels(request: ReadRequest): Promise<ReadResult>;
  /** Encodes RGBA pixels as a PNG. */
  encode(buffer: PixelBuffer): Promise<Blob>;
  /**
   * First bytes of a same-origin / data / blob resource, or `null` when they cannot be read. A
   * cross-origin resource is fetched only when the page itself asked for it with CORS (a
   * `crossorigin` attribute, passed as `crossOrigin`), with the same credentials mode.
   */
  fetchBytes(url: string, maxBytes: number, crossOrigin: string | null): Promise<Uint8Array | null>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}
