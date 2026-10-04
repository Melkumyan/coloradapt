import { CHART_LIMITS } from '@shared/constants';
import { LINE_STYLES } from './line-style';
import { LINE_MARKERS, POINT_MARKERS } from './marker';
import { analyzePairs, effectiveSignature, existingSignature, signaturesDistinct } from './palette';
import { PATTERNS } from './pattern';
import {
  DEFAULT_ENCODING,
  encodingKey,
  isDefaultEncoding,
  type ChartAdaptationPlan,
  type ChartDescriptor,
  type ChartPlanResult,
  type ChartSeries,
  type Encoding,
  type LegendItem,
  type PairReport,
  type PlanOptions,
  type SeriesPlan,
} from './types';

/**
 * The encodings a series may be given, in preference order; the first is "as the page drew it".
 *
 * - lines: line style first (it survives any density), then style x marker. Markers are drawn
 *   at every vertex, so a line with more than `maxMarkerVertices` of them gets styles only;
 * - scatter points: silhouette (diamond, triangle, plus, cross) or a hollow ring, as CSS on the point;
 * - bars and slices: pattern.
 */
export function encodingCatalog(series: ChartSeries): Encoding[] {
  const catalog: Encoding[] = [DEFAULT_ENCODING];
  switch (series.kind) {
    case 'line': {
      for (const dash of LINE_STYLES.slice(1)) catalog.push({ dash, marker: null, pattern: null });
      if (series.maxVertices > CHART_LIMITS.maxMarkerVertices || series.memberPoints) break;
      // 5 styles x 5 markers, offset so neighbours in the list differ in both channels.
      for (let shift = 0; shift < LINE_MARKERS.length; shift += 1) {
        for (let s = 0; s < LINE_STYLES.length; s += 1) {
          const marker = LINE_MARKERS[(s + shift) % LINE_MARKERS.length];
          catalog.push({
            dash: LINE_STYLES[s] as Encoding['dash'],
            marker: marker ?? null,
            pattern: null,
          });
        }
      }
      break;
    }
    case 'point':
      for (const marker of POINT_MARKERS) catalog.push({ dash: 'solid', marker, pattern: null });
      break;
    case 'bar':
    case 'slice':
      for (const pattern of PATTERNS) catalog.push({ dash: 'solid', marker: null, pattern });
      break;
  }
  return catalog;
}

/** Legend entries by series id (empty when the chart has no legend). */
function legendItems(chart: ChartDescriptor): Map<string, LegendItem> {
  const items = new Map<string, LegendItem>();
  if (chart.legend.status === 'mapped') {
    for (const pair of chart.legend.pairs) items.set(pair.seriesId, pair.item);
  }
  return items;
}

/**
 * Plans the non-color identity of every series of a supported chart (docs/CHARTS.md, "Policy").
 * Pure: no DOM; the same chart and options always give the same plan.
 *
 * 1. Pairwise: all series colors are simulated for the profile and compared with each other.
 * 2. A *conflict* is a pair that is hard to tell apart by color and is not told apart by anything
 *    else the page already does (dashes, markers, patterns, point shapes, direct labels).
 * 3. Only series in a conflict are written to. The first of a cluster keeps what the page drew;
 *    the others get the first encoding in the catalog that differs from every neighbour's.
 * 4. Encodings the series already had (`options.prior`) are kept when still collision-free, so a
 *    series added or removed does not renumber the others.
 * 5. If some conflict has no free encoding left, the chart is `limited`: nothing is written.
 *
 * Colors are never changed: redundancy first (`colorAdjustment` is always null).
 */
export function planChart(chart: ChartDescriptor, options: PlanOptions): ChartPlanResult {
  const { series } = chart;
  const byId = new Map(series.map((s) => [s.id, s]));
  const pairwise = analyzePairs(series, options.profile, options.severity);

  const neighbours = new Map<string, Set<string>>();
  const alreadyDistinct = new Map<string, boolean>();
  for (const pair of pairwise.pairs) {
    const a = byId.get(pair.a) as ChartSeries;
    const b = byId.get(pair.b) as ChartSeries;
    const distinct = signaturesDistinct(
      existingSignature(a.existing),
      existingSignature(b.existing),
      a.kind,
    );
    alreadyDistinct.set(`${pair.a}|${pair.b}`, distinct);
    if (pair.problematic && !distinct) {
      neighbours.set(pair.a, (neighbours.get(pair.a) ?? new Set()).add(pair.b));
      neighbours.set(pair.b, (neighbours.get(pair.b) ?? new Set()).add(pair.a));
    }
  }

  const decided = new Map<string, Encoding>();
  const catalogs = new Map(series.map((s) => [s.id, encodingCatalog(s)]));
  const compatible = (s: ChartSeries, encoding: Encoding): boolean => {
    const mine = effectiveSignature(s, encoding);
    for (const id of neighbours.get(s.id) ?? []) {
      const other = decided.get(id);
      if (!other) continue;
      const theirs = effectiveSignature(byId.get(id) as ChartSeries, other);
      if (!signaturesDistinct(mine, theirs, s.kind)) return false;
    }
    return true;
  };

  // Identity stability: keep what a series already wears, if it is still valid.
  for (const s of series) {
    // A remembered encoding only matters while the series still needs one: a series no longer in
    // any conflict (its neighbour left, the profile changed) goes back to what the page drew.
    const prior = options.prior?.get(s.id);
    if (!prior || !neighbours.has(s.id)) continue;
    const allowed = (catalogs.get(s.id) ?? []).some(
      (candidate) => encodingKey(candidate) === encodingKey(prior),
    );
    if (allowed && compatible(s, prior)) decided.set(s.id, prior);
  }
  for (const s of series) {
    if (decided.has(s.id) || !neighbours.has(s.id)) continue;
    const choice = (catalogs.get(s.id) ?? []).find((candidate) => compatible(s, candidate));
    if (!choice) return { status: 'limited', reason: 'encoding-exhausted' };
    decided.set(s.id, choice);
  }

  const items = legendItems(chart);
  const plans: SeriesPlan[] = series.map((s) => {
    const encoding = decided.get(s.id) ?? DEFAULT_ENCODING;
    return {
      seriesId: s.id,
      index: s.index,
      kind: s.kind,
      label: s.label ?? items.get(s.id)?.label ?? null,
      color: s.color,
      marks: s.marks,
      existing: s.existing,
      encoding,
      changed: !isDefaultEncoding(encoding),
      legendItem: items.get(s.id) ?? null,
      colorAdjustment: null,
    };
  });

  const planById = new Map(plans.map((p) => [p.seriesId, p]));
  const pairs: PairReport[] = pairwise.pairs.map((pair) => {
    const a = byId.get(pair.a) as ChartSeries;
    const b = byId.get(pair.b) as ChartSeries;
    const after = signaturesDistinct(
      effectiveSignature(a, (planById.get(pair.a) as SeriesPlan).encoding),
      effectiveSignature(b, (planById.get(pair.b) as SeriesPlan).encoding),
      a.kind,
    );
    return {
      ...pair,
      alreadyDistinct: alreadyDistinct.get(`${pair.a}|${pair.b}`) ?? false,
      distinctWithoutColor: after,
    };
  });
  const unresolvedPairs = pairs.filter(
    (pair) => pair.problematic && !pair.distinctWithoutColor,
  ).length;
  // The post-condition: a pair color alone cannot separate is separated by something else.
  if (unresolvedPairs > 0) return { status: 'limited', reason: 'encoding-exhausted' };

  let markerInstances = 0;
  let overlays = 0;
  let patterns = 0;
  for (const plan of plans) {
    if (!plan.changed) continue;
    if (plan.kind === 'line' && plan.encoding.marker) {
      markerInstances += (byId.get(plan.seriesId) as ChartSeries).maxVertices * plan.marks.length;
    }
    // A box or dot swatch of a line series cannot show a dash: a sample line is drawn over it.
    if (plan.legendItem && plan.kind === 'line' && plan.legendItem.kind !== 'line') overlays += 1;
    if (plan.encoding.pattern) patterns += 1;
  }
  if (
    markerInstances > CHART_LIMITS.maxMarkerInstances ||
    overlays > CHART_LIMITS.maxOverlayNodes ||
    patterns > CHART_LIMITS.maxSeries
  ) {
    return { status: 'limited', reason: 'too-large' };
  }

  const plan: ChartAdaptationPlan = {
    type: chart.type,
    confidence: chart.confidence,
    profile: options.profile,
    model: pairwise.model,
    modelConfidence: pairwise.modelConfidence,
    series: plans,
    pairs,
    unresolvedPairs,
    legendMapped: chart.legend.status === 'mapped',
    adapts: plans.some((p) => p.changed),
    budget: { markerInstances, overlays, patterns },
  };
  return { status: 'planned', plan };
}
