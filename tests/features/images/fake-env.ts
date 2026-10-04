import type { PixelBuffer } from '@core/images';
import type { ImageEnvironment, ReadRequest, ReadResult } from '@features/images';

/** What a fake "network" holds for one URL. */
export type Resource = PixelBuffer | 'tainted' | 'unavailable';

function pngChunk(type: string, length: number): number[] {
  return [
    (length >>> 24) & 255,
    (length >>> 16) & 255,
    (length >>> 8) & 255,
    length & 255,
    ...[...type].map((c) => c.charCodeAt(0)),
    ...new Array<number>(length).fill(0),
    0,
    0,
    0,
    0,
  ];
}

/** A still PNG: signature, IHDR, an (empty) IDAT, IEND. The sniffer only reads signature and chunk types. */
export const PNG_BYTES = Uint8Array.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...pngChunk('IHDR', 13),
  ...pngChunk('IDAT', 4),
  ...pngChunk('IEND', 0),
]);

export const GIF_TWO_FRAMES = Uint8Array.from([
  ...[...'GIF89a'].map((c) => c.charCodeAt(0)),
  1,
  0,
  1,
  0,
  0,
  0,
  0,
  ...[0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 1, 0, 0],
  ...[0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 1, 0, 0],
  0x3b,
]);

function resample(buffer: PixelBuffer, width: number, height: number): PixelBuffer {
  if (buffer.width === width && buffer.height === height) return buffer;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(buffer.width - 1, Math.floor((x * buffer.width) / width));
      const sy = Math.min(buffer.height - 1, Math.floor((y * buffer.height) / height));
      data.set(
        buffer.data.subarray((sy * buffer.width + sx) * 4, (sy * buffer.width + sx) * 4 + 4),
        (y * width + x) * 4,
      );
    }
  }
  return { width, height, data };
}

/**
 * A browser stand-in for the image layer: a table of URLs, an object-URL registry, and gates that
 * hold a read back until a test releases it (to stage races without sleeping).
 */
export class FakeImageEnvironment implements ImageEnvironment {
  readonly resources = new Map<string, Resource>();
  readonly bytes = new Map<string, Uint8Array>();
  readonly reads: ReadRequest[] = [];
  readonly sniffed: string[] = [];
  readonly created: string[] = [];
  readonly revoked: string[] = [];
  readonly failing = new Set<string>();
  readonly #gates = new Map<string, { promise: Promise<void>; release: () => void }>();
  readonly #blobs = new Map<string, PixelBuffer>();
  readonly #skip = new Map<string, number>();
  #next = 0;
  #inflight = 0;
  /** Most reads that were ever outstanding at once. */
  maxInflight = 0;

  set(url: string, resource: Resource): this {
    this.resources.set(url, resource);
    return this;
  }

  /** Holds reads of `url` (after the first `skip` of them) until `release(url)`. */
  hold(url: string, skip = 0): void {
    this.#skip.set(url, skip + this.reads.filter((read) => read.url === url).length);
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#gates.set(url, { promise, release });
  }

  release(url: string): void {
    this.#gates.get(url)?.release();
    this.#gates.delete(url);
  }

  /** Pixels behind an object URL this environment created. */
  pixelsOf(url: string): PixelBuffer | undefined {
    return this.#blobs.get(url);
  }

  /** Object URLs created and not revoked. */
  get live(): string[] {
    return this.created.filter((url) => !this.revoked.includes(url));
  }

  async readPixels(request: ReadRequest): Promise<ReadResult> {
    this.#inflight += 1;
    this.maxInflight = Math.max(this.maxInflight, this.#inflight);
    try {
      return await this.#read(request);
    } finally {
      this.#inflight -= 1;
    }
  }

  async #read(request: ReadRequest): Promise<ReadResult> {
    this.reads.push(request);
    const seen = this.reads.filter((read) => read.url === request.url).length;
    const gate =
      seen > (this.#skip.get(request.url) ?? 0) ? this.#gates.get(request.url) : undefined;
    if (gate) await gate.promise;
    if (this.failing.has(request.url)) throw new Error('boom');
    const resource = this.resources.get(request.url) ?? 'unavailable';
    if (resource === 'tainted') return { status: 'tainted' };
    if (resource === 'unavailable') return { status: 'unavailable' };
    return { status: 'readable', buffer: resample(resource, request.width, request.height) };
  }

  encode(buffer: PixelBuffer): Promise<Blob> {
    const blob = new Blob([buffer.data.slice()]);
    (blob as Blob & { pixels?: PixelBuffer }).pixels = buffer;
    return Promise.resolve(blob);
  }

  fetchBytes(url: string): Promise<Uint8Array | null> {
    this.sniffed.push(url);
    return Promise.resolve(this.bytes.get(url) ?? PNG_BYTES);
  }

  createObjectURL(blob: Blob): string {
    const url = `blob:fake/${(this.#next += 1)}`;
    this.created.push(url);
    const pixels = (blob as Blob & { pixels?: PixelBuffer }).pixels;
    if (pixels) this.#blobs.set(url, pixels);
    return url;
  }

  revokeObjectURL(url: string): void {
    this.revoked.push(url);
  }
}
