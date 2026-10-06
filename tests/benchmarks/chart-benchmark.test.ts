import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StylesheetManager } from '@core/adaptation';
import {
  analyzeChart,
  analyzePairs,
  effectiveSignature,
  existingSignature,
  ownsChart,
  planChart,
  type ChartAnalysis,
} from '@core/charts';
import type { VisionProfile } from '@domain/models';
import { ChartController, readChartFacts } from '@features/charts';
import { createChartEnvironment } from '../features/charts/engine';
import { CANVASES, countElements, countShapes } from '../features/charts/fixtures-r1';
import { BASE_SCENARIOS, type Scenario, type ScenarioContext } from './chart-scenarios';
import { FIXTURE_FACTS, R1_SCENARIOS } from './chart-scenarios-r1';

/**
 * Chart benchmark (docs/CHARTS.md, "Benchmark"): the M7 scenarios and the M7.R1 scenarios through the
 * real controller, with an engine that stands in for the browser's cascade and layout. Every assertion
 * is structural. It records, per chart: the number of series, the color pairs a profile cannot tell
 * apart, the redundancy added (by dash, marker or pattern), the pairs left (which must be none) and
 * whether the legend shows what the chart shows. Real-browser confirmation of the same behaviors is in
 * e2e/chart-*.spec.ts.
 */
const REPORT_DIR = path.resolve(import.meta.dirname, '../../benchmark-report');

const SCENARIOS: readonly Scenario[] = [...BASE_SCENARIOS, ...R1_SCENARIOS];

interface Row {
  readonly scenario: string;
  readonly category: string;
  readonly profile: VisionProfile;
  readonly type: string;
  readonly confidence: string;
  readonly status: string;
  readonly reason: string | null;
  readonly series: number;
  readonly pairs: number;
  readonly problematicPairs: number;
  readonly resolvedByDash: number;
  readonly resolvedByMarker: number;
  readonly resolvedByPattern: number;
  readonly alreadyDistinct: number;
  readonly seriesAdapted: number;
  readonly unresolvedPairs: number;
  readonly legendMapped: boolean;
  readonly legendSyncFailures: number;
  readonly markersCreated: number;
  readonly patternsCreated: number;
  readonly overlaysCreated: number;
  readonly marksScanned: number;
  readonly seriesEvaluated: number;
  readonly legendItemsScanned: number;
  readonly chartPasses: number;
  readonly owned: boolean;
  readonly canvas: string | null;
}

const rows: Row[] = [];

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});
afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

const chartSvg = (): SVGSVGElement | null =>
  (document.getElementById('chart') as SVGSVGElement | null) ??
  document.querySelector<SVGSVGElement>('svg');

/** Marks and legend swatches of every adapted series must carry the same non-color identity. */
function legendSyncFailures(
  svg: Element,
  env: ReturnType<typeof createChartEnvironment>,
  legendMapped: boolean,
): number {
  if (!legendMapped) return 0;
  let failures = 0;
  const bySlot = (attribute: string) => {
    const map = new Map<string, Element[]>();
    for (const el of svg.querySelectorAll(`[${attribute}]`)) {
      const slot = el.getAttribute(attribute)!;
      map.set(slot, [...(map.get(slot) ?? []), el]);
    }
    return map;
  };
  const marks = bySlot('data-coloradapt-chart-mark');
  const legends = bySlot('data-coloradapt-chart-legend');
  const overlays = svg.querySelectorAll('[data-coloradapt-chart-node="overlay"]').length;
  const ratio = (el: Element) => {
    const style = env.getStyle(el);
    const width = Number.parseFloat(style.getPropertyValue('stroke-width')) || 1;
    const dash = style.getPropertyValue('stroke-dasharray');
    return dash === 'none'
      ? 'none'
      : dash
          .split(',')
          .map((n) => (Number.parseFloat(n) / width).toFixed(2))
          .join();
  };
  // the glyph a marker draws (its first path), whatever its id or scale
  const shapeOf = (reference: string) => {
    const id = /#([^")]+)/.exec(reference)?.[1];
    return id ? (document.getElementById(id)?.querySelector('path')?.getAttribute('d') ?? '') : '';
  };
  for (const [slot, members] of marks) {
    const swatches = legends.get(slot);
    if (!swatches || swatches.length === 0) {
      // a line series with a box/dot swatch is drawn over by an overlay (a line sample) instead
      if (overlays === 0) failures += 1;
      continue;
    }
    const mark = members[0]!;
    const swatch = swatches[0]!;
    const m = env.getStyle(mark);
    const l = env.getStyle(swatch);
    if (
      m.getPropertyValue('fill').startsWith('url(') &&
      m.getPropertyValue('fill') !== l.getPropertyValue('fill')
    )
      failures += 1;
    if (
      m.getPropertyValue('clip-path') !== 'none' &&
      m.getPropertyValue('clip-path') !== l.getPropertyValue('clip-path')
    )
      failures += 1;
    if (ratio(mark) !== ratio(swatch)) failures += 1;
    // a legend line sample has two vertices: its marker is at the start (and end), not in the middle
    const markShape = shapeOf(m.getPropertyValue('marker-mid'));
    const swatchShape = shapeOf(
      l.getPropertyValue('marker-start') || l.getPropertyValue('marker-mid'),
    );
    if (markShape !== '' && markShape !== swatchShape) failures += 1;
  }
  return failures;
}

interface Executed {
  readonly row: Row;
  readonly ctx: ScenarioContext;
  readonly cleanup: () => void;
}

function run(scenario: Scenario): Executed {
  document.body.innerHTML = scenario.markup;
  const sheet = new StylesheetManager(document);
  const env = Object.assign(createChartEnvironment(document), { scale: 1 });
  env.unitsPerPixel = () => env.scale;
  const charts = new ChartController({ doc: document, sheet, env });

  // The page as it is drawn, before ColorAdapt: what pairs a profile cannot tell apart, and by what they are resolved.
  const before = chartSvg();
  const pre: ChartAnalysis | null = before ? analyzeChart(readChartFacts(before, env).facts) : null;
  let pairs = 0;
  let problematic = 0;
  let unresolved = 0;
  let series = 0;
  const resolved = { dash: 0, marker: 0, pattern: 0, already: 0 };
  if (pre && (pre.status === 'supported' || pre.status === 'limited')) {
    series = pre.chart.series.length;
    const pairwise = analyzePairs(pre.chart.series, scenario.profile);
    pairs = pairwise.pairs.length;
    problematic = pairwise.pairs.filter((p) => p.problematic).length;
    if (pre.status === 'supported') {
      const planned = planChart(pre.chart, { profile: scenario.profile });
      if (planned.status === 'planned') {
        unresolved = planned.plan.unresolvedPairs;
        const byId = new Map(pre.chart.series.map((s) => [s.id, s]));
        const planById = new Map(planned.plan.series.map((s) => [s.seriesId, s]));
        for (const pair of planned.plan.pairs.filter((p) => p.problematic)) {
          if (pair.alreadyDistinct) {
            resolved.already += 1;
            continue;
          }
          const a = byId.get(pair.a)!;
          const b = byId.get(pair.b)!;
          const sa = effectiveSignature(a, planById.get(pair.a)!.encoding);
          const sb = effectiveSignature(b, planById.get(pair.b)!.encoding);
          if (sa.dash !== sb.dash) resolved.dash += 1;
          else if (sa.marker !== sb.marker || sa.pointShape !== sb.pointShape) resolved.marker += 1;
          else if (sa.pattern !== sb.pattern) resolved.pattern += 1;
          // anything else (width, direct label) is "already told apart" by the page
          else resolved.already += 1;
        }
        void existingSignature;
      }
    }
  }

  charts.begin({ enabled: true, adaptCharts: true, visionProfile: scenario.profile });
  charts.update([{ element: document.body, scope: 'subtree' }]);
  const ctx: ScenarioContext = {
    charts,
    env,
    svg: () => chartSvg()!,
    update: () => {
      charts.update([{ element: document.body, scope: 'subtree' }]);
    },
    updateAt: (element, anchors = []) => {
      charts.update([{ element, scope: 'self' }], anchors);
    },
  };
  scenario.steps?.(ctx);

  const svg = chartSvg();
  const info = svg ? charts.inspect(svg) : charts.inspect(document.body);
  const counters = charts.diagnostics();
  const finalAnalysis = svg
    ? analyzeChart(readChartFacts(svg, env).facts)
    : { status: 'unknown' as const };
  const row: Row = {
    scenario: scenario.name,
    category: scenario.category,
    profile: scenario.profile,
    type: info.type,
    confidence: info.confidence,
    status: info.status,
    reason: info.reason,
    series,
    pairs,
    problematicPairs: problematic,
    resolvedByDash: resolved.dash,
    resolvedByMarker: resolved.marker,
    resolvedByPattern: resolved.pattern,
    alreadyDistinct: resolved.already,
    seriesAdapted: info.adapted,
    unresolvedPairs: unresolved,
    legendMapped: info.legendMapped,
    legendSyncFailures:
      svg && info.status === 'supported' ? legendSyncFailures(svg, env, info.legendMapped) : 0,
    markersCreated: counters.markersCreated,
    patternsCreated: counters.patternsCreated,
    overlaysCreated: counters.overlaysCreated,
    marksScanned: counters.marksScanned,
    seriesEvaluated: counters.seriesEvaluated,
    legendItemsScanned: counters.legendItemsScanned,
    chartPasses: counters.chartPasses,
    owned: svg
      ? charts.owns(svg) || (ownsChart(finalAnalysis) && info.status !== 'unknown')
      : false,
    canvas: null,
  };
  return { row, ctx, cleanup: () => charts.end() };
}

/** Gauges at the final state: what the chart layer holds in the page right now. */
const held = (ctx: ScenarioContext) => {
  const d = ctx.charts.diagnostics();
  return d.chartDefs + d.chartOverlays + d.chartRules;
};

describe('chart benchmark: M7 + M7.R1 scenarios', () => {
  it('has the scenarios and the categories the R1 spec asks for', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(100);
    const categories = new Map<string, number>();
    for (const s of SCENARIOS) categories.set(s.category, (categories.get(s.category) ?? 0) + 1);
    for (const required of [
      'safe adaptation',
      'supported',
      'already distinguishable',
      'ambiguous legend',
      'external legend',
      'false positive: SVG',
      'pie/donut traps',
      'responsive',
      'dynamic',
      'dense',
      'sequential',
      'interactive legend',
    ]) {
      expect(categories.has(required), required).toBe(true);
    }
    expect(categories.get('responsive')).toBeGreaterThanOrEqual(10);
    // the boundary fixtures sit exactly on the limits they claim to
    expect(FIXTURE_FACTS).toEqual({ at2000: 2000, at2001: 2001, at6000: 6000, at6001: 6001 });
    expect(countShapes('<svg><path/><text>a</text></svg>')).toBe(2);
    expect(countElements('<svg><g><path/></g></svg>')).toBe(2);
    const profiles = new Set(SCENARIOS.map((s) => s.profile));
    for (const p of ['protanopia', 'deuteranopia', 'tritanopia'])
      expect(profiles.has(p as VisionProfile)).toBe(true);
  });

  for (const scenario of SCENARIOS) {
    it(`${scenario.category}: ${scenario.name} -> ${scenario.expect}`, () => {
      const { row, ctx, cleanup } = run(scenario);
      rows.push(row);
      switch (scenario.expect) {
        case 'adapted':
          expect(row.status).toBe('supported');
          expect(row.seriesAdapted).toBeGreaterThan(0);
          // the post-condition: no pair the color cannot separate is left without a non-color difference
          expect(row.unresolvedPairs).toBe(0);
          expect(row.legendSyncFailures).toBe(0);
          break;
        case 'untouched':
          expect(row.status).toBe('supported');
          expect(row.seriesAdapted).toBe(0);
          expect(held(ctx)).toBe(0);
          break;
        case 'refused':
          expect(['limited', 'unsupported']).toContain(row.status);
          expect(row.reason).toBe(scenario.reason);
          expect(row.seriesAdapted).toBe(0);
          expect(held(ctx)).toBe(0);
          expect(
            document.querySelectorAll(
              '[data-coloradapt-chart-mark],[data-coloradapt-chart-legend]',
            ),
          ).toHaveLength(0);
          break;
        case 'not-claimed':
          expect(row.owned).toBe(false);
          expect(row.status).not.toBe('supported');
          expect(row.seriesAdapted).toBe(0);
          expect(held(ctx)).toBe(0);
          break;
      }
      scenario.verify?.(ctx);
      cleanup();
      // Hang guard only (no assertion depends on elapsed time; the 2000-mark scenario takes about 7 s alone and
      // more than 30 s under CPU oversubscription, which twice failed a full run in M10.R1 for no code reason).
    }, 90_000);
  }

  describe('canvases are detected, never adapted', () => {
    for (const [name, markup, kind] of CANVASES) {
      it(`${name}: ${kind}, untouched`, () => {
        document.body.innerHTML = markup;
        const proto = (window as unknown as { CanvasRenderingContext2D?: { prototype: object } })
          .CanvasRenderingContext2D?.prototype;
        const snapshot = proto
          ? Object.getOwnPropertyNames(proto).map((n) =>
              String((proto as Record<string, unknown>)[n]),
            )
          : [];
        const before = document.body.innerHTML;
        const sheet = new StylesheetManager(document);
        const charts = new ChartController({
          doc: document,
          sheet,
          env: createChartEnvironment(document),
        });
        charts.begin({ enabled: true, adaptCharts: true, visionProfile: 'deuteranopia' });
        charts.update([{ element: document.body, scope: 'subtree' }]);
        const d = charts.diagnostics();
        expect(kind === 'canvas-chart' ? d.canvasCharts : d.canvasUnknown).toBe(1);
        expect(kind === 'canvas-chart' ? d.canvasUnknown : d.canvasCharts).toBe(0);
        expect(document.body.innerHTML).toBe(before);
        expect(
          document.querySelectorAll('[data-coloradapt-chart-node],[data-coloradapt-chart-mark]'),
        ).toHaveLength(0);
        expect(d.chartRules + d.chartDefs + d.chartOverlays).toBe(0);
        const after = proto
          ? Object.getOwnPropertyNames(proto).map((n) =>
              String((proto as Record<string, unknown>)[n]),
            )
          : [];
        expect(after).toEqual(snapshot);
        rows.push({
          scenario: name,
          category: 'canvas',
          profile: 'deuteranopia',
          type: 'canvas',
          confidence: 'n/a',
          status: 'canvas',
          reason: null,
          series: 0,
          pairs: 0,
          problematicPairs: 0,
          resolvedByDash: 0,
          resolvedByMarker: 0,
          resolvedByPattern: 0,
          alreadyDistinct: 0,
          seriesAdapted: 0,
          unresolvedPairs: 0,
          legendMapped: false,
          legendSyncFailures: 0,
          markersCreated: 0,
          patternsCreated: 0,
          overlaysCreated: 0,
          marksScanned: 0,
          seriesEvaluated: 0,
          legendItemsScanned: 0,
          chartPasses: 0,
          owned: false,
          canvas: kind,
        });
        charts.end();
      });
    }
  });

  it('a legend always shows what the chart shows: every adapted mapped series has a tagged legend entry', () => {
    let checked = 0;
    for (const scenario of SCENARIOS.filter((s) => s.expect === 'adapted' && !s.steps)) {
      document.body.innerHTML = scenario.markup;
      const sheet = new StylesheetManager(document);
      const charts = new ChartController({
        doc: document,
        sheet,
        env: createChartEnvironment(document),
      });
      charts.begin({ enabled: true, adaptCharts: true, visionProfile: scenario.profile });
      charts.update([{ element: document.body, scope: 'subtree' }]);
      const markSlots = new Set(
        [...document.querySelectorAll('[data-coloradapt-chart-mark]')].map((n) =>
          n.getAttribute('data-coloradapt-chart-mark'),
        ),
      );
      const legendSlots = new Set(
        [...document.querySelectorAll('[data-coloradapt-chart-legend]')].map((n) =>
          n.getAttribute('data-coloradapt-chart-legend'),
        ),
      );
      const overlays = document.querySelectorAll('[data-coloradapt-chart-node="overlay"]').length;
      const legendBearing = document.querySelectorAll('.legend-item').length > 0;
      if (legendBearing && markSlots.size > 0) {
        checked += 1;
        // line charts tag the legend sample or draw an overlay; bars/pies tag the swatch; scatter overlays the dot
        expect(legendSlots.size + overlays, scenario.name).toBeGreaterThan(0);
        for (const value of legendSlots)
          expect(markSlots.has(value), `${scenario.name}: ${value}`).toBe(true);
      }
      charts.end();
    }
    expect(checked).toBeGreaterThan(15);
  });

  afterAll(() => {
    const chartRows = rows.filter((r) => r.category !== 'canvas');
    const supported = chartRows.filter((r) => r.status === 'supported');
    const unsupported = chartRows.filter(
      (r) => r.status === 'unsupported' || r.status === 'limited',
    );
    const trap = SCENARIOS.filter((s) => s.expect === 'not-claimed');
    const summary = {
      scenarios: rows.length,
      charts: chartRows.length,
      canvases: rows.length - chartRows.length,
      supported: supported.length,
      adapted: supported.filter((r) => r.seriesAdapted > 0).length,
      alreadyDistinguishable: supported.filter((r) => r.seriesAdapted === 0).length,
      unsupportedOrLimited: unsupported.length,
      ambiguous: unsupported.filter(
        (r) => r.reason === 'legend-ambiguous' || r.reason === 'html-legend',
      ).length,
      encodingExhausted: unsupported.filter((r) => r.reason === 'encoding-exhausted').length,
      falsePositiveTraps: trap.length,
      falsePositiveOwnership: trap.filter((s) => rows.find((r) => r.scenario === s.name)?.owned)
        .length,
      legendSyncFailures: chartRows.reduce((sum, r) => sum + r.legendSyncFailures, 0),
      seriesAnalyzed: chartRows.reduce((sum, r) => sum + r.series, 0),
      problematicPairsBefore: chartRows.reduce((sum, r) => sum + r.problematicPairs, 0),
      // pairs in charts M7 had a plan for (all resolved: see the four channels below) and in charts it refused (left as the page drew them)
      problematicPairsPlanned: chartRows.reduce(
        (sum, r) =>
          sum + r.resolvedByDash + r.resolvedByMarker + r.resolvedByPattern + r.alreadyDistinct,
        0,
      ),
      problematicPairsRefused:
        chartRows.reduce((sum, r) => sum + r.problematicPairs, 0) -
        chartRows.reduce(
          (sum, r) =>
            sum + r.resolvedByDash + r.resolvedByMarker + r.resolvedByPattern + r.alreadyDistinct,
          0,
        ),
      unresolvedPairsAfter: chartRows.reduce((sum, r) => sum + r.unresolvedPairs, 0),
      pairsResolvedByDash: chartRows.reduce((sum, r) => sum + r.resolvedByDash, 0),
      pairsResolvedByMarker: chartRows.reduce((sum, r) => sum + r.resolvedByMarker, 0),
      pairsResolvedByPattern: chartRows.reduce((sum, r) => sum + r.resolvedByPattern, 0),
      pairsAlreadyDistinguishable: chartRows.reduce((sum, r) => sum + r.alreadyDistinct, 0),
      marksScanned: chartRows.reduce((sum, r) => sum + r.marksScanned, 0),
      seriesEvaluated: chartRows.reduce((sum, r) => sum + r.seriesEvaluated, 0),
      legendItemsScanned: chartRows.reduce((sum, r) => sum + r.legendItemsScanned, 0),
      chartPasses: chartRows.reduce((sum, r) => sum + r.chartPasses, 0),
      patternsCreated: chartRows.reduce((sum, r) => sum + r.patternsCreated, 0),
      markersCreated: chartRows.reduce((sum, r) => sum + r.markersCreated, 0),
    };
    const byCategory: Record<string, number> = {};
    for (const r of rows) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
    const byProfile: Record<string, { charts: number; adapted: number; problematicPairs: number }> =
      {};
    for (const r of chartRows) {
      const slot = (byProfile[r.profile] ??= { charts: 0, adapted: 0, problematicPairs: 0 });
      slot.charts += 1;
      if (r.status === 'supported' && r.seriesAdapted > 0) slot.adapted += 1;
      slot.problematicPairs += r.problematicPairs;
    }
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(
      path.join(REPORT_DIR, 'chart-benchmark.json'),
      JSON.stringify(
        {
          generatedBy: 'tests/benchmarks/chart-benchmark.test.ts',
          note: 'Structural diagnostics only; no timing is asserted.',
          summary,
          byCategory,
          byProfile,
          rows,
        },
        null,
        2,
      ),
    );
  });
});
