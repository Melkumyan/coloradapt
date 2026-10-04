import type { PixelBuffer } from '@core/images';
import type { ImageEnvironment, ReadRequest, ReadResult } from './readability';

/** Loads and decodes an image in a detached `Image`. Resolves `null` if it cannot be decoded. */
function loadImage(request: ReadRequest): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    if (request.crossOrigin !== null) image.crossOrigin = request.crossOrigin;
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.decoding = 'async';
    image.src = request.url;
  });
}

function isSecurityError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'SecurityError';
}

/** Reads the pixels of one image onto a bounded offscreen canvas, then releases the canvas. */
async function readPixels(request: ReadRequest): Promise<ReadResult> {
  const image = await loadImage(request);
  if (!image || image.naturalWidth === 0) return { status: 'unavailable' };
  const canvas = document.createElement('canvas');
  canvas.width = request.width;
  canvas.height = request.height;
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return { status: 'unavailable' };
    context.imageSmoothingEnabled = true;
    context.drawImage(image, 0, 0, request.width, request.height);
    const data = context.getImageData(0, 0, request.width, request.height);
    const buffer: PixelBuffer = { width: data.width, height: data.height, data: data.data };
    return { status: 'readable', buffer };
  } catch (error) {
    // A tainted canvas refuses `getImageData`. That is the browser enforcing same-origin policy: respected, not worked around.
    if (isSecurityError(error)) return { status: 'tainted' };
    return { status: 'unavailable' };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function encode(buffer: PixelBuffer): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = buffer.width;
  canvas.height = buffer.height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');
    context.putImageData(
      new ImageData(new Uint8ClampedArray(buffer.data), buffer.width, buffer.height),
      0,
      0,
    );
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('encode failed'))),
        'image/png',
      );
    });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** Bytes of a resource the page could itself fetch: same origin, `data:`, `blob:`, or CORS-enabled. */
async function fetchBytes(
  url: string,
  maxBytes: number,
  crossOrigin: string | null,
): Promise<Uint8Array | null> {
  try {
    const target = new URL(url, document.baseURI);
    const sameOrigin = target.origin === new URL(document.baseURI).origin;
    const local = sameOrigin || target.protocol === 'data:' || target.protocol === 'blob:';
    // Cross-origin only when the page itself fetches it with CORS: nothing the page was not allowed to read.
    if (!local && crossOrigin === null) return null;
    const response = await fetch(
      target.href,
      local
        ? { credentials: 'same-origin', cache: 'force-cache' }
        : {
            mode: 'cors',
            credentials: crossOrigin === 'use-credentials' ? 'include' : 'omit',
            cache: 'force-cache',
          },
    );
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length > maxBytes ? bytes.subarray(0, maxBytes) : bytes;
  } catch {
    return null;
  }
}

/** The production environment: offscreen canvas, `fetch`, object URLs. */
export const defaultImageEnvironment: ImageEnvironment = {
  readPixels,
  encode,
  fetchBytes,
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
};
