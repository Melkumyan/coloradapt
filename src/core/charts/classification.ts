import type { ChartConfidence, ChartType, ChartUnsupportedReason } from '@domain/models';
import { CHART_LIMITS } from '@shared/constants';
import { detectLegend } from './legend';
import { mapSeriesToLegend } from './mapping';
import { buildSeries, classifyStructure, dataMarksOf, withDirectLabels } from './series';
import type {
  Box,
  ChartAnalysis,
  ChartBlocker,
  ChartDescriptor,
  ChartFacts,
  ChartSeries,
  MarkFacts,
} from './types';
import { readsAsOrdered } from './palette';
import {
  center,
  contains,
  hasChartHint,
  isNeutral,
  looksLikeTick,
  paintKeyOf,
  strokeVisible,
} from './util';

/** Types M7 writes to. Everything else is classified and left alone (docs/CHARTS.md). */
export const ADAPTED_TYPES: ReadonlySet<ChartType> = new Set([
  'line',
  'bar',
  'scatter',
  'pie',
  'donut',
]);

/** Tick marks are short: at most this long. */
const MAX_TICK = 14;
/** An axis-aligned line is at most this thick in its box (a few pixels of tilt or stroke). */
const MAX_AXIS_THICKNESS = 3;

/**
 * How many independent signs of a Cartesian chart's axes there are (0-3): a long neutral axis or
 * gridline, a row of short neutral tick marks, a row of tick labels. Evidence about the page, not
 * about the data: an illustration with many shapes has none of these.
 */
export function axisEvidence(facts: ChartFacts, legendOrders: ReadonlySet<number>): number {
  let score = 0;
  // An axis, a gridline and a tick run along x or y: a diagonal line is a connector, a link, a hand-drawn stroke.
  const axisAligned = (mark: MarkFacts): boolean =>
    mark.box !== null && Math.min(mark.box.w, mark.box.h) <= MAX_AXIS_THICKNESS;
  const axisLine = facts.marks.some((mark) => {
    const color = mark.stroke.color;
    if (!mark.box || !color || !strokeVisible(mark) || !isNeutral(color)) return false;
    const long = mark.box.w >= 0.5 * facts.width || mark.box.h >= 0.5 * facts.height;
    if (!long) return false;
    // a straight segment must be axis-aligned; a path of right angles (D3's domain with its end ticks) may be any size
    return mark.tag === 'line' || mark.vertices <= 2 ? axisAligned(mark) : mark.rectilinear;
  });
  if (axisLine) score += 1;

  const ticks = facts.marks.filter((mark) => {
    const color = mark.stroke.color;
    if (!mark.box || !color || !strokeVisible(mark) || !isNeutral(color)) return false;
    return (
      (mark.tag === 'line' || mark.vertices <= 2) &&
      Math.max(mark.box.w, mark.box.h) <= MAX_TICK &&
      axisAligned(mark)
    );
  });
  if (ticks.length >= 3) score += 1;

  // Tick labels sit outside the plotted marks and line up. A number inside a cell or on a shape is a
  // value label (a calendar day, a percentage on an infographic), not an axis.
  const data = dataMarksOf(facts, legendOrders);
  const labels = facts.texts.filter((text) => {
    if (legendOrders.has(text.order)) return false;
    if (!text.box) return true;
    const middle = center(text.box);
    return !data.some((mark) => mark.box !== null && contains(mark.box, middle.x, middle.y));
  });
  const groups = (members: typeof labels): number => {
    const keys = [
      (box: Box) => `r${Math.round((box.y + box.h) / 3)}`,
      (box: Box) => `l${Math.round(box.x / 3)}`,
      (box: Box) => `e${Math.round((box.x + box.w) / 3)}`,
      (box: Box) => `c${Math.round((box.x + box.w / 2) / 3)}`,
    ];
    let best = 0;
    for (const key of keys) {
      const counts = new Map<string, number>();
      for (const text of members) {
        if (!text.box) continue;
        const k = key(text.box);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      best = Math.max(best, ...counts.values());
    }
    return best;
  };
  const numeric = labels.filter((text) => looksLikeTick(text.text));
  if (numeric.length >= 3 && groups(numeric) >= 3) score += 1;
  else if (groups(labels) >= 4) score += 1;
  return score;
}

function confidenceOf(
  type: ChartType,
  strong: boolean,
  axes: number,
  hint: boolean,
  legendSwatches: number,
  slices: number,
): ChartConfidence {
  if (type === 'unknown' || !strong) return 'UNKNOWN';
  if (type === 'pie' || type === 'donut') {
    // Arcs in a circle are a logo or a gauge as often as a pie: only a legend entry per slice makes
    // the slices series. A hint alone is never enough.
    if (legendSwatches >= slices && slices >= 2) return 'HIGH';
    return hint ? 'MEDIUM' : 'LOW';
  }
  if (axes >= 2 || (axes >= 1 && hint)) return 'HIGH';
  if (axes >= 1 || hint) return 'MEDIUM';
  return 'LOW';
}

const BLOCKER_REASON: Readonly<
  Record<Exclude<ChartBlocker, 'html-legend'>, ChartUnsupportedReason>
> = {
  animated: 'animated',
  filter: 'filter',
  mask: 'mask',
  'foreign-object': 'foreign-object',
  'embedded-image': 'embedded-image',
};

/** Longest and tallest a legend swatch can be (the same limits `detectLegend` uses). */
const SWATCH_LINE_MAX = 90;
const SWATCH_BOX_MAX = 40;

/**
 * Small marks that look like legend swatches of a series (same paint, swatch-sized) but belong to
 * neither the series nor a detected legend: a legend whose swatch and text are not adjacent in one
 * parent, say. Adapting the chart would then leave that legend as it was, so the chart is refused
 * rather than adapted with a legend that no longer matches (docs/CHARTS.md, "Legend mapping").
 * Swatches of bars and points join their series (they are the same kind of mark) and are adapted
 * with it, so they never show up here.
 */
function hasOrphanSwatch(
  facts: ChartFacts,
  series: readonly ChartSeries[],
  legendOrders: ReadonlySet<number>,
): boolean {
  const members = new Set(series.flatMap((s) => s.marks));
  const paints = new Set(series.map((s) => s.paintKey));
  return facts.marks.some((mark) => {
    if (members.has(mark.order) || legendOrders.has(mark.order) || !mark.box) return false;
    const straight = mark.tag === 'line' || (mark.vertices <= 2 && mark.arcCount === 0);
    const small = straight
      ? mark.box.w >= 8 && mark.box.w <= SWATCH_LINE_MAX && mark.box.h <= 3
      : mark.box.w >= 3 &&
        mark.box.h >= 3 &&
        mark.box.w <= SWATCH_BOX_MAX &&
        mark.box.h <= SWATCH_BOX_MAX;
    if (!small) return false;
    const key = straight
      ? paintKeyOf(mark.stroke)
      : (paintKeyOf(mark.fill) ?? paintKeyOf(mark.stroke));
    return key !== null && paints.has(key);
  });
}

/**
 * Classifies one `<svg>` read into {@link ChartFacts}. Pure: no DOM, no style, no clock.
 *
 * `supported` is the only status M7 writes to, and only for HIGH confidence in a type it adapts,
 * with series and legend mapped without ambiguity. `limited` is a chart M7 recognizes and refuses
 * (and therefore owns: M5 must not touch its marks); `unsupported` names why a chart-like SVG is
 * left alone; `unknown` is everything else: illustrations, logos, diagrams, maps.
 */
export function analyzeChart(facts: ChartFacts): ChartAnalysis {
  // Nothing is laid out (hidden, detached, not rendered yet): geometry decides what a legend or a bar is, so say nothing.
  if (!facts.marks.some((mark) => mark.box !== null)) return { status: 'unknown' };
  const legend = detectLegend(facts);
  const structure = classifyStructure(facts, legend.orders);
  const hint = hasChartHint(facts.hints);
  const axes = axisEvidence(facts, legend.orders);
  const slices =
    structure.type === 'pie' || structure.type === 'donut' ? structure.dataMarks.length : 0;
  const confidence = confidenceOf(
    structure.type,
    structure.strong,
    axes,
    hint,
    legend.items.length,
    slices,
  );
  const type = structure.type;
  if (type === 'unknown' || confidence === 'UNKNOWN') return { status: 'unknown' };
  if (confidence !== 'HIGH')
    return { status: 'unsupported', reason: 'low-confidence', type, confidence };

  const unsupported = (reason: ChartUnsupportedReason): ChartAnalysis => ({
    status: 'unsupported',
    reason,
    type,
    confidence,
  });
  if (facts.overBudget) return unsupported('too-large');
  if (type === 'heatmap') return unsupported('heatmap-sequential');
  if (!ADAPTED_TYPES.has(type)) return unsupported('type-not-adapted');
  // Any painted mark outside the legend, axes and background counts: one gradient may be a sequential encoding.
  if (
    dataMarksOf(facts, legend.orders).some(
      (mark) => mark.fill.kind === 'gradient' || mark.stroke.kind === 'gradient',
    )
  ) {
    return unsupported('paint-gradient');
  }
  for (const blocker of facts.blockers) {
    if (blocker !== 'html-legend') return unsupported(BLOCKER_REASON[blocker]);
  }

  const series = withDirectLabels(buildSeries(type, structure.dataMarks), facts, legend.orders);
  const chart: ChartDescriptor = {
    type,
    confidence,
    evidence: [...structure.evidence, `axes:${axes}`, ...(hint ? ['hint'] : [])],
    series,
    legend: mapSeriesToLegend(series, legend.items),
    legendItems: legend.items.length,
    legendOrders: legend.orders,
  };
  const limited = (reason: ChartUnsupportedReason): ChartAnalysis => ({
    status: 'limited',
    reason,
    chart,
  });
  if (series.length > CHART_LIMITS.maxSeries) return limited('too-many-series');
  if (
    (type === 'bar' || type === 'pie' || type === 'donut') &&
    readsAsOrdered(series.map((s) => s.color))
  ) {
    return limited('sequential-palette');
  }
  if (hasOrphanSwatch(facts, series, legend.orders)) return limited('legend-ambiguous');
  if (facts.blockers.includes('html-legend')) return limited('html-legend');
  if (chart.legend.status === 'ambiguous') return limited('legend-ambiguous');
  if ((type === 'pie' || type === 'donut') && chart.legend.status !== 'mapped') {
    return limited('pie-without-legend');
  }
  return { status: 'supported', chart };
}

/**
 * Whether M7 owns this chart: a HIGH-confidence chart of any type, adapted or not. M5 must leave
 * the marks of such an SVG alone, so one set of marks is never touched by two layers.
 */
export function ownsChart(analysis: ChartAnalysis): boolean {
  switch (analysis.status) {
    case 'supported':
    case 'limited':
      return true;
    case 'unsupported':
      return analysis.confidence === 'HIGH';
    default:
      return false;
  }
}
