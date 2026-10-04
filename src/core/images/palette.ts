import { IMAGE_THRESHOLDS } from '@shared/constants';
import { clusterCells, type HistogramCell } from './clusters';
import { labChroma, labDistance, rgbBytesToOklab, type Lab } from './oklab';
import type { PixelBuffer, PixelStats } from './types';

const CELL = IMAGE_THRESHOLDS.cellSize;
/** Offsets that make every OKLab cell index non-negative; the grid is 64 wide on each axis. */
const A_OFFSET = 0.5;

function cellKey(lab: Lab): number {
  const l = Math.min(63, Math.max(0, Math.floor(lab[0] / CELL)));
  const a = Math.min(63, Math.max(0, Math.floor((lab[1] + A_OFFSET) / CELL)));
  const b = Math.min(63, Math.max(0, Math.floor((lab[2] + A_OFFSET) / CELL)));
  return (l * 64 + a) * 64 + b;
}

/**
 * Reads the pixels of a (bounded) analysis surface and summarizes them: dominant color clusters,
 * how photographic or flat the image is, how much of it is transparent. A pixel is *visible* when
 * its alpha reaches `minVisibleAlpha`; the others carry no color information and are never
 * treated as black (docs/IMAGE_ADAPTATION.md, "Transparency"). The color of a visible pixel is
 * its own (unpremultiplied) color; compositing against a page background is a separate step
 * (`compositeOver`), done only when a background is known.
 */
export function analyzePixels(buffer: PixelBuffer): PixelStats {
  const { width, height, data } = buffer;
  const total = width * height;
  const lab = new Float32Array(total * 3);
  const visible = new Uint8Array(total);
  const cells = new Map<number, HistogramCell>();
  const minAlpha = IMAGE_THRESHOLDS.minVisibleAlpha * 255;
  let visiblePixels = 0;
  let neutralPixels = 0;
  // A run of equal colors (flat art) hits the same cell again and again: reuse its OKLab.
  let lastRgb = -1;
  let lastLab: [number, number, number] = [0, 0, 0];

  for (let i = 0; i < total; i += 1) {
    const o = i * 4;
    if (data[o + 3]! < minAlpha) continue;
    const r = data[o]!;
    const g = data[o + 1]!;
    const b = data[o + 2]!;
    const rgb = (r << 16) | (g << 8) | b;
    if (rgb !== lastRgb) {
      lastLab = rgbBytesToOklab(r, g, b);
      lastRgb = rgb;
    }
    visible[i] = 1;
    visiblePixels += 1;
    lab[i * 3] = lastLab[0];
    lab[i * 3 + 1] = lastLab[1];
    lab[i * 3 + 2] = lastLab[2];
    if (labChroma(lastLab) < IMAGE_THRESHOLDS.neutralChroma) neutralPixels += 1;
    const key = cellKey(lastLab);
    let cell = cells.get(key);
    if (!cell) {
      cell = { key, count: 0, sumL: 0, sumA: 0, sumB: 0, sumR: 0, sumG: 0, sumBlue: 0 };
      cells.set(key, cell);
    }
    cell.count += 1;
    cell.sumL += lastLab[0];
    cell.sumA += lastLab[1];
    cell.sumB += lastLab[2];
    cell.sumR += r;
    cell.sumG += g;
    cell.sumBlue += b;
  }

  let entropy = 0;
  for (const cell of cells.values()) {
    const p = cell.count / visiblePixels;
    entropy -= p * Math.log2(p);
  }

  let pairs = 0;
  let flat = 0;
  let edges = 0;
  const near = (i: number, j: number): void => {
    if (!visible[i] || !visible[j]) return;
    pairs += 1;
    const d = labDistance(
      [lab[i * 3]!, lab[i * 3 + 1]!, lab[i * 3 + 2]!],
      [lab[j * 3]!, lab[j * 3 + 1]!, lab[j * 3 + 2]!],
    );
    if (d < IMAGE_THRESHOLDS.flatDistance) flat += 1;
    else if (d > IMAGE_THRESHOLDS.edgeDistance) edges += 1;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (x + 1 < width) near(i, i + 1);
      if (y + 1 < height) near(i, i + width);
    }
  }

  const { clusters, noiseShare } = clusterCells([...cells.values()], visiblePixels);
  return {
    width,
    height,
    sampledPixels: total,
    visiblePixels,
    transparentShare: total === 0 ? 0 : 1 - visiblePixels / total,
    neutralShare: visiblePixels === 0 ? 0 : neutralPixels / visiblePixels,
    distinctCells: cells.size,
    entropyBits: entropy,
    flatShare: pairs === 0 ? 0 : flat / pairs,
    edgeShare: pairs === 0 ? 0 : edges / pairs,
    clusters,
    noiseShare,
  };
}
