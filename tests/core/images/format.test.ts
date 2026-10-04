import { describe, expect, it } from 'vitest';
import { formatFromUrl, sniffImage } from '@core/images';

function chunk(type: string, length = 0): number[] {
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

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function gif(frames: number): Uint8Array {
  const header = [...'GIF89a'].map((c) => c.charCodeAt(0));
  const screen = [1, 0, 1, 0, 0x00, 0, 0]; // no global color table
  const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 2, 1, 0x00, 0x00]; // descriptor, LZW size, one sub-block, terminator
  return Uint8Array.from([...header, ...screen, ...new Array(frames).fill(frame).flat(), 0x3b]);
}

describe('sniffImage', () => {
  it('tells a still PNG from an APNG by the acTL chunk', () => {
    const still = Uint8Array.from([
      ...PNG_SIGNATURE,
      ...chunk('IHDR', 13),
      ...chunk('IDAT', 4),
      ...chunk('IEND'),
    ]);
    const animated = Uint8Array.from([
      ...PNG_SIGNATURE,
      ...chunk('IHDR', 13),
      ...chunk('acTL', 8),
      ...chunk('IDAT', 4),
    ]);
    expect(sniffImage(still)).toEqual({ format: 'png', animated: false });
    expect(sniffImage(animated)).toEqual({ format: 'png', animated: true });
  });

  it('counts GIF frames', () => {
    expect(sniffImage(gif(1))).toEqual({ format: 'gif', animated: false });
    expect(sniffImage(gif(3))).toEqual({ format: 'gif', animated: true });
  });

  it('reads the WebP animation flag and the AVIF brand', () => {
    const webp = (flags: number) =>
      Uint8Array.from([
        ...[...'RIFF'].map((c) => c.charCodeAt(0)),
        0,
        0,
        0,
        0,
        ...[...'WEBPVP8X'].map((c) => c.charCodeAt(0)),
        10,
        0,
        0,
        0,
        flags,
        0,
        0,
        0,
      ]);
    expect(sniffImage(webp(0x02))).toEqual({ format: 'webp', animated: true });
    expect(sniffImage(webp(0x00))).toEqual({ format: 'webp', animated: false });
    const avif = (brand: string) =>
      Uint8Array.from([
        0,
        0,
        0,
        24,
        ...[...'ftyp'].map((c) => c.charCodeAt(0)),
        ...[...brand].map((c) => c.charCodeAt(0)),
        0,
        0,
        0,
        0,
      ]);
    expect(sniffImage(avif('avif'))).toEqual({ format: 'avif', animated: false });
    expect(sniffImage(avif('avis'))).toEqual({ format: 'avif', animated: true });
  });

  it('recognizes JPEG and refuses to guess about anything else', () => {
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0, 0, 0, 0, 0, 0]))).toEqual({
      format: 'jpeg',
      animated: false,
    });
    expect(sniffImage(new Uint8Array(40))).toEqual({ format: 'unknown', animated: null });
    expect(sniffImage(new Uint8Array(3))).toEqual({ format: 'unknown', animated: null });
  });

  it('does not run off the end of a truncated file', () => {
    const truncated = Uint8Array.from([
      ...PNG_SIGNATURE,
      0,
      0,
      0xff,
      0xff,
      ...[...'tEXt'].map((c) => c.charCodeAt(0)),
    ]);
    expect(sniffImage(truncated).animated).toBeNull();
  });
});

describe('formatFromUrl', () => {
  it('reads extensions and data-URL types, query strings ignored', () => {
    expect(formatFromUrl('https://x.test/a/icon.PNG?v=2')).toBe('png');
    expect(formatFromUrl('/img/spin.gif#x')).toBe('gif');
    expect(formatFromUrl('data:image/svg+xml;utf8,<svg/>')).toBe('svg');
    expect(formatFromUrl('data:image/png;base64,AAAA')).toBe('png');
    expect(formatFromUrl('blob:http://x/uuid')).toBe('unknown');
    expect(formatFromUrl('https://x.test/download')).toBe('unknown');
  });
});
