import { parseColor } from '@core/color';
import {
  NO_PAINT,
  type Box,
  type ChartBlocker,
  type ChartFacts,
  type MarkFacts,
  type PaintFacts,
  type TextFacts,
} from '@core/charts';

/** Facts of hand-built charts: what the browser layer would read, without a browser. */

export const WIDTH = 400;
export const HEIGHT = 300;

export function paint(hex: string, opacity = 1): PaintFacts {
  const color = parseColor(hex);
  if (!color) throw new Error(`bad color ${hex}`);
  return { kind: 'solid', color, ref: null, opacity };
}

export function server(kind: 'gradient' | 'pattern' | 'other', ref: string): PaintFacts {
  return { kind, color: null, ref, opacity: 1 };
}

export const rgb = (hex: string) => {
  const color = parseColor(hex);
  if (!color) throw new Error(`bad color ${hex}`);
  return color;
};

interface MarkInit {
  readonly tag?: string;
  readonly fill?: PaintFacts;
  readonly stroke?: PaintFacts;
  readonly strokeWidth?: number;
  readonly dash?: string | null;
  readonly markerRef?: string | null;
  readonly vertices?: number;
  readonly closed?: boolean;
  readonly arcCount?: number;
  readonly rectilinear?: boolean;
  readonly box?: Box | null;
  readonly tokens?: readonly string[];
  readonly dataSeries?: string | null;
  readonly label?: string | null;
  readonly parent?: number;
  readonly grandparent?: number;
}

export class FactsBuilder {
  readonly marks: MarkFacts[] = [];
  readonly texts: TextFacts[] = [];
  #order = 0;
  hints: string[] = [];
  blockers: ChartBlocker[] = [];
  overBudget = false;

  mark(init: MarkInit): number {
    const order = this.#order;
    this.#order += 1;
    this.marks.push({
      order,
      tag: init.tag ?? 'path',
      ancestry: [init.parent ?? 1, init.grandparent ?? 0],
      fill: init.fill ?? NO_PAINT,
      stroke: init.stroke ?? NO_PAINT,
      strokeWidth: init.strokeWidth ?? 1,
      dash: init.dash ?? null,
      markerRef: init.markerRef ?? null,
      vertices: init.vertices ?? 1,
      closed: init.closed ?? false,
      arcCount: init.arcCount ?? 0,
      rectilinear: init.rectilinear ?? false,
      box: init.box === undefined ? { x: 50, y: 50, w: 200, h: 100 } : init.box,
      classTokens: init.tokens ?? [],
      dataSeries: init.dataSeries ?? null,
      label: init.label ?? null,
    });
    return order;
  }

  text(
    content: string,
    box: Box | null,
    init: { color?: string; parent?: number; tokens?: readonly string[] } = {},
  ): number {
    const order = this.#order;
    this.#order += 1;
    this.texts.push({
      order,
      ancestry: [init.parent ?? 1, 0],
      text: content,
      color: init.color ? rgb(init.color) : rgb('#222222'),
      box,
      classTokens: init.tokens ?? [],
    });
    return order;
  }

  /** A data line of `vertices` points in `color` over the plot area. */
  line(color: string, init: MarkInit = {}): number {
    return this.mark({
      tag: 'path',
      stroke: paint(color),
      strokeWidth: 2,
      vertices: init.vertices ?? 8,
      parent: 2,
      ...init,
    });
  }

  rect(fill: string, box: Box, init: MarkInit = {}): number {
    return this.mark({
      tag: 'rect',
      fill: paint(fill),
      closed: true,
      vertices: 1,
      box,
      parent: 3,
      ...init,
    });
  }

  point(color: string, cx: number, cy: number, init: MarkInit = {}): number {
    return this.mark({
      tag: 'circle',
      fill: paint(color),
      closed: true,
      vertices: 1,
      box: { x: cx - 4, y: cy - 4, w: 8, h: 8 },
      parent: 4,
      ...init,
    });
  }

  /** Axis line, ticks and tick labels: the evidence of a Cartesian chart. */
  axes(): void {
    this.mark({
      tag: 'path',
      stroke: paint('#888888'),
      vertices: 3,
      rectilinear: true,
      box: { x: 40, y: 260, w: 340, h: 0 },
      parent: 5,
    });
    for (let i = 0; i < 5; i += 1) {
      this.mark({
        tag: 'line',
        stroke: paint('#888888'),
        vertices: 2,
        rectilinear: true,
        box: { x: 40 + i * 80, y: 260, w: 0, h: 5 },
        parent: 5,
      });
      this.text(String(i * 10), { x: 36 + i * 80, y: 270, w: 10, h: 10 }, { parent: 5 });
    }
  }

  /** One legend entry: swatch then text, in a group of their own (as D3 draws it). */
  legendItem(
    color: string,
    label: string,
    index: number,
    kind: 'line' | 'box' | 'point' = 'box',
    init: MarkInit = {},
  ): { swatch: number; text: number } {
    const group = 20 + index;
    const y = 10 + index * 16;
    const common = { parent: group, grandparent: 19 };
    let swatch: number;
    if (kind === 'line') {
      swatch = this.mark({
        tag: 'line',
        stroke: paint(color),
        strokeWidth: 2,
        vertices: 2,
        rectilinear: true,
        box: { x: 300, y: y + 5, w: 20, h: 0 },
        ...common,
        ...init,
      });
    } else if (kind === 'point') {
      swatch = this.mark({
        tag: 'circle',
        fill: paint(color),
        closed: true,
        box: { x: 300, y, w: 10, h: 10 },
        ...common,
        ...init,
      });
    } else {
      swatch = this.mark({
        tag: 'rect',
        fill: paint(color),
        closed: true,
        box: { x: 300, y, w: 10, h: 10 },
        ...common,
        ...init,
      });
    }
    const text = this.text(label, { x: 325, y, w: 50, h: 10 }, { parent: group });
    return { swatch, text };
  }

  build(): ChartFacts {
    return {
      marks: this.marks,
      texts: this.texts,
      width: WIDTH,
      height: HEIGHT,
      hints: this.hints,
      label: null,
      blockers: this.blockers,
      overBudget: this.overBudget,
    };
  }
}

/**
 * Red / green / orange. For a deuteranope red and green collapse (0.04); for a protanope green and
 * orange do (0.01); for neither profile are all three pairs a problem (docs/CHARTS.md benchmark).
 */
export const CONFUSABLE = ['#d62728', '#2ca02c', '#ff7f0e'];
/** Near-identical reds: every pair is hard to tell apart for every profile. */
export const REDS = ['#d62728', '#d82a29', '#da2c2b'];
/** Colors that stay distinct for everybody (Okabe-Ito: blue, vermillion, yellow). */
export const DISTINCT = ['#0072b2', '#d55e00', '#f0e442'];

export function lineChart(
  colors: readonly string[],
  options: {
    legend?: boolean;
    labels?: readonly string[];
    dashes?: ReadonlyArray<string | null>;
    keys?: boolean;
  } = {},
): FactsBuilder {
  const b = new FactsBuilder();
  b.hints = ['chart'];
  b.axes();
  colors.forEach((color, i) => {
    b.line(color, {
      dash: options.dashes?.[i] ?? null,
      dataSeries: options.keys ? `s${i}` : null,
      box: { x: 50, y: 40 + i * 20, w: 320, h: 100 },
    });
  });
  if (options.legend !== false) {
    colors.forEach((color, i) => {
      b.legendItem(
        color,
        options.labels?.[i] ?? `Series ${i + 1}`,
        i,
        'line',
        options.keys ? { dataSeries: `s${i}` } : {},
      );
    });
  }
  return b;
}

export function barChart(
  colors: readonly string[],
  options: { legend?: boolean } = {},
): FactsBuilder {
  const b = new FactsBuilder();
  b.hints = ['chart'];
  b.axes();
  // Grouped bars: one per series in each of 3 categories, all standing on y = 260.
  for (let category = 0; category < 3; category += 1) {
    colors.forEach((color, i) => {
      const height = 60 + ((category * 37 + i * 23) % 90);
      b.rect(color, { x: 60 + category * 100 + i * 22, y: 260 - height, w: 20, h: height });
    });
  }
  if (options.legend !== false)
    colors.forEach((color, i) => b.legendItem(color, `Bar ${i + 1}`, i, 'box'));
  return b;
}

export function scatterChart(
  colors: readonly string[],
  options: { legend?: boolean } = {},
): FactsBuilder {
  const b = new FactsBuilder();
  b.hints = ['chart'];
  b.axes();
  colors.forEach((color, i) => {
    for (let n = 0; n < 8; n += 1)
      b.point(color, 60 + n * 38 + i * 5, 80 + ((n * 53 + i * 31) % 150));
  });
  if (options.legend !== false)
    colors.forEach((color, i) => b.legendItem(color, `Group ${i + 1}`, i, 'point'));
  return b;
}

/** A pie (or donut) of `colors.length` slices inside one 200x200 circle; every slice's box contains the center. */
export function pieChart(
  colors: readonly string[],
  options: { legend?: boolean; donut?: boolean } = {},
): FactsBuilder {
  const b = new FactsBuilder();
  b.hints = ['pie'];
  for (const color of colors) {
    b.mark({
      tag: 'path',
      fill: paint(color),
      closed: true,
      arcCount: options.donut ? 2 : 1,
      vertices: 4,
      box: { x: 50, y: 50, w: 200, h: 200 },
      parent: 6,
    });
  }
  if (options.legend !== false)
    colors.forEach((color, i) => b.legendItem(color, `Slice ${i + 1}`, i, 'box'));
  return b;
}
