/**
 * `<canvas>` policy (docs/CHARTS.md, "Canvas"). A canvas is a bitmap the page draws with
 * script: there is no mark to find, no series to name, no legend to pair. ColorAdapt therefore
 * never adapts one, and never patches `CanvasRenderingContext2D`: games, editors, maps and video
 * all draw through it. This only *classifies*, for diagnostics and so that a canvas chart is
 * reported as what it is (`canvas-chart`).
 */
export type CanvasClass = 'canvas-chart' | 'canvas-unknown';

export interface CanvasFacts {
  /** Class, id, role, aria-label, data-* names of the canvas and two ancestors, lower-cased. */
  readonly hints: readonly string[];
  readonly width: number;
  readonly height: number;
}

export interface CanvasVerdict {
  readonly kind: CanvasClass;
  readonly reason: 'chart-hint' | 'other-hint' | 'no-evidence';
}

const CHART_WORDS =
  /chart|graph|plot|sparkline|chartjs|echarts|highcharts|apexcharts|dataviz|visuali[sz]ation|histogram|\bseries\b/;

/** Words that make a canvas something else, whatever else is written near it. */
const OTHER_WORDS =
  /game|draw|paint|sketch|signature|sign-?pad|whiteboard|editor|video|webcam|camera|capture|photo|crop|webgl|three|babylon|pixi|particle|animation|map|minimap|qr|barcode|avatar|captcha|waveform|spectrogram/;

/** Whether a canvas looks like a data visualization. Never evidence to touch it. */
export function classifyCanvas(facts: CanvasFacts): CanvasVerdict {
  const text = facts.hints.join(' ');
  if (OTHER_WORDS.test(text)) return { kind: 'canvas-unknown', reason: 'other-hint' };
  if (CHART_WORDS.test(text)) return { kind: 'canvas-chart', reason: 'chart-hint' };
  return { kind: 'canvas-unknown', reason: 'no-evidence' };
}
