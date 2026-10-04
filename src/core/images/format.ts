import { IMAGE_LIMITS } from '@shared/constants';
import type { SourceFormat } from './types';

export interface SniffedImage {
  readonly format: SourceFormat;
  /** `true`/`false` when the bytes settle it, `null` when they cannot be told. */
  readonly animated: boolean | null;
}

const UNKNOWN: SniffedImage = { format: 'unknown', animated: null };

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let i = start; i < start + length && i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[i]!);
  }
  return out;
}

function u32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
  );
}

function sniffPng(bytes: Uint8Array): SniffedImage {
  // Chunks: length(4) type(4) data crc(4). `acTL` before the first `IDAT` marks APNG.
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = u32(bytes, at);
    const type = ascii(bytes, at + 4, 4);
    if (type === 'acTL') return { format: 'png', animated: true };
    if (type === 'IDAT' || type === 'IEND') return { format: 'png', animated: false };
    at += 12 + length;
  }
  return { format: 'png', animated: null };
}

function sniffGif(bytes: Uint8Array): SniffedImage {
  // Header(6) + logical screen descriptor(7) [+ global color table], then blocks.
  if (bytes.length < 13) return { format: 'gif', animated: null };
  let at = 13;
  if (bytes[10]! & 0x80) at += 3 * (1 << ((bytes[10]! & 7) + 1));
  let frames = 0;
  while (at < bytes.length) {
    const marker = bytes[at]!;
    if (marker === 0x3b) return { format: 'gif', animated: frames > 1 };
    if (marker === 0x2c) {
      frames += 1;
      if (frames > 1) return { format: 'gif', animated: true };
      if (at + 10 > bytes.length) break;
      const flags = bytes[at + 9]!;
      at += 10;
      if (flags & 0x80) at += 3 * (1 << ((flags & 7) + 1));
      at += 1; // LZW minimum code size
      while (at < bytes.length && bytes[at] !== 0) at += bytes[at]! + 1;
      at += 1;
    } else if (marker === 0x21) {
      at += 2;
      while (at < bytes.length && bytes[at] !== 0) at += bytes[at]! + 1;
      at += 1;
    } else {
      break;
    }
  }
  return { format: 'gif', animated: frames > 1 ? true : null };
}

/**
 * Recognizes an image format from its first bytes and, where the format has a marker, whether it
 * is animated. Reads at most `maxSniffBytes`; anything it cannot settle is `unknown`/`null` and
 * the caller treats that as "do not touch". Never executes or decodes the image.
 */
export function sniffImage(input: Uint8Array): SniffedImage {
  const bytes =
    input.length > IMAGE_LIMITS.maxSniffBytes
      ? input.subarray(0, IMAGE_LIMITS.maxSniffBytes)
      : input;
  if (bytes.length < 12) return UNKNOWN;
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') return sniffPng(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { format: 'jpeg', animated: false };
  if (ascii(bytes, 0, 3) === 'GIF') return sniffGif(bytes);
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    // VP8X carries an animation flag (bit 1 of the flags byte); a plain VP8/VP8L cannot animate.
    if (ascii(bytes, 12, 4) === 'VP8X') {
      return { format: 'webp', animated: (bytes[20]! & 0x02) !== 0 };
    }
    return { format: 'webp', animated: false };
  }
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (brand === 'avif') return { format: 'avif', animated: false };
    if (brand === 'avis') return { format: 'avif', animated: true };
    return UNKNOWN;
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return { format: 'bmp', animated: false };
  return UNKNOWN;
}

/** Format hint from a URL or data-URL header, before any byte is read. Only a hint. */
export function formatFromUrl(url: string): SourceFormat {
  const data = /^data:image\/([a-z0-9.+-]+)/i.exec(url);
  const token = data
    ? data[1]!.toLowerCase()
    : (/\.([a-z0-9]+)(?:[?#]|$)/i.exec(url.split(/[?#]/)[0] ?? '')?.[1]?.toLowerCase() ?? '');
  switch (token) {
    case 'png':
    case 'apng':
      return 'png';
    case 'jpg':
    case 'jpeg':
    case 'jfif':
      return 'jpeg';
    case 'gif':
      return 'gif';
    case 'webp':
      return 'webp';
    case 'avif':
      return 'avif';
    case 'svg':
    case 'svg+xml':
    case 'svgz':
      return 'svg';
    case 'bmp':
      return 'bmp';
    case 'ico':
    case 'x-icon':
    case 'vnd.microsoft.icon':
      return 'ico';
    default:
      return 'unknown';
  }
}
