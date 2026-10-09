/**
 * A minimal PNG codec for the store assets: Chrome Web Store images must be 24-bit PNG without alpha, and the
 * browsers' screenshots carry an alpha channel. Decodes 8-bit RGB/RGBA (non-interlaced) and writes 8-bit RGB.
 */
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export interface Raster {
  readonly width: number;
  readonly height: number;
  /** RGB, 3 bytes per pixel. */
  readonly rgb: Buffer;
}

export function decodePng(png: Buffer): Raster {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let colorType = 0;
  const data: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0)
        throw new Error('only 8-bit non-interlaced PNG is supported');
      colorType = body[9]!;
    } else if (type === 'IDAT') data.push(body);
    at += 12 + length;
  }
  if (colorType !== 2 && colorType !== 6)
    throw new Error(`unsupported PNG color type ${colorType}`);
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(data));
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? out[y * stride + x - bpp]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp]! : 0;
      let value = line[x]!;
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = value & 0xff;
    }
  }
  if (bpp === 3) return { width, height, rgb: out };
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < out.length; i += 4, j += 3) {
    const alpha = out[i + 3]! / 255;
    // flatten on white, so a transparent pixel never becomes black
    rgb[j] = Math.round(out[i]! * alpha + 255 * (1 - alpha));
    rgb[j + 1] = Math.round(out[i + 1]! * alpha + 255 * (1 - alpha));
    rgb[j + 2] = Math.round(out[i + 2]! * alpha + 255 * (1 - alpha));
  }
  return { width, height, rgb };
}

function encodeRgbPng({ width, height, rgb }: Raster): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'ascii');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Any PNG screenshot to a 24-bit PNG without alpha. */
export const toRgbPng = (png: Buffer): Buffer => encodeRgbPng(decodePng(png));
