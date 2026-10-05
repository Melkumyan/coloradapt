/**
 * A minimal PNG decoder (8-bit, non-interlaced, color types 0/2/3/4/6) and the visual metrics the real-world
 * suite compares ColorAdapt OFF and ON screenshots with. No dependency: it exists so the visual regression
 * subset runs the same way in Chrome and Firefox without adding a package.
 */
import { inflateSync } from 'node:zlib';

export interface Bitmap {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel. */
  readonly data: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(buffer: Buffer): Bitmap {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
    } else if (type === 'PLTE') palette = Buffer.from(body);
    else if (type === 'IDAT') idat.push(Buffer.from(body));
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (depth !== 8 || interlace !== 0 || CHANNELS[colorType] === undefined) {
    throw new Error(`unsupported PNG (depth ${depth}, type ${colorType}, interlace ${interlace})`);
  }
  const channels = CHANNELS[colorType]!;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const row = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const cur = raw[row + x]!;
      const left = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels]! : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = cur;
          break;
        case 1:
          value = cur + left;
          break;
        case 2:
          value = cur + up;
          break;
        case 3:
          value = cur + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value = cur + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          throw new Error(`bad PNG filter ${filter}`);
      }
      pixels[y * stride + x] = value & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    let r: number;
    let g: number;
    let b: number;
    let a = 255;
    if (colorType === 6)
      [r, g, b, a] = [pixels[s]!, pixels[s + 1]!, pixels[s + 2]!, pixels[s + 3]!];
    else if (colorType === 2) [r, g, b] = [pixels[s]!, pixels[s + 1]!, pixels[s + 2]!];
    else if (colorType === 0) r = g = b = pixels[s]!;
    else if (colorType === 4) {
      r = g = b = pixels[s]!;
      a = pixels[s + 1]!;
    } else {
      const index = pixels[s]! * 3;
      [r, g, b] = [palette![index]!, palette![index + 1]!, palette![index + 2]!];
    }
    rgba.set([r, g, b, a], i * 4);
  }
  return { width, height, data: rgba };
}

export interface VisualDiff {
  readonly width: number;
  readonly height: number;
  /** Share of pixels whose largest channel difference is above the threshold. */
  readonly changedRatio: number;
  readonly meanAbsDiff: number;
  /** Detail blocks (many edges) in the first image that are nearly flat in the second: vanished text or borders. */
  readonly lostDetailBlocks: number;
  /** Blocks that had detail in the first image. */
  readonly detailBlocks: number;
  /** Blocks flat in the first image that have heavy detail in the second (something unexpected appeared). */
  readonly gainedDetailBlocks: number;
  /** Share of near-uniform pixels in the second image (a blank page is near 1). */
  readonly blankRatioB: number;
  readonly blankRatioA: number;
}

const BLOCK = 32;

function luma(d: Uint8Array, i: number): number {
  return 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
}

/** Edge strength of every BLOCK x BLOCK block: count of neighbor pairs with a luma step above 24. */
function edgeBlocks(img: Bitmap): number[] {
  const bw = Math.ceil(img.width / BLOCK);
  const bh = Math.ceil(img.height / BLOCK);
  const out = new Array<number>(bw * bh).fill(0);
  for (let y = 0; y < img.height - 1; y++) {
    for (let x = 0; x < img.width - 1; x++) {
      const i = (y * img.width + x) * 4;
      const l = luma(img.data, i);
      const dx = Math.abs(l - luma(img.data, i + 4));
      const dy = Math.abs(l - luma(img.data, i + img.width * 4));
      if (dx > 24 || dy > 24) out[Math.floor(y / BLOCK) * bw + Math.floor(x / BLOCK)]! += 1;
    }
  }
  return out;
}

function blankRatio(img: Bitmap): number {
  // Pixels whose neighborhood (right and below) has no luma step: flat areas.
  let flat = 0;
  let total = 0;
  for (let y = 0; y < img.height - 1; y += 2) {
    for (let x = 0; x < img.width - 1; x += 2) {
      const i = (y * img.width + x) * 4;
      const l = luma(img.data, i);
      total++;
      if (
        Math.abs(l - luma(img.data, i + 4)) < 3 &&
        Math.abs(l - luma(img.data, i + img.width * 4)) < 3
      )
        flat++;
    }
  }
  return total === 0 ? 1 : flat / total;
}

export function compareBitmaps(a: Bitmap, b: Bitmap, channelThreshold = 24): VisualDiff {
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  let changed = 0;
  let sum = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ia = (y * a.width + x) * 4;
      const ib = (y * b.width + x) * 4;
      const d = Math.max(
        Math.abs(a.data[ia]! - b.data[ib]!),
        Math.abs(a.data[ia + 1]! - b.data[ib + 1]!),
        Math.abs(a.data[ia + 2]! - b.data[ib + 2]!),
      );
      sum += d;
      if (d > channelThreshold) changed++;
    }
  }
  const ea = edgeBlocks({ width, height, data: crop(a, width, height) });
  const eb = edgeBlocks({ width, height, data: crop(b, width, height) });
  let lost = 0;
  let detail = 0;
  let gained = 0;
  for (let i = 0; i < ea.length; i++) {
    if (ea[i]! >= 20) {
      detail++;
      if (eb[i]! <= ea[i]! * 0.2) lost++;
    } else if (eb[i]! >= 60) gained++;
  }
  return {
    width,
    height,
    changedRatio: changed / (width * height),
    meanAbsDiff: sum / (width * height),
    lostDetailBlocks: lost,
    detailBlocks: detail,
    gainedDetailBlocks: gained,
    blankRatioA: blankRatio(a),
    blankRatioB: blankRatio(b),
  };
}

function crop(img: Bitmap, width: number, height: number): Uint8Array {
  if (img.width === width) return img.data.subarray(0, width * height * 4);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    out.set(img.data.subarray(y * img.width * 4, y * img.width * 4 + width * 4), y * width * 4);
  }
  return out;
}
