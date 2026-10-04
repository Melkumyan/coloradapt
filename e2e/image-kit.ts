import { crc32, deflateSync } from 'node:zlib';
import { expect, type Page } from '@playwright/test';
import type { ImageDiagnostics } from '../src/domain/models';
import type { PixelBuffer } from '../src/core/images';
import { flushDynamic, type ExtensionSession, type PageServer } from './harness';
import { load, type Loaded } from './r1-kit';
import { blank, disc, hex, monoIcon, photograph, rect } from '../tests/core/images/pixels';

/**
 * Shared pieces of the M8 real-browser suites: a PNG encoder (so fixtures are real images the
 * browser decodes), page builders, and readers of what the browser actually shows (displayed
 * pixels through a canvas, element screenshots, computed layout, the accessibility tree).
 * Nothing sleeps: waits poll counters and DOM state.
 */
export const IMAGE_SETTINGS = {
  enabled: true,
  visionProfile: 'deuteranopia',
  adaptationStrength: 1,
  adaptImages: true,
  // Only the image layer is under test here: other layers stay off so they cannot hide a bug.
  adaptSVG: false,
  adaptCharts: false,
  semanticCuesEnabled: false,
  improveUIColors: false,
  improveLinks: false,
  improveStatusIndicators: false,
} as const;

export { blank, disc, hex, monoIcon, photograph, rect };

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length);
  return out;
}

function pngParts(buffer: PixelBuffer): { header: Buffer; compressed: Buffer } {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(buffer.width, 0);
  header.writeUInt32BE(buffer.height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = buffer.width * 4;
  const raw = Buffer.alloc((stride + 1) * buffer.height);
  for (let y = 0; y < buffer.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(buffer.data.buffer, buffer.data.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  return { header, compressed: deflateSync(raw) };
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Encodes RGBA pixels as a PNG (8-bit, color type 6). */
export function png(buffer: PixelBuffer): Buffer {
  const { header, compressed } = pngParts(buffer);
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A genuine two-frame APNG (the same picture twice): browsers animate it. */
export function apng(buffer: PixelBuffer): Buffer {
  const { header, compressed } = pngParts(buffer);
  const control = Buffer.alloc(8);
  control.writeUInt32BE(2, 0); // frames
  const frameControl = (sequence: number): Buffer => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence, 0);
    data.writeUInt32BE(buffer.width, 4);
    data.writeUInt32BE(buffer.height, 8);
    data.writeUInt16BE(1, 20); // delay numerator
    data.writeUInt16BE(10, 22); // delay denominator
    return chunk('fcTL', data);
  };
  const frameData = Buffer.concat([Buffer.alloc(4), compressed]);
  frameData.writeUInt32BE(2, 0);
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('acTL', control),
    frameControl(0),
    chunk('IDAT', compressed),
    frameControl(1),
    chunk('fdAT', frameData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A genuine two-frame GIF (1x1). */
export const TWO_FRAME_GIF = Buffer.from([
  ...Buffer.from('GIF89a', 'ascii'),
  1,
  0,
  1,
  0,
  0x80,
  0,
  0,
  0xff,
  0,
  0,
  0,
  0,
  0xff,
  0x21,
  0xf9,
  4,
  0,
  10,
  0,
  0,
  0,
  0x2c,
  0,
  0,
  0,
  0,
  1,
  0,
  1,
  0,
  0,
  2,
  2,
  0x44,
  1,
  0,
  0x21,
  0xf9,
  4,
  0,
  10,
  0,
  0,
  0,
  0x2c,
  0,
  0,
  0,
  0,
  1,
  0,
  1,
  0,
  0,
  2,
  2,
  0x4c,
  1,
  0,
  0x3b,
]);

export const RED = hex('#d62728');
export const OLIVE = '#6b8e23';
export const GREEN = '#2ca02c';

/** A page with `body` inside a styled container; `head` may add a CSP meta or styles. */
export function html(body: string, options: { background?: string; head?: string } = {}): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>images</title>${options.head ?? ''}
<style>body{margin:0;padding:8px;background:${options.background ?? GREEN}} #host{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start}</style>
</head><body><div id="host">${body}</div></body></html>`;
}

export function serveImage(server: PageServer, name: string, buffer: PixelBuffer): void {
  server.serveRaw(name, png(buffer), 'image/png');
}

let counter = 0;

/** Serves `markup` as a fresh page and loads it with ColorAdapt ON and the page quiet. */
export async function openImages(
  ext: ExtensionSession,
  server: PageServer,
  markup: string,
  options: { settings?: Record<string, unknown>; background?: string; head?: string } = {},
): Promise<Loaded> {
  counter += 1;
  const name = `images-${counter}.html`;
  server.serve(name, html(markup, options));
  return load(ext, server, name, options.settings ?? IMAGE_SETTINGS);
}

export const imageCounters = async (view: Loaded): Promise<ImageDiagnostics> =>
  (await view.diag()).images;

/** Polls the image layer until it is idle and `condition` holds; flushes the pipeline on every poll. */
export async function whenIdle(
  ext: ExtensionSession,
  view: Loaded,
  condition: (counters: ImageDiagnostics) => boolean = () => true,
): Promise<ImageDiagnostics> {
  let last: ImageDiagnostics | null = null;
  await expect
    .poll(async () => {
      const diagnostics = await flushDynamic(ext.worker, view.page);
      last = diagnostics.images;
      return last.pendingReads === 0 && last.queuedImages === 0 && condition(last);
    })
    .toBe(true);
  return last!;
}

export interface Shown {
  readonly src: string | null;
  readonly currentSrc: string;
  readonly adapted: boolean;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  readonly box: { x: number; y: number; width: number; height: number };
}

export function shown(page: Page, selector: string): Promise<Shown> {
  return page.evaluate((sel) => {
    const img = document.querySelector<HTMLImageElement>(sel)!;
    const rect = img.getBoundingClientRect();
    return {
      src: img.getAttribute('src'),
      currentSrc: img.currentSrc,
      adapted: img.hasAttribute('data-coloradapt-image'),
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  }, selector);
}

/** Pixels the browser shows for `<img>` (decoded bitmap, drawn at its natural size). Same-origin or blob only. */
export function displayedPixels(page: Page, selector: string): Promise<number[]> {
  return page.evaluate((sel) => {
    const img = document.querySelector<HTMLImageElement>(sel)!;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(img, 0, 0);
    return [...context.getImageData(0, 0, canvas.width, canvas.height).data];
  }, selector);
}

/** The pixels of the resource at `url`, loaded fresh (so ColorAdapt's swap is not in the way). */
export function pixelsOfUrl(page: Page, url: string): Promise<number[]> {
  return page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(img, 0, 0);
    return [...context.getImageData(0, 0, canvas.width, canvas.height).data];
  }, url);
}

/** A real JPEG, made by the browser itself from smooth noise: the statistics of a photograph. */
export async function jpegPhotograph(page: Page, width: number, height: number): Promise<Buffer> {
  const base64 = await page.evaluate(
    ({ w, h }) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext('2d')!;
      const image = context.createImageData(w, h);
      let seed = 12345;
      const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const i = (y * w + x) * 4;
          const u = x / w;
          const v = y / h;
          const grain = (random() - 0.5) * 28;
          image.data[i] = 128 + 110 * Math.sin(u * 3 + 1) + grain;
          image.data[i + 1] = 128 + 100 * Math.sin(v * 4 + 2) + grain;
          image.data[i + 2] = 128 + 120 * Math.sin((u + v) * 2.5 + 3) + grain;
          image.data[i + 3] = 255;
        }
      }
      context.putImageData(image, 0, 0);
      return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]!;
    },
    { w: width, h: height },
  );
  return Buffer.from(base64, 'base64');
}

export function rasterChartPixels(): PixelBuffer {
  const chart = blank(240, 140, hex('#ffffff'));
  rect(chart, 20, 8, 1, 120, hex('#3c3c3c'));
  rect(chart, 20, 123, 210, 1, hex('#3c3c3c'));
  rect(chart, 30, 60, 30, 63, hex('#d62728'));
  rect(chart, 80, 40, 30, 83, hex('#2ca02c'));
  rect(chart, 130, 80, 30, 43, hex('#1f77b4'));
  return chart;
}

/** The accessibility tree of `selector`, as the browser reports it (role, name, state), as text. */
export function ariaTree(page: Page, selector: string): Promise<string> {
  return page.locator(selector).ariaSnapshot();
}

void RED;
