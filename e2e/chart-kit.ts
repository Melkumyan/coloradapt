import { expect, type Page } from '@playwright/test';
import { load, type Loaded } from './r1-kit';
import type { ExtensionSession, PageServer } from './harness';

/**
 * Shared pieces of the M7 real-browser suites. Everything reads the browser (`getComputedStyle`,
 * rendered pixels, the accessibility tree, the pipeline's counters); nothing sleeps.
 */
export const CHART_SETTINGS = {
  enabled: true,
  visionProfile: 'deuteranopia',
  adaptationStrength: 1,
  adaptSVG: true,
  adaptCharts: true,
} as const;

export interface SeriesSpec {
  readonly name: string;
  readonly color: string;
  readonly dash?: string;
  readonly marker?: 'square' | 'circle';
  readonly values?: number[];
  readonly width?: number;
  readonly value?: number;
  readonly fill?: string;
}

export interface ChartOptions {
  readonly id: string;
  readonly series: readonly SeriesSpec[];
  readonly legend?: 'svg' | 'html' | 'none';
  readonly legendKind?: 'line' | 'box';
  readonly keys?: boolean;
  readonly direct?: boolean;
  readonly interactive?: boolean;
  readonly points?: number;
  readonly categories?: number;
  readonly donut?: boolean;
  readonly label?: string;
  readonly role?: string;
  readonly into?: string;
}

declare global {
  interface Window {
    chartKit: {
      line(opts: ChartOptions): string;
      bar(opts: ChartOptions): string;
      stacked(opts: ChartOptions): string;
      scatter(opts: ChartOptions): string;
      pie(opts: ChartOptions): string;
      heatmap(opts: { id: string }): string;
      area(opts: ChartOptions): string;
      ambiguous(opts: { id: string }): string;
      logo(opts: { id: string }): string;
      diagram(opts: { id: string }): string;
      icon(opts: { id: string }): string;
      canvas(opts: {
        id: string;
        class?: string;
        label?: string;
        wrapClass?: string;
        colors?: string[];
      }): string;
      remove(id: string): void;
      addSeries(id: string, series: SeriesSpec): void;
      removeSeries(id: string, name: string): void;
      recolor(id: string, index: number, color: string): void;
      updateData(id: string, index: number, values: number[]): void;
      clear(): void;
      replace(kind: 'line' | 'bar' | 'scatter' | 'pie', opts: ChartOptions): void;
    };
    __log: { hovered: string[]; clicked: string[]; toggled: string[] };
  }
}

/** Red/green: confusable for deuteranopia (the pair of the M2 benchmark). */
export const RED_GREEN: readonly SeriesSpec[] = [
  { name: 'Red', color: '#d62728' },
  { name: 'Green', color: '#2ca02c' },
];
/** Near-identical reds: every pair conflicts for every profile. */
export const REDS: readonly SeriesSpec[] = [
  { name: 'A', color: '#d62728' },
  { name: 'B', color: '#d82a29' },
  { name: 'C', color: '#da2c2b' },
];
export const SIX: readonly SeriesSpec[] = [
  { name: 'S1', color: '#d62728' },
  { name: 'S2', color: '#d82a29' },
  { name: 'S3', color: '#da2c2b' },
  { name: 'S4', color: '#dc2e2d' },
  { name: 'S5', color: '#de302f' },
  { name: 'S6', color: '#e03231' },
];
/** Distinct for every profile (Okabe-Ito). */
export const DISTINCT: readonly SeriesSpec[] = [
  { name: 'Blue', color: '#0072b2' },
  { name: 'Vermilion', color: '#d55e00' },
  { name: 'Yellow', color: '#f0e442' },
];

export const loadCharts = (
  ext: ExtensionSession,
  server: PageServer,
  settings: Record<string, unknown> = CHART_SETTINGS,
): Promise<Loaded> => load(ext, server, 'charts.html', settings);

export const draw = (
  page: Page,
  kind: 'line' | 'bar' | 'scatter' | 'pie' | 'stacked' | 'area',
  opts: ChartOptions,
): Promise<string> =>
  page.evaluate(([k, o]) => window.chartKit[k as 'line'](o), [kind, opts] as const);

/** A computed-style snapshot of one element: what the browser says the series looks like. */
export interface Look {
  readonly dash: string;
  readonly markerMid: string;
  readonly markerStart: string;
  readonly fill: string;
  readonly stroke: string;
}

export function looks(page: Page, selector: string): Promise<Look[]> {
  return page.evaluate((sel) => {
    return [...document.querySelectorAll(sel)].map((el) => {
      const style = getComputedStyle(el);
      return {
        dash: style.strokeDasharray,
        markerMid: style.markerMid,
        markerStart: style.markerStart,
        fill: style.fill,
        stroke: style.stroke,
      };
    });
  }, selector);
}

/** What a marker reference draws: the referenced marker's geometry, so two markers can be compared. */
export function markerShape(page: Page, reference: string): Promise<string | null> {
  return page.evaluate((ref) => {
    const id = /#([^")]+)/.exec(ref)?.[1];
    const marker = id ? document.getElementById(id) : null;
    return marker ? marker.innerHTML : null;
  }, reference);
}

export interface Artifacts {
  readonly defs: number;
  readonly overlays: number;
  readonly marked: number;
  readonly owned: number;
  readonly sheet: boolean;
  readonly chartRules: number;
}

/** What the chart layer has written, found by its names in the document. */
export function artifacts(page: Page): Promise<Artifacts> {
  return page.evaluate(() => {
    const css = document.getElementById('coloradapt-stylesheet')?.textContent ?? '';
    return {
      defs: document.querySelectorAll('defs[data-coloradapt-chart-node]').length,
      overlays: document.querySelectorAll('[data-coloradapt-chart-node="overlay"]').length,
      marked: document.querySelectorAll(
        '[data-coloradapt-chart-mark],[data-coloradapt-chart-legend]',
      ).length,
      owned: document.querySelectorAll('[data-coloradapt-chart-owned]').length,
      sheet: document.getElementById('coloradapt-stylesheet') !== null,
      chartRules: css.split('\n').filter((line) => line.includes('data-coloradapt-chart')).length,
    };
  });
}

export const NOTHING: Artifacts = {
  defs: 0,
  overlays: 0,
  marked: 0,
  owned: 0,
  sheet: false,
  chartRules: 0,
};

/** The host's markup as the page wrote it: ColorAdapt ids stripped, our chart nodes and attributes removed. */
export function pristine(page: Page, selector = '#host'): Promise<string> {
  return page.evaluate((sel) => {
    const clone = document.querySelector(sel)!.cloneNode(true) as Element;
    for (const node of clone.querySelectorAll('[data-coloradapt-chart-node]')) node.remove();
    for (const el of [clone, ...clone.querySelectorAll('*')]) {
      for (const name of el.getAttributeNames())
        if (name.startsWith('data-coloradapt')) el.removeAttribute(name);
    }
    return clone.innerHTML;
  }, selector);
}

/** The host's markup exactly as it is now. */
export const markup = (page: Page, selector = '#host'): Promise<string> =>
  page.evaluate((sel) => document.querySelector(sel)!.innerHTML, selector);

/** Point on a path's stroke, in page coordinates (`fraction` 0-1 along its length). */
export function pointOnPath(
  page: Page,
  selector: string,
  fraction: number,
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ sel, f }) => {
      const path = document.querySelector(sel) as SVGGeometryElement;
      const length = path.getTotalLength();
      const local = path.getPointAtLength(length * f);
      const matrix = path.getScreenCTM()!;
      const point = new DOMPoint(local.x, local.y).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    },
    { sel: selector, f: fraction },
  );
}

/**
 * A point on a path's *painted* stroke, in page coordinates: the first along its length where the
 * browser's hit test returns the path itself (the gaps of a dashed line are not hit-testable, and
 * another line may cross). `from` shifts where the search starts, to pick different spots.
 */
export function hitPointOnPath(
  page: Page,
  selector: string,
  from = 0,
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ sel, start }) => {
      const path = document.querySelector(sel) as SVGGeometryElement;
      const length = path.getTotalLength();
      const matrix = path.getScreenCTM()!;
      for (let step = 0; step <= 400; step += 1) {
        const at = ((start + step / 400) % 1) * length;
        const local = path.getPointAtLength(at);
        const point = new DOMPoint(local.x, local.y).matrixTransform(matrix);
        if (document.elementFromPoint(point.x, point.y) === path) return { x: point.x, y: point.y };
      }
      throw new Error(`no hit-testable point on ${sel}`);
    },
    { sel: selector, start: from },
  );
}

/**
 * Colors of a `w` x `h` block of the rendered page whose top-left is (`x`, `y`) inside `[id]`, read from one
 * screenshot: `rows[row][column]` as `rgb(r, g, b)`. Aim at the middle of solid areas; edges are antialiased.
 */
export async function pixels(
  page: Page,
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<string[][]> {
  const origin = await page.evaluate((elementId) => {
    const rect = document.getElementById(elementId)!.getBoundingClientRect();
    return { x: rect.left + window.scrollX, y: rect.top + window.scrollY };
  }, id);
  const png = await page.screenshot({
    type: 'png',
    fullPage: true,
    clip: { x: Math.round(origin.x) + x, y: Math.round(origin.y) + y, width: w, height: h },
  });
  return page.evaluate(
    async ({ base64, width, height }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('no 2d context');
      context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(0, 0, width, height).data;
      const rows: string[][] = [];
      for (let row = 0; row < height; row += 1) {
        const line: string[] = [];
        for (let col = 0; col < width; col += 1) {
          const i = (row * width + col) * 4;
          line.push(`rgb(${data[i]}, ${data[i + 1]}, ${data[i + 2]})`);
        }
        rows.push(line);
      }
      return rows;
    },
    { base64: png.toString('base64'), width: w, height: h },
  );
}

/** Distinct colors in a block (see {@link pixels}). */
export async function blockColors(
  page: Page,
  id: string,
  x: number,
  y: number,
  size: number,
): Promise<Set<string>> {
  return new Set((await pixels(page, id, x, y, size, size)).flat());
}

/** The chart layer's counters. */
export async function chartCounters(loaded: Loaded) {
  return (await loaded.diag()).charts;
}

/** A path's vertices in SVG user space (absolute `M`/`L` only, as the fixtures draw them). */
export function vertices(page: Page, selector: string): Promise<Array<{ x: number; y: number }>> {
  return page.evaluate((sel) => {
    const d = document.querySelector(sel)!.getAttribute('d') ?? '';
    return [...d.matchAll(/[ML]\s*([-\d.]+)\s+([-\d.]+)/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    }));
  }, selector);
}

export async function expectNothingWritten(page: Page): Promise<void> {
  expect(await artifacts(page)).toEqual(NOTHING);
}
