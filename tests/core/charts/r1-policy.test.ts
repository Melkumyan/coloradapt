import { describe, expect, it } from 'vitest';
import {
  analyzeChart,
  POINT_MARKERS,
  analyzePairs,
  encodingKey,
  isDivergingPalette,
  isOrderedRamp,
  isSequentialPalette,
  planChart,
  signaturesDistinct,
  effectiveSignature,
  type ChartAdaptationPlan,
  type ChartDescriptor,
  type Encoding,
} from '@core/charts';
import type { VisionProfile } from '@domain/models';
import {
  CONFUSABLE,
  DISTINCT,
  FactsBuilder,
  REDS,
  barChart,
  lineChart,
  paint,
  pieChart,
  rgb,
  scatterChart,
} from './builders';

/**
 * M7.R1: policy invariants of the pure core: identity stability, exhaustion, pairwise and legend
 * identity, color preservation, ordered palettes, false-positive traps, structural boundaries.
 */
const PROFILES: readonly VisionProfile[] = ['protanopia', 'deuteranopia', 'tritanopia'];

function supported(facts: ReturnType<FactsBuilder['build']>): ChartDescriptor {
  const analysis = analyzeChart(facts);
  if (analysis.status !== 'supported') {
    throw new Error(
      `not supported: ${analysis.status} ${'reason' in analysis ? analysis.reason : ''}`,
    );
  }
  return analysis.chart;
}

function plan(
  chart: ChartDescriptor,
  profile: VisionProfile = 'deuteranopia',
  prior?: Map<string, Encoding>,
): ChartAdaptationPlan {
  const result = planChart(chart, { profile, ...(prior ? { prior } : {}) });
  if (result.status !== 'planned') throw new Error(`limited: ${result.reason}`);
  return result.plan;
}

const encodingsOf = (p: ChartAdaptationPlan) =>
  Object.fromEntries(p.series.map((s) => [s.seriesId, encodingKey(s.encoding)]));
const remember = (p: ChartAdaptationPlan) => new Map(p.series.map((s) => [s.seriesId, s.encoding]));

describe('series identity stays with the series (append / remove / return)', () => {
  const four = ['#d62728', '#d82a29', '#da2c2b', '#dc2e2d'];
  const keyed = (indices: readonly number[]) => {
    const b = new FactsBuilder();
    b.hints = ['chart'];
    b.axes();
    indices.forEach((i, position) => {
      b.line(four[i]!, { dataSeries: `s${i}`, box: { x: 50, y: 40 + i * 20, w: 320, h: 100 } });
      b.legendItem(four[i]!, `Series ${i}`, position, 'line', { dataSeries: `s${i}` });
    });
    return b.build();
  };

  it('A B -> A B C: A and B keep what they wore; C gets a new identity', () => {
    const ab = plan(supported(keyed([0, 1])));
    const abc = plan(supported(keyed([0, 1, 2])), 'deuteranopia', remember(ab));
    expect(encodingsOf(abc)['k:s0']).toBe(encodingsOf(ab)['k:s0']);
    expect(encodingsOf(abc)['k:s1']).toBe(encodingsOf(ab)['k:s1']);
    expect(new Set(Object.values(encodingsOf(abc))).size).toBe(3);
  });

  it('A B C -> A C -> A B C: A and C are unchanged, and B returns to the very same identity', () => {
    const abc = plan(supported(keyed([0, 1, 2])));
    const prior = remember(abc);
    const ac = plan(supported(keyed([0, 2])), 'deuteranopia', prior);
    expect(encodingsOf(ac)['k:s0']).toBe(encodingsOf(abc)['k:s0']);
    expect(encodingsOf(ac)['k:s2']).toBe(encodingsOf(abc)['k:s2']);
    // prior is kept per chart (the controller does not forget a series that left): B comes back as it was
    for (const [id, encoding] of remember(ac)) prior.set(id, encoding);
    const back = plan(supported(keyed([0, 1, 2])), 'deuteranopia', prior);
    expect(encodingsOf(back)).toEqual(encodingsOf(abc));
  });

  it('without prior, planning is a pure function of the chart: the same chart gives the same plan', () => {
    const a = plan(supported(keyed([0, 1, 2, 3])));
    const b = plan(supported(keyed([0, 1, 2, 3])));
    expect(encodingsOf(a)).toEqual(encodingsOf(b));
  });

  it('new geometry (more vertices) under the same keys changes nothing while the encoding is still valid', () => {
    const base = supported(keyed([0, 1, 2]));
    const first = plan(base);
    const heavier: ChartDescriptor = {
      ...base,
      series: base.series.map((s) => ({ ...s, maxVertices: s.maxVertices + 20 })),
    };
    expect(encodingsOf(plan(heavier, 'deuteranopia', remember(first)))).toEqual(encodingsOf(first));
  });

  it('a profile change starts over: what protanopia needed is not carried to tritanopia', () => {
    const chart = supported(lineChart(CONFUSABLE, { keys: true }).build());
    const protan = plan(chart, 'protanopia');
    const tritan = plan(chart, 'tritanopia');
    expect(protan.series.some((s) => s.changed)).toBe(true);
    // red/green/orange are different enough for a tritanope: nothing is written
    expect(tritan.series.every((s) => !s.changed)).toBe(true);
    // and back
    expect(encodingsOf(plan(chart, 'protanopia'))).toEqual(encodingsOf(protan));
  });

  it('the strength of the color adaptation (M3) plays no role: M7 reads the profile, never a strength', () => {
    const chart = supported(lineChart(REDS).build());
    const a = planChart(chart, { profile: 'deuteranopia' });
    const b = planChart(chart, { profile: 'deuteranopia', severity: undefined });
    expect(a).toEqual(b);
  });
});

describe('encoding exhaustion refuses the chart atomically', () => {
  it('eight near-identical scatter groups need more silhouettes than exist', () => {
    const reds = Array.from({ length: 8 }, (_, i) => `#${(0xd6 + i).toString(16)}2728`);
    const chart = supported(scatterChart(reds).build());
    expect(planChart(chart, { profile: 'deuteranopia' })).toEqual({
      status: 'limited',
      reason: 'encoding-exhausted',
    });
  });

  it('six near-identical lines of 100 vertices: dashes alone (five) are not enough, markers are off', () => {
    const six = ['#d62728', '#d82a29', '#da2c2b', '#dc2e2d', '#de302f', '#e03231'];
    const b = new FactsBuilder();
    b.hints = ['chart'];
    b.axes();
    six.forEach((color, i) =>
      b.line(color, { vertices: 100, box: { x: 50, y: 40 + i * 20, w: 320, h: 100 } }),
    );
    const chart = supported(b.build());
    expect(planChart(chart, { profile: 'deuteranopia' })).toEqual({
      status: 'limited',
      reason: 'encoding-exhausted',
    });
  });

  it('the scatter catalog is the limit: its size fits, one more does not', () => {
    const groups = (n: number) =>
      Array.from({ length: n }, (_, i) => `#${(0xd6 + i).toString(16)}2728`);
    const size = 1 + POINT_MARKERS.length;
    const fits = planChart(supported(scatterChart(groups(size)).build()), {
      profile: 'deuteranopia',
    });
    expect(fits.status).toBe('planned');
    if (fits.status === 'planned') {
      expect(new Set(fits.plan.series.map((s) => encodingKey(s.encoding))).size).toBe(size);
    }
    expect(
      planChart(supported(scatterChart(groups(size + 1)).build()), { profile: 'deuteranopia' }),
    ).toEqual({ status: 'limited', reason: 'encoding-exhausted' });
  });
});

describe('invariants over a grid of charts, profiles and palettes', () => {
  const palettes: ReadonlyArray<readonly string[]> = [
    REDS,
    CONFUSABLE,
    DISTINCT,
    ['#d62728', '#2ca02c'],
    ['#1f77b4', '#2ca02c', '#d62728', '#8c564b'],
    ['#d62728', '#d82a29', '#da2c2b', '#dc2e2d', '#de302f', '#e03231'],
  ];
  const builders = {
    line: lineChart,
    bar: barChart,
    scatter: scatterChart,
  } as const;

  const cases = Object.entries(builders).flatMap(([kind, build]) =>
    palettes.flatMap((colors) => PROFILES.map((profile) => ({ kind, build, colors, profile }))),
  );

  it('covers a real grid', () => {
    expect(cases.length).toBe(3 * 6 * 3);
  });

  it('every problematic pair ends with a non-color difference; colors are never changed; no two conflicting series share an identity', () => {
    let planned = 0;
    let refused = 0;
    for (const { build, colors, profile } of cases) {
      const analysis = analyzeChart(build(colors).build());
      if (analysis.status !== 'supported') continue;
      const result = planChart(analysis.chart, { profile });
      if (result.status === 'limited') {
        // atomic: a refusal never carries a half plan
        expect(result.reason).toBe('encoding-exhausted');
        refused += 1;
        continue;
      }
      planned += 1;
      const p = result.plan;
      expect(p.unresolvedPairs).toBe(0);
      const byId = new Map(analysis.chart.series.map((s) => [s.id, s]));
      for (const pair of p.pairs.filter((x) => x.problematic)) {
        expect(pair.distinctWithoutColor).toBe(true);
        const a = byId.get(pair.a)!;
        const b = byId.get(pair.b)!;
        const sa = p.series.find((s) => s.seriesId === pair.a)!;
        const sb = p.series.find((s) => s.seriesId === pair.b)!;
        expect(
          signaturesDistinct(
            effectiveSignature(a, sa.encoding),
            effectiveSignature(b, sb.encoding),
            a.kind,
          ),
        ).toBe(true);
        // and the legend shows the same identity as the series
        if (sa.changed && sb.changed) {
          expect(encodingKey(sa.encoding)).not.toBe(encodingKey(sb.encoding));
        }
      }
      // color preservation: M7 adds redundancy, it does not recolor
      for (const s of p.series) {
        expect(s.colorAdjustment).toBeNull();
        expect(s.color).toEqual(byId.get(s.seriesId)!.color);
      }
    }
    expect(planned).toBeGreaterThan(30);
    expect(refused + planned).toBeGreaterThan(0);
  });

  it('every adapted series that has a legend entry has the entry in the plan (legend identity == series identity)', () => {
    let checked = 0;
    for (const { build, colors, profile } of cases) {
      const analysis = analyzeChart(build(colors).build());
      if (analysis.status !== 'supported' || analysis.chart.legend.status !== 'mapped') continue;
      const result = planChart(analysis.chart, { profile });
      if (result.status !== 'planned') continue;
      for (const s of result.plan.series) {
        expect(s.legendItem).not.toBeNull();
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('pairwise analysis is symmetric and total: n(n-1)/2 pairs', () => {
    const chart = supported(lineChart(CONFUSABLE).build());
    const pairs = analyzePairs(chart.series, 'deuteranopia').pairs;
    expect(pairs).toHaveLength(3);
  });
});

describe('structural boundaries are exact (no timing involved)', () => {
  const distinctColors = (n: number) =>
    Array.from({ length: n }, (_, i) => `hsl(${(i * 360) / n}, 70%, 50%)`).map((c) => {
      const m = /hsl\((\S+), 70%, 50%\)/.exec(c)!;
      const h = Number(m[1]) / 60;
      const x = 1 - Math.abs((h % 2) - 1);
      const [r, g, b] =
        h < 1
          ? [1, x, 0]
          : h < 2
            ? [x, 1, 0]
            : h < 3
              ? [0, 1, x]
              : h < 4
                ? [0, x, 1]
                : h < 5
                  ? [x, 0, 1]
                  : [1, 0, x];
      const hex = (v: number) =>
        Math.round((0.15 + v * 0.7) * 255)
          .toString(16)
          .padStart(2, '0');
      return `#${hex(r)}${hex(g)}${hex(b)}`;
    });

  it('12 series are supported; 13 are refused as too-many-series', () => {
    const twelve = analyzeChart(lineChart(distinctColors(12), { legend: false }).build());
    expect(twelve.status).toBe('supported');
    const thirteen = analyzeChart(lineChart(distinctColors(13), { legend: false }).build());
    expect(thirteen).toMatchObject({ status: 'limited', reason: 'too-many-series' });
  });

  it('500 marker instances fit; 510 do not', () => {
    const chartWith = (paths: number, vertices: number) => {
      const b = lineChart(['#d62728', '#d82a29', '#da2c2b', '#dc2e2d', '#de302f'], {
        legend: false,
      });
      for (let i = 0; i < paths; i += 1) {
        b.line('#e03231', { vertices, box: { x: 50, y: 40 + i, w: 320, h: 100 } });
      }
      return supported(b.build());
    };
    const fits = planChart(chartWith(10, 50), { profile: 'deuteranopia' });
    expect(fits.status).toBe('planned');
    if (fits.status === 'planned') {
      expect(fits.plan.budget.markerInstances).toBe(500);
    }
    expect(planChart(chartWith(10, 51), { profile: 'deuteranopia' })).toEqual({
      status: 'limited',
      reason: 'too-large',
    });
  });
});

describe('ordered palettes are classified, never categorically adapted', () => {
  const ramp = (hexes: readonly string[]) => hexes.map((h) => rgb(h));
  const SEQUENTIAL = ['#deebf7', '#9ecae1', '#4292c6', '#08519c'];
  const DIVERGING = ['#b2182b', '#ef8a62', '#f7f7f7', '#67a9cf', '#2166ac'];
  const DIVERGING_TINTS = ['#a50026', '#f46d43', '#fee090', '#74add1', '#313695'];
  const VIRIDIS = ['#440154', '#3b528b', '#21908d', '#5dc863', '#fde725'];
  const YL_OR_RD = ['#ffffb2', '#fecc5c', '#fd8d3c', '#e31a1c'];
  const GRAYS = ['#f0f0f0', '#bdbdbd', '#737373', '#252525'];
  const CATEGORICAL = [
    ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728'],
    ['#0072b2', '#d55e00', '#f0e442', '#009e73'],
    ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3'],
    ['#1f77b4', '#2ca02c', '#d62728', '#8c564b'],
  ];

  it('sequential, diverging, viridis, yellow-orange-red and gray ramps read as ordered', () => {
    expect(isSequentialPalette(ramp(SEQUENTIAL))).toBe(true);
    expect(isDivergingPalette(ramp(DIVERGING))).toBe(true);
    expect(isDivergingPalette(ramp(DIVERGING_TINTS))).toBe(true);
    expect(isOrderedRamp(ramp(VIRIDIS))).toBe(true);
    expect(isOrderedRamp(ramp(YL_OR_RD))).toBe(true);
    expect(isSequentialPalette(ramp(GRAYS))).toBe(true);
  });

  it('categorical palettes do not', () => {
    for (const colors of CATEGORICAL) {
      expect(isSequentialPalette(ramp(colors))).toBe(false);
      expect(isDivergingPalette(ramp(colors))).toBe(false);
      expect(isOrderedRamp(ramp(colors))).toBe(false);
    }
  });

  for (const [name, colors] of [
    ['single hue', SEQUENTIAL],
    ['diverging red-white-blue', DIVERGING],
    ['diverging with tinted midpoint', DIVERGING_TINTS],
    ['temperature-like (viridis)', VIRIDIS],
    ['ordered yellow-orange-red', YL_OR_RD],
    ['gray ramp', GRAYS],
  ] as const) {
    it(`bars in a ${name} palette: limited, nothing written`, () => {
      const analysis = analyzeChart(barChart(colors).build());
      expect(analysis).toMatchObject({ status: 'limited', reason: 'sequential-palette' });
    });
  }

  it('pie slices in a ramp are refused the same way', () => {
    expect(analyzeChart(pieChart(SEQUENTIAL).build())).toMatchObject({
      status: 'limited',
      reason: 'sequential-palette',
    });
  });

  it('lines in the same colors are categorical by nature and keep the normal policy', () => {
    expect(analyzeChart(lineChart(SEQUENTIAL).build()).status).toBe('supported');
  });
});

describe('pie / donut false-positive traps are never supported', () => {
  const arc = (
    b: FactsBuilder,
    color: string,
    init: { arcCount?: number; box?: { x: number; y: number; w: number; h: number } } = {},
  ) =>
    b.mark({
      tag: 'path',
      fill: paint(color),
      closed: true,
      arcCount: init.arcCount ?? 1,
      vertices: 4,
      box: init.box ?? { x: 50, y: 50, w: 200, h: 200 },
      parent: 6,
    });
  const status = (b: FactsBuilder) => analyzeChart(b.build()).status;

  it('a decorative ring (one arc path, one color)', () => {
    const b = new FactsBuilder();
    b.hints = ['avatar-ring'];
    arc(b, '#3366cc', { arcCount: 2 });
    expect(status(b)).not.toBe('supported');
  });

  it('a progress circle (stroked circle, no fill)', () => {
    const b = new FactsBuilder();
    b.hints = ['progress'];
    b.mark({
      tag: 'circle',
      stroke: paint('#e5e5e5'),
      strokeWidth: 8,
      closed: true,
      box: { x: 10, y: 10, w: 80, h: 80 },
    });
    b.mark({
      tag: 'circle',
      stroke: paint('#2ca02c'),
      strokeWidth: 8,
      dash: '120 300',
      closed: true,
      box: { x: 10, y: 10, w: 80, h: 80 },
    });
    expect(status(b)).not.toBe('supported');
  });

  it('a gauge (two arcs: track and value, with a hint)', () => {
    const b = new FactsBuilder();
    b.hints = ['gauge', 'chart'];
    arc(b, '#dddddd', { arcCount: 1 });
    arc(b, '#d62728', { arcCount: 1 });
    expect(status(b)).not.toBe('supported');
  });

  it('a spinner / loading donut (segments of one gray family, no legend)', () => {
    const b = new FactsBuilder();
    b.hints = ['spinner', 'chart'];
    for (const g of ['#bbbbbb', '#999999', '#777777', '#555555']) arc(b, g, { arcCount: 2 });
    expect(status(b)).not.toBe('supported');
  });

  it('a pie with no legend', () => {
    expect(status(pieChart(['#d62728', '#2ca02c', '#1f77b4'], { legend: false }))).not.toBe(
      'supported',
    );
    expect(
      analyzeChart(pieChart(['#d62728', '#2ca02c', '#1f77b4'], { legend: false }).build()),
    ).not.toMatchObject({
      status: 'supported',
    });
  });

  it('a pie with an incomplete legend (three slices, two entries)', () => {
    const b = pieChart(['#d62728', '#2ca02c', '#1f77b4'], { legend: false });
    b.legendItem('#d62728', 'Slice 1', 0, 'box');
    b.legendItem('#2ca02c', 'Slice 2', 1, 'box');
    expect(status(b)).not.toBe('supported');
  });

  it('a pie with duplicate colors in its legend', () => {
    const b = pieChart(['#d62728', '#d62728', '#1f77b4'], { legend: false });
    b.legendItem('#d62728', 'Slice 1', 0, 'box');
    b.legendItem('#d62728', 'Slice 2', 1, 'box');
    b.legendItem('#1f77b4', 'Slice 3', 2, 'box');
    expect(status(b)).not.toBe('supported');
  });

  it('the genuine pie and donut with a complete legend are still supported', () => {
    expect(status(pieChart(['#d62728', '#2ca02c', '#1f77b4']))).toBe('supported');
    expect(status(pieChart(['#d62728', '#2ca02c', '#1f77b4'], { donut: true }))).toBe('supported');
  });
});

describe('axis evidence is axes: connectors, cell numbers and value labels are not', () => {
  const owned = (b: FactsBuilder) => {
    const analysis = analyzeChart(b.build());
    return analysis.status === 'supported' || analysis.status === 'limited'
      ? true
      : analysis.status === 'unsupported' && analysis.confidence === 'HIGH';
  };

  it('a network of colored nodes joined by diagonal links (with a "chart" id) is not a scatter', () => {
    const b = new FactsBuilder();
    b.hints = ['chart'];
    const nodes: Array<[number, number]> = [
      [60, 60],
      [160, 40],
      [260, 90],
      [340, 50],
      [90, 170],
      [200, 150],
      [300, 210],
      [140, 250],
      [250, 270],
    ];
    nodes.forEach(([x, y], i) => {
      if (i > 0) {
        const [px, py] = nodes[i - 1]!;
        b.mark({
          tag: 'line',
          stroke: paint('#999999'),
          vertices: 2,
          box: { x: Math.min(x, px), y: Math.min(y, py), w: Math.abs(x - px), h: Math.abs(y - py) },
        });
      }
      b.point(['#e63946', '#457b9d', '#2a9d8f', '#e9c46a', '#f4a261', '#264653'][i % 6]!, x, y, {
        box: { x: x - 10, y: y - 10, w: 20, h: 20 },
      });
      b.text(`n${i}`, { x: x - 6, y: y + 14, w: 14, h: 10 });
    });
    expect(owned(b)).toBe(false);
  });

  it('a calendar grid whose cells hold the day numbers is not a heatmap chart', () => {
    const b = new FactsBuilder();
    b.hints = ['chart'];
    for (let day = 0; day < 35; day += 1) {
      const x = 20 + (day % 7) * 52;
      const y = 30 + Math.floor(day / 7) * 46;
      b.rect(day % 9 === 0 ? '#ffd6d6' : '#f3f3f3', { x, y, w: 48, h: 42 });
      b.text(String(day + 1), { x: x + 4, y: y + 4, w: 12, h: 10 });
    }
    expect(owned(b)).toBe(false);
  });

  it('three bars with their percentages above them are an infographic, not an axis of tick labels', () => {
    const b = new FactsBuilder();
    b.hints = ['chart'];
    (
      [
        [20, 120],
        [120, 80],
        [220, 60],
      ] as const
    ).forEach(([x, h], i) => {
      b.rect(['#e63946', '#457b9d', '#2a9d8f'][i]!, { x, y: 200 - h, w: 60, h });
      b.text(`${[42, 28, 21][i]}%`, { x: x + 10, y: 200 - h - 18, w: 40, h: 12 });
    });
    expect(owned(b)).toBe(false);
  });

  it('a row of dated dots on one axis is a timeline, not a scatter', () => {
    const b = new FactsBuilder();
    b.hints = ['chart'];
    b.mark({
      tag: 'path',
      stroke: paint('#888888'),
      vertices: 2,
      rectilinear: true,
      box: { x: 20, y: 150, w: 360, h: 0 },
    });
    [2014, 2016, 2017, 2019, 2020, 2022, 2023, 2024].forEach((year, i) => {
      b.point(['#e63946', '#457b9d', '#2a9d8f', '#e9c46a'][i % 4]!, 30 + i * 46, 150);
      b.text(String(year), { x: 18 + i * 46, y: 170, w: 24, h: 10 });
    });
    expect(owned(b)).toBe(false);
  });

  it('what a real chart has still counts: a D3 domain path with end ticks, aligned tick labels', () => {
    const b = new FactsBuilder();
    b.hints = ['chart'];
    b.mark({
      tag: 'path',
      stroke: paint('#000000'),
      vertices: 4,
      rectilinear: true,
      box: { x: 0, y: 250, w: 350, h: 6 },
      parent: 5,
    });
    for (let i = 0; i < 6; i += 1)
      b.text(String(i * 10), { x: i * 70, y: 262, w: 12, h: 10 }, { parent: 5 });
    b.line('#d62728', { box: { x: 0, y: 40, w: 340, h: 100 } });
    b.line('#2ca02c', { box: { x: 0, y: 60, w: 340, h: 100 } });
    expect(analyzeChart(b.build()).status).toBe('supported');
  });
});

describe('direct labels are claimed only when the layout can say so', () => {
  const labelled = (withBoxes: boolean) => {
    const b = lineChart(REDS, { legend: false });
    REDS.forEach((color, i) =>
      b.text(`Series ${i + 1}`, withBoxes ? { x: 330, y: 40 + i * 20 + 50, w: 50, h: 10 } : null, {
        color,
      }),
    );
    return supported(b.build());
  };

  it('labels next to the lines, in their colors: told apart, nothing added', () => {
    const p = plan(labelled(true));
    expect(p.series.every((s) => !s.changed)).toBe(true);
  });

  it('the same labels with no layout: nothing is guessed, the series still need their redundancy', () => {
    const p = plan(labelled(false));
    expect(p.series.some((s) => s.changed)).toBe(true);
  });
});
