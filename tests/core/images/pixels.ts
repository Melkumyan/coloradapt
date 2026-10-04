import type { PixelBuffer } from '@core/images';

/** Deterministic painters for synthetic test images (no browser, no files, no randomness beyond a seed). */

export type Rgba = readonly [number, number, number, number];

export function hex(color: string, alpha = 255): Rgba {
  const value = Number.parseInt(color.replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, alpha];
}

export function blank(width: number, height: number, fill: Rgba = [0, 0, 0, 0]): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set(fill, i * 4);
  return { width, height, data };
}

function put(buffer: PixelBuffer, x: number, y: number, color: Rgba): void {
  if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) return;
  buffer.data.set(color, (y * buffer.width + x) * 4);
}

export function rect(
  buffer: PixelBuffer,
  x0: number,
  y0: number,
  w: number,
  h: number,
  color: Rgba,
): PixelBuffer {
  for (let y = y0; y < y0 + h; y += 1)
    for (let x = x0; x < x0 + w; x += 1) put(buffer, x, y, color);
  return buffer;
}

/** A disc with a one-pixel antialiased rim (alpha ramps over the last pixel of radius). */
export function disc(
  buffer: PixelBuffer,
  cx: number,
  cy: number,
  radius: number,
  color: Rgba,
): PixelBuffer {
  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= radius - 1) put(buffer, x, y, color);
      else if (d < radius) {
        const coverage = radius - d;
        put(buffer, x, y, [color[0], color[1], color[2], Math.round(color[3] * coverage)]);
      }
    }
  }
  return buffer;
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth multi-hue field with grain and texture: the statistics of a photograph, not its look. */
export function photograph(width: number, height: number, seed: number): PixelBuffer {
  const random = mulberry32(seed);
  const buffer = blank(width, height, [0, 0, 0, 255]);
  const phase = [random() * 6, random() * 6, random() * 6];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = x / width;
      const v = y / height;
      const grain = (random() - 0.5) * 30;
      const texture = Math.sin(u * 40 + phase[0]!) * Math.cos(v * 33 + phase[1]!) * 18;
      put(buffer, x, y, [
        clamp(128 + 110 * Math.sin(u * 3 + phase[0]!) + grain + texture),
        clamp(128 + 100 * Math.sin(v * 4 + phase[1]!) + grain - texture),
        clamp(128 + 120 * Math.sin((u + v) * 2.5 + phase[2]!) + grain),
        255,
      ]);
    }
  }
  return buffer;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** A small transparent icon: one colored disc with an antialiased rim and a white dot in the middle. */
export function monoIcon(size: number, color: Rgba, withWhiteDot = true): PixelBuffer {
  const buffer = blank(size, size);
  disc(buffer, size / 2, size / 2, size / 2 - 1, color);
  if (withWhiteDot) disc(buffer, size / 2, size / 2, size / 6, [255, 255, 255, 255]);
  return buffer;
}

/** A bar chart on white: axes, gridlines and colored bars (what a raster chart looks like in statistics). */
export function rasterBarChart(
  width: number,
  height: number,
  colors: readonly Rgba[],
): PixelBuffer {
  const buffer = blank(width, height, [255, 255, 255, 255]);
  rect(buffer, 20, 8, 1, height - 24, [60, 60, 60, 255]);
  rect(buffer, 20, height - 17, width - 30, 1, [60, 60, 60, 255]);
  for (let line = 1; line < 4; line += 1)
    rect(buffer, 21, 8 + line * 20, width - 32, 1, [225, 225, 225, 255]);
  const slot = Math.floor((width - 40) / colors.length);
  colors.forEach((color, index) => {
    const barHeight = 30 + ((index * 37) % 50);
    rect(buffer, 26 + index * slot, height - 17 - barHeight, slot - 12, barHeight, color);
  });
  return buffer;
}

/** A flat-colored logo: a few big regions on an opaque ground. */
export function flatLogo(width: number, height: number, colors: readonly Rgba[]): PixelBuffer {
  const buffer = blank(width, height, [255, 255, 255, 255]);
  const slot = Math.floor(width / colors.length);
  colors.forEach((color, index) => rect(buffer, index * slot + 4, 6, slot - 8, height - 12, color));
  return buffer;
}

/** UI screenshot statistics: text-like strokes in gray on white, a few colored buttons, antialiasing. */
export function screenshot(width: number, height: number, seed: number): PixelBuffer {
  const random = mulberry32(seed);
  const buffer = blank(width, height, [250, 250, 250, 255]);
  for (let row = 0; row < height / 14; row += 1) {
    let x = 12;
    while (x < width - 30) {
      const w = 6 + Math.floor(random() * 40);
      const shade = 40 + Math.floor(random() * 90);
      rect(buffer, x, 8 + row * 14, w, 6, [shade, shade, shade + 8, 255]);
      // antialiased fringe
      rect(buffer, x, 7 + row * 14, w, 1, [200, 200, 204, 255]);
      rect(buffer, x, 14 + row * 14, w, 1, [215, 215, 218, 255]);
      x += w + 8;
    }
  }
  rect(buffer, width - 120, height - 40, 100, 26, hex('#2b6cb0'));
  rect(buffer, width - 240, height - 40, 100, 26, hex('#38a169'));
  return buffer;
}
