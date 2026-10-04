import type { ChartType, ColorValue } from '@domain/models';
import { normalizeDashArray } from './line-style';
import type {
  Box,
  ChartFacts,
  ChartSeries,
  ExistingEncoding,
  MarkFacts,
  SeriesKind,
  TextFacts,
} from './types';
import {
  center,
  colorHex,
  contains,
  fillVisible,
  inflate,
  isNeutral,
  isOpenStroke,
  isPainted,
  isStraight,
  paintKeyOf,
  strokeVisible,
  unionBox,
} from './util';

/** Line charts need at least this many vertices on a series: two points are a segment, not a trend. */
const MIN_LINE_VERTICES = 4;
const MIN_BARS = 3;
const MIN_POINTS = 6;
const MIN_SLICES = 2;
const HEATMAP_MIN_CELLS = 9;
/** Largest point (either side), in user units. */
const MAX_POINT = 24;

const GRAY: ColorValue = { r: 0.5, g: 0.5, b: 0.5, alpha: 1 };

export interface Structure {
  readonly type: ChartType;
  /** The marks the type is made of (before grouping into series). */
  readonly dataMarks: readonly MarkFacts[];
  readonly evidence: readonly string[];
  /** The shape of the marks is characteristic of the type (not yet: confident it is a chart). */
  readonly strong: boolean;
}

// ----------------------------------------------------------------- data marks

function isBackground(mark: MarkFacts, facts: ChartFacts): boolean {
  const box = mark.box;
  if (!box || facts.width <= 0 || facts.height <= 0) return false;
  return box.w * box.h >= 0.6 * facts.width * facts.height && mark.closed;
}

function isAxisOrGrid(mark: MarkFacts): boolean {
  const color = mark.stroke.color;
  if (!color || !isNeutral(color) || fillVisible(mark)) return false;
  return isStraight(mark) || mark.rectilinear;
}

/** Marks that are neither legend swatches, backgrounds, axes nor gridlines. */
export function dataMarksOf(facts: ChartFacts, legendOrders: ReadonlySet<number>): MarkFacts[] {
  return facts.marks.filter(
    (mark) =>
      !legendOrders.has(mark.order) &&
      isPainted(mark) &&
      !isBackground(mark, facts) &&
      !isAxisOrGrid(mark),
  );
}

// ------------------------------------------------------------------ detectors

function lineMarks(marks: readonly MarkFacts[]): MarkFacts[] {
  return marks.filter(
    (mark) =>
      (mark.tag === 'path' || mark.tag === 'polyline') &&
      isOpenStroke(mark) &&
      mark.vertices >= MIN_LINE_VERTICES,
  );
}

function pointMarks(marks: readonly MarkFacts[]): MarkFacts[] {
  return marks.filter((mark) => {
    const box = mark.box;
    if (!box || box.w > MAX_POINT || box.h > MAX_POINT || box.w < 1 || box.h < 1) return false;
    if (!(fillVisible(mark) || strokeVisible(mark))) return false;
    return mark.tag === 'circle' || mark.tag === 'ellipse' || (mark.closed && mark.tag !== 'text');
  });
}

function rectMarks(marks: readonly MarkFacts[]): MarkFacts[] {
  return marks.filter(
    (mark) =>
      mark.tag === 'rect' &&
      mark.box !== null &&
      fillVisible(mark) &&
      mark.box.w > 0 &&
      mark.box.h > 0,
  );
}

function sliceMarks(marks: readonly MarkFacts[]): MarkFacts[] {
  return marks.filter(
    (mark) =>
      mark.tag === 'path' &&
      mark.closed &&
      mark.arcCount >= 1 &&
      fillVisible(mark) &&
      mark.box !== null,
  );
}

function pieEvidence(slices: readonly MarkFacts[]): { donut: boolean; evidence: string[] } | null {
  if (slices.length < MIN_SLICES) return null;
  const union = unionBox(slices.map((slice) => slice.box));
  if (!union || union.w <= 0 || union.h <= 0) return null;
  const aspect = union.w / union.h;
  if (aspect < 0.85 || aspect > 1.18) return null;
  const middle = center(union);
  const donut = slices.every((slice) => slice.arcCount >= 2);
  // A pie slice is a wedge: its center vertex is the pie's center, so its box holds it.
  // A donut slice is a ring segment: it does not, but it must stay inside the ring.
  const evidence = ['circular-union', `slices:${slices.length}`];
  if (!donut) {
    const withCenter = slices.filter(
      (slice) =>
        slice.box && contains(inflate(slice.box, Math.max(2, union.w * 0.03)), middle.x, middle.y),
    );
    if (withCenter.length < slices.length) return null;
    evidence.push('wedges-meet-at-center');
  } else {
    evidence.push('ring-segments');
  }
  return { donut, evidence };
}

function heatmapEvidence(rects: readonly MarkFacts[]): boolean {
  if (rects.length < HEATMAP_MIN_CELLS) return false;
  const sizes = new Map<string, MarkFacts[]>();
  for (const rect of rects) {
    const box = rect.box;
    if (!box) continue;
    const key = `${Math.round(box.w)}x${Math.round(box.h)}`;
    sizes.set(key, [...(sizes.get(key) ?? []), rect]);
  }
  for (const group of sizes.values()) {
    if (group.length < HEATMAP_MIN_CELLS) continue;
    const xs = new Set(group.map((rect) => Math.round((rect.box?.x ?? 0) / 2)));
    const ys = new Set(group.map((rect) => Math.round((rect.box?.y ?? 0) / 2)));
    if (xs.size >= 3 && ys.size >= 3) return true;
  }
  return false;
}

/**
 * Bars share one baseline: along each column (vertical bars) the lowest edge is the same line,
 * or along each row (horizontal bars) the leftmost one, with the free length varying. A column
 * holding several rects one on top of the other is a stack.
 */
function barEvidence(rects: readonly MarkFacts[]): 'bar' | 'stacked-bar' | null {
  if (rects.length < MIN_BARS) return null;
  const tolerance = 1.5;
  const boxes = rects.map((rect) => rect.box as Box);
  const groupBy = (key: (box: Box) => number): Box[][] => {
    const groups = new Map<number, Box[]>();
    for (const box of boxes) {
      const k = Math.round(key(box) / tolerance);
      const group = groups.get(k);
      if (group) group.push(box);
      else groups.set(k, [box]);
    }
    return [...groups.values()];
  };
  const baselined = (groups: Box[][], edge: (group: Box[]) => number): boolean => {
    if (groups.length < MIN_BARS) return false;
    const counts = new Map<number, number>();
    for (const group of groups) {
      const k = Math.round(edge(group) / tolerance);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return Math.max(...counts.values()) >= Math.max(MIN_BARS, 0.6 * groups.length);
  };
  const columns = groupBy((box) => box.x);
  const rows = groupBy((box) => box.y);
  const vertical =
    (baselined(columns, (g) => Math.max(...g.map((box) => box.y + box.h))) ||
      baselined(columns, (g) => Math.min(...g.map((box) => box.y)))) &&
    new Set(boxes.map((box) => Math.round(box.h))).size >= 2;
  const horizontal =
    (baselined(rows, (g) => Math.min(...g.map((box) => box.x))) ||
      baselined(rows, (g) => Math.max(...g.map((box) => box.x + box.w)))) &&
    new Set(boxes.map((box) => Math.round(box.w))).size >= 2;
  if (!vertical && !horizontal) return null;
  if (vertical && isStacked(columns, (box) => box.w)) return 'stacked-bar';
  if (horizontal && isStacked(rows, (box) => box.h)) return 'stacked-bar';
  return 'bar';
}

/**
 * Stacks: at least two columns (or rows) each hold several rects of one width (height) on the same
 * axis position. Whatever lies between them (gaps, padding, a track behind a bar) does not matter:
 * grouped bars each have a column of their own, so they never qualify.
 */
function isStacked(groups: readonly Box[][], size: (box: Box) => number): boolean {
  let stacks = 0;
  for (const group of groups) {
    if (group.length >= 2 && new Set(group.map((box) => Math.round(size(box) / 2))).size === 1) {
      stacks += 1;
    }
  }
  return stacks >= 2;
}

/** At least three distinct rows and three distinct columns of points (a grid of 6 px): not a line of dots. */
function spreadsInTwoDimensions(points: readonly MarkFacts[]): boolean {
  const rows = new Set<number>();
  const columns = new Set<number>();
  for (const point of points) {
    if (!point.box) continue;
    const middle = center(point.box);
    rows.add(Math.round(middle.y / 6));
    columns.add(Math.round(middle.x / 6));
  }
  return rows.size >= 3 && columns.size >= 3;
}

function areaMarks(marks: readonly MarkFacts[]): MarkFacts[] {
  return marks.filter(
    (mark) =>
      (mark.tag === 'path' || mark.tag === 'polygon') &&
      mark.closed &&
      mark.arcCount === 0 &&
      fillVisible(mark) &&
      mark.vertices >= MIN_LINE_VERTICES,
  );
}

/**
 * What kind of chart the marks add up to, and how characteristic they are of it. Precedence:
 * pie/donut, heatmap, bars, lines (with their own point markers), scatter, areas. A mix of
 * families is `unknown`: a combination chart cannot be mapped to one policy.
 */
export function classifyStructure(facts: ChartFacts, legendOrders: ReadonlySet<number>): Structure {
  const data = dataMarksOf(facts, legendOrders);
  const lines = lineMarks(data);
  const slices = sliceMarks(data);
  const rects = rectMarks(data);
  const points = pointMarks(data).filter((mark) => mark.tag !== 'rect');

  const pie = pieEvidence(slices);
  if (pie && lines.length === 0 && rects.length === 0) {
    return {
      type: pie.donut ? 'donut' : 'pie',
      dataMarks: slices,
      evidence: pie.evidence,
      strong: slices.length >= MIN_SLICES,
    };
  }
  if (heatmapEvidence(rects)) {
    return { type: 'heatmap', dataMarks: rects, evidence: ['grid-of-equal-cells'], strong: true };
  }
  const bars = barEvidence(rects);
  if (bars && lines.length === 0) {
    return { type: bars, dataMarks: rects, evidence: ['baseline-aligned-rects'], strong: true };
  }
  if (lines.length > 0) {
    if (rects.length >= MIN_BARS && bars) {
      return {
        type: 'unknown',
        dataMarks: [...lines, ...rects],
        evidence: ['mixed-families'],
        strong: false,
      };
    }
    // Points that are not the vertices of one of the lines make this something else.
    const lineColors = new Set(lines.map((line) => paintKeyOf(line.stroke)));
    const foreign = points.filter(
      (point) => !lineColors.has(paintKeyOf(point.fill) ?? paintKeyOf(point.stroke)),
    );
    if (foreign.length >= MIN_POINTS) {
      return {
        type: 'unknown',
        dataMarks: [...lines, ...points],
        evidence: ['mixed-families'],
        strong: false,
      };
    }
    const members = points.filter((point) =>
      lineColors.has(paintKeyOf(point.fill) ?? paintKeyOf(point.stroke)),
    );
    return {
      type: 'line',
      dataMarks: [...lines, ...members],
      evidence: [`lines:${lines.length}`],
      strong: true,
    };
  }
  if (points.length >= MIN_POINTS) {
    // Dots in one row or one column are a timeline, a rating, a stepper: not a scatter of two variables.
    if (!spreadsInTwoDimensions(points)) {
      return { type: 'unknown', dataMarks: [], evidence: ['collinear-points'], strong: false };
    }
    return {
      type: 'scatter',
      dataMarks: points,
      evidence: [`points:${points.length}`],
      strong: true,
    };
  }
  const areas = areaMarks(data);
  if (areas.length >= 1) {
    return { type: 'area', dataMarks: areas, evidence: [`areas:${areas.length}`], strong: true };
  }
  return { type: 'unknown', dataMarks: [], evidence: [], strong: false };
}

// ---------------------------------------------------------------------- series

function seriesKind(type: ChartType): SeriesKind {
  switch (type) {
    case 'line':
      return 'line';
    case 'scatter':
      return 'point';
    case 'pie':
    case 'donut':
      return 'slice';
    default:
      return 'bar';
  }
}

/** The color that carries a mark's identity: a line's stroke, a shape's fill. */
function identityPaint(
  mark: MarkFacts,
  kind: SeriesKind,
): { key: string; color: ColorValue } | null {
  const fromStroke = () => {
    const key = paintKeyOf(mark.stroke);
    return key && mark.stroke.color ? { key, color: mark.stroke.color } : null;
  };
  const fromFill = () => {
    const key = paintKeyOf(mark.fill);
    if (!key) return null;
    return {
      key,
      color:
        mark.fill.kind === 'solid' && mark.fill.color
          ? mark.fill.color
          : (mark.stroke.color ?? GRAY),
    };
  };
  if (kind === 'line') return fromStroke();
  if (kind === 'point') return fromFill() ?? fromStroke();
  return fromFill();
}

/** Tokens that appear on every mark of a group (candidates for naming the series). */
function sharedTokens(marks: readonly MarkFacts[]): string[] {
  const first = marks[0];
  if (!first) return [];
  return first.classTokens.filter((token) =>
    marks.every((mark) => mark.classTokens.includes(token)),
  );
}

function existingEncoding(marks: readonly MarkFacts[], kind: SeriesKind): ExistingEncoding {
  const first = marks[0] as MarkFacts;
  const dashes = new Set(marks.map((mark) => normalizeDashArray(mark.dash)));
  const markers = new Set(marks.map((mark) => mark.markerRef));
  const patterns = new Set(
    marks.map((mark) => (mark.fill.kind === 'pattern' ? mark.fill.ref : null)),
  );
  return {
    dash: dashes.size === 1 ? (normalizeDashArray(first.dash) ?? null) : 'mixed',
    markerRef: markers.size === 1 ? first.markerRef : 'mixed',
    patternRef:
      patterns.size === 1
        ? first.fill.ref && first.fill.kind === 'pattern'
          ? first.fill.ref
          : null
        : 'mixed',
    strokeWidth: Math.max(...marks.map((mark) => mark.strokeWidth)),
    pointShape:
      kind === 'line'
        ? null
        : `${first.tag}${first.tag === 'path' ? `:${first.vertices}:${first.arcCount}` : ''}`,
    directLabel: false,
  };
}

interface Group {
  readonly key: string;
  readonly color: ColorValue;
  readonly paintKey: string;
  readonly marks: MarkFacts[];
}

/**
 * Groups the data marks into series. A series is what the author keyed (`data-series`), else
 * what shares a paint (and a dash, which tells two lines of one color apart). Slices are one
 * series each. A mark without a readable paint is not a series member.
 */
export function buildSeries(type: ChartType, marks: readonly MarkFacts[]): ChartSeries[] {
  const kind = seriesKind(type);
  const groups = new Map<string, Group>();
  const slices = kind === 'slice';
  for (const mark of marks) {
    const paint = identityPaint(mark, kind);
    if (!paint) continue;
    if (slices) {
      // Each slice is its own series; two of one color are told apart by their place.
      let key = mark.dataSeries ? `k:${mark.dataSeries}` : `c:${paint.key}`;
      if (groups.has(key)) key = `o:${groups.size}`;
      groups.set(key, { key, color: paint.color, paintKey: paint.key, marks: [mark] });
      continue;
    }
    let key: string;
    if (mark.dataSeries) key = `k:${mark.dataSeries}`;
    else {
      const dash = normalizeDashArray(mark.dash);
      key = `c:${paint.key}${kind === 'line' && dash ? `|d:${dash}` : ''}`;
    }
    const existing = groups.get(key);
    if (existing) existing.marks.push(mark);
    else groups.set(key, { key, color: paint.color, paintKey: paint.key, marks: [mark] });
  }

  const series: ChartSeries[] = [];
  for (const group of groups.values()) {
    const first = group.marks[0] as MarkFacts;
    const dataSeries = group.marks.every((mark) => mark.dataSeries === first.dataSeries)
      ? first.dataSeries
      : null;
    series.push({
      id: group.key,
      index: series.length,
      kind,
      label: dataSeries ?? first.label,
      color: group.color,
      paintKey: group.paintKey,
      classTokens: sharedTokens(group.marks),
      dataSeries,
      marks: group.marks.map((mark) => mark.order),
      existing: existingEncoding(group.marks, kind),
      maxVertices: Math.max(...group.marks.map((mark) => mark.vertices)),
      memberPoints: kind === 'line' && group.marks.some((mark) => mark.closed),
    });
  }
  return series;
}

// ------------------------------------------------------------- direct labels

/**
 * Marks series that are labelled where they are drawn: a text outside the legend, near the
 * series, in the series' color (or reading as its name). Needs geometry; without it nothing
 * is claimed, so a series is never wrongly called "already labelled".
 */
export function withDirectLabels(
  series: readonly ChartSeries[],
  facts: ChartFacts,
  legendOrders: ReadonlySet<number>,
): ChartSeries[] {
  const marksByOrder = new Map(facts.marks.map((mark) => [mark.order, mark]));
  const labels = facts.texts.filter(
    (text) => !legendOrders.has(text.order) && text.box && text.text.trim() !== '',
  );
  const claims = new Map<TextFacts, string[]>();
  for (const s of series) {
    const union = unionBox(s.marks.map((order) => marksByOrder.get(order)?.box ?? null));
    if (!union) continue;
    const zone = inflate(union, 36);
    for (const text of labels) {
      if (!text.box) continue;
      const middle = center(text.box);
      if (!contains(zone, middle.x, middle.y)) continue;
      const sameColor = text.color !== null && colorHex(text.color) === s.paintKey;
      const sameName =
        s.label !== null && text.text.trim().toLowerCase() === s.label.trim().toLowerCase();
      if (sameColor || sameName) claims.set(text, [...(claims.get(text) ?? []), s.id]);
    }
  }
  const labelled = new Set<string>();
  for (const ids of claims.values()) if (ids.length === 1) labelled.add(ids[0] as string);
  return series.map((s) =>
    labelled.has(s.id) ? { ...s, existing: { ...s.existing, directLabel: true } } : s,
  );
}
