import { describe, expect, it } from 'vitest';
import {
  analyzeChart,
  analyzePairs,
  dashArrayFor,
  encodingCatalog,
  encodingKey,
  normalizeDashArray,
  pathStats,
  planChart,
  pointsCount,
  type ChartDescriptor,
  type Encoding,
  type SeriesPlan,
} from '@core/charts';
import {
  CONFUSABLE,
  DISTINCT,
  REDS,
  FactsBuilder,
  barChart,
  lineChart,
  paint,
  pieChart,
  scatterChart,
} from './builders';

function chartOf(builder: FactsBuilder): ChartDescriptor {
  const analysis = analyzeChart(builder.build());
  if (analysis.status !== 'supported')
    throw new Error(
      `not supported: ${JSON.stringify(analysis, (_k: string, v: unknown): unknown => (v instanceof Set ? [...v] : v))}`,
    );
  return analysis.chart;
}

function planOf(
  chart: ChartDescriptor,
  profile: 'deuteranopia' | 'protanopia' | 'tritanopia' = 'deuteranopia',
  prior?: ReadonlyMap<string, Encoding>,
) {
  const result = planChart(chart, { profile, ...(prior ? { prior } : {}) });
  if (result.status !== 'planned') throw new Error(`limited: ${result.reason}`);
  return result.plan;
}

const encodings = (plans: readonly SeriesPlan[]) => plans.map((p) => encodingKey(p.encoding));

describe('paths', () => {
  it('counts vertices, arcs, closure and rectilinearity', () => {
    expect(pathStats('M0,0 L10,5 L20,0 L30,9')).toMatchObject({
      vertices: 4,
      arcCount: 0,
      closed: false,
      rectilinear: false,
    });
    expect(pathStats('M0.5,6V0.5H100.5V6')).toMatchObject({ vertices: 4, rectilinear: true });
    expect(pathStats('M 50 50 L 100 50 A 50 50 0 0 1 50 100 Z')).toMatchObject({
      vertices: 3,
      arcCount: 1,
      closed: true,
    });
    expect(pathStats('M0 0 C 1 1 2 2 3 3 S 4 4 5 5')).toMatchObject({
      vertices: 3,
      rectilinear: false,
    });
    expect(pathStats('m0 0 l10 0 l0 10').rectilinear).toBe(true);
    expect(pathStats('')).toMatchObject({ vertices: 0 });
  });

  it('counts polyline points', () => {
    expect(pointsCount('0,0 10,10 20,0')).toBe(3);
  });
});

describe('line styles and dash normalization', () => {
  it('dash arrays scale with the stroke and are deterministic', () => {
    expect(dashArrayFor('solid', 2)).toBeNull();
    expect(dashArrayFor('dashed', 2)).toBe('10 4');
    expect(dashArrayFor('dashed', 2)).toBe(dashArrayFor('dashed', 2));
    expect(dashArrayFor('dotted', 0.5)).toBe('2.25 2.25');
    expect(
      new Set(
        ['dashed', 'dotted', 'dash-dot', 'long-dash'].map((s) => dashArrayFor(s as 'dashed', 2)),
      ).size,
    ).toBe(4);
  });

  it('normalizes what the browser reports', () => {
    expect(normalizeDashArray('8px, 5px')).toBe('8 5');
    expect(normalizeDashArray('5')).toBe('5 5');
    expect(normalizeDashArray('none')).toBeNull();
    expect(normalizeDashArray('0')).toBeNull();
    expect(normalizeDashArray(null)).toBeNull();
  });
});

describe('legend detection and series <-> legend mapping', () => {
  it('maps by color when every color is used once', () => {
    const chart = chartOf(lineChart(CONFUSABLE));
    expect(chart.legend.status).toBe('mapped');
    if (chart.legend.status === 'mapped') {
      expect(chart.legend.pairs.map((p) => [p.seriesId, p.item.label, p.evidence])).toEqual([
        ['c:#d62728', 'Series 1', 'color'],
        ['c:#2ca02c', 'Series 2', 'color'],
        ['c:#ff7f0e', 'Series 3', 'color'],
      ]);
    }
  });

  it('prefers an author key over color', () => {
    const chart = chartOf(lineChart(CONFUSABLE, { keys: true }));
    if (chart.legend.status !== 'mapped') throw new Error('expected mapped');
    expect(chart.legend.pairs.every((p) => p.evidence === 'key')).toBe(true);
  });

  it('two series of one color and no keys: ambiguous, never guessed from order or position', () => {
    const b = lineChart(['#d62728', '#d62728'], { dashes: [null, '4 2'], legend: false });
    b.legendItem('#d62728', 'A', 0, 'line');
    b.legendItem('#d62728', 'B', 1, 'line', { dash: '4 2' });
    const analysis = analyzeChart(b.build());
    expect(analysis).toMatchObject({ status: 'limited', reason: 'legend-ambiguous' });
  });

  it('a legend whose swatch colors match no series is ambiguous (a legend we cannot read)', () => {
    const b = lineChart(['#d62728', '#2ca02c'], { legend: false });
    b.legendItem('#112233', 'X', 0, 'line');
    b.legendItem('#445566', 'Y', 1, 'line');
    expect(analyzeChart(b.build())).toMatchObject({
      status: 'limited',
      reason: 'legend-ambiguous',
    });
  });

  it('a legend that lists only some series is ambiguous (partial)', () => {
    const b = lineChart(['#d62728', '#2ca02c', '#1f77b4'], { legend: false });
    b.legendItem('#d62728', 'A', 0, 'line');
    b.legendItem('#2ca02c', 'B', 1, 'line');
    expect(analyzeChart(b.build())).toMatchObject({
      status: 'limited',
      reason: 'legend-ambiguous',
    });
  });

  it('ticks (one neutral color, one dash) are not a legend', () => {
    const chart = chartOf(lineChart(CONFUSABLE, { legend: false }));
    expect(chart.legend.status).toBe('none');
  });

  it('a legend entry without a series (a hidden series) does not block the others', () => {
    const b = lineChart(['#d62728', '#2ca02c'], { legend: false });
    b.legendItem('#d62728', 'A', 0, 'line');
    b.legendItem('#2ca02c', 'B', 1, 'line');
    b.legendItem('#9467bd', 'C (off)', 2, 'line');
    const chart = chartOf(b);
    expect(chart.legend.status).toBe('mapped');
  });

  it('a class token that names one series and one swatch is evidence; a shared one is not', () => {
    const b = new FactsBuilder();
    b.hints = ['chart'];
    b.axes();
    b.line('#d62728', { tokens: ['line', 'series-a'] });
    b.line('#d62728', {
      tokens: ['line', 'series-b'],
      dash: '4 2',
      box: { x: 50, y: 60, w: 320, h: 100 },
    });
    b.legendItem('#d62728', 'A', 0, 'line', { tokens: ['swatch', 'series-a'] });
    b.legendItem('#d62728', 'B', 1, 'line', { tokens: ['swatch', 'series-b'], dash: '4 2' });
    const chart = chartOf(b);
    if (chart.legend.status !== 'mapped') throw new Error('expected mapped');
    expect(chart.legend.pairs.map((p) => [p.item.label, p.evidence])).toEqual([
      ['A', 'token'],
      ['B', 'token'],
    ]);
  });
});

describe('pairwise analysis (M2 simulation, series against series)', () => {
  it('red/green collapse for a deuteranope, green/orange for a protanope, neither for a tritanope', () => {
    const chart = chartOf(lineChart(CONFUSABLE, { legend: false }));
    const deut = analyzePairs(chart.series, 'deuteranopia');
    expect(deut.pairs.filter((p) => p.problematic).map((p) => [p.a, p.b])).toEqual([
      ['c:#d62728', 'c:#2ca02c'],
    ]);
    expect(
      analyzePairs(chart.series, 'protanopia')
        .pairs.filter((p) => p.problematic)
        .map((p) => [p.a, p.b]),
    ).toEqual([['c:#2ca02c', 'c:#ff7f0e']]);
    expect(analyzePairs(chart.series, 'tritanopia').pairs.some((p) => p.problematic)).toBe(false);
    expect(deut.modelConfidence).toBe('SUPPORTED_MODEL');
    for (const pair of deut.pairs)
      expect(pair.simulatedDistance).toBeLessThan(pair.originalDistance);
  });

  it('a palette made for everybody has no problematic pair', () => {
    const chart = chartOf(lineChart(DISTINCT, { legend: false }));
    for (const profile of ['protanopia', 'deuteranopia', 'tritanopia'] as const) {
      expect(analyzePairs(chart.series, profile).pairs.every((p) => !p.problematic)).toBe(true);
    }
  });

  it('M2 status passes through unchanged for anomalous profiles', () => {
    const chart = chartOf(lineChart(CONFUSABLE, { legend: false }));
    expect(analyzePairs(chart.series, 'deuteranomaly').modelConfidence).toBe('MODEL_ASSUMPTION');
    expect(analyzePairs(chart.series, 'tritanomaly').modelConfidence).toBe('APPROXIMATION');
    expect(analyzePairs(chart.series, 'protanopia').model).toBe('brettel1997');
  });
});

describe('adaptation plan: redundancy before recoloring', () => {
  it('only the series in a conflict are written: red and green are, orange is not', () => {
    const plan = planOf(chartOf(lineChart(CONFUSABLE)));
    expect(plan.series.map((s) => s.changed)).toEqual([false, true, false]);
    expect(plan.unresolvedPairs).toBe(0);
  });

  it('confusable lines: the first keeps what it was; the others get distinct dash/marker; colors are never changed', () => {
    const plan = planOf(chartOf(lineChart(REDS)));
    expect(plan.series[0]!.changed).toBe(false);
    expect(plan.series.slice(1).every((s) => s.changed)).toBe(true);
    expect(new Set(encodings(plan.series)).size).toBe(3);
    expect(plan.series.every((s) => s.colorAdjustment === null)).toBe(true);
    expect(plan.unresolvedPairs).toBe(0);
  });

  it('every problematic pair ends up distinct by a non-color channel', () => {
    const plan = planOf(chartOf(lineChart(REDS)));
    expect(plan.pairs.filter((p) => p.problematic)).toHaveLength(3);
    for (const pair of plan.pairs.filter((p) => p.problematic))
      expect(pair.distinctWithoutColor).toBe(true);
  });

  it('an already-distinguishable palette is left alone', () => {
    const plan = planOf(chartOf(lineChart(DISTINCT)), 'deuteranopia');
    expect(plan.adapts).toBe(false);
  });

  it('charts already told apart by dashes are not over-adapted', () => {
    const plan = planOf(chartOf(lineChart(CONFUSABLE, { dashes: [null, '6 3', '2 2'] })));
    expect(plan.adapts).toBe(false);
    expect(plan.pairs.filter((p) => p.problematic).every((p) => p.alreadyDistinct)).toBe(true);
  });

  it('series with a direct label each are already told apart', () => {
    const b = lineChart(CONFUSABLE, { legend: false });
    CONFUSABLE.forEach((color, i) =>
      b.text(`S${i}`, { x: 320, y: 40 + i * 20 + 10, w: 20, h: 10 }, { color, parent: 2 }),
    );
    const plan = planOf(chartOf(b));
    expect(plan.adapts).toBe(false);
  });

  it('normal vision has no simulation, so a palette is not "confusable"', () => {
    const result = planChart(chartOf(lineChart(DISTINCT)), { profile: 'normal' });
    expect(result.status === 'planned' && result.plan.adapts).toBe(false);
  });

  it('is deterministic: the same chart gives the same plan', () => {
    const a = planOf(chartOf(lineChart(CONFUSABLE)));
    const b = planOf(chartOf(lineChart(CONFUSABLE)));
    expect(encodings(a.series)).toEqual(encodings(b.series));
  });

  it('bars get patterns, scatter series get marker shapes, slices get patterns', () => {
    const bars = planOf(chartOf(barChart(['#d62728', '#2ca02c'])));
    expect(bars.series[1]!.encoding.pattern).not.toBeNull();
    expect(bars.series[1]!.encoding.marker).toBeNull();
    const scatter = planOf(chartOf(scatterChart(['#d62728', '#2ca02c'])));
    expect(scatter.series[1]!.encoding.marker).not.toBeNull();
    expect(scatter.series[1]!.encoding.dash).toBe('solid');
    const pie = planOf(chartOf(pieChart(REDS)));
    expect(pie.series.filter((s) => s.encoding.pattern).length).toBeGreaterThanOrEqual(1);
    expect(new Set(pie.series.map((s) => s.encoding.pattern)).size).toBe(3);
  });

  it('legend items are carried with the plan, so the legend can show the same encoding', () => {
    const plan = planOf(chartOf(lineChart(REDS)));
    expect(plan.legendMapped).toBe(true);
    expect(plan.series.every((s) => s.legendItem !== null)).toBe(true);
    expect(plan.series.map((s) => s.legendItem!.label)).toEqual([
      'Series 1',
      'Series 2',
      'Series 3',
    ]);
  });
});

describe('collisions and capacity', () => {
  it('no two series of a conflict share an encoding, up to the limits', () => {
    // Six near-identical reds: all pairwise problematic.
    const colors = ['#d62728', '#d82a29', '#da2c2b', '#dc2e2d', '#de302f', '#e03231'];
    const plan = planOf(chartOf(lineChart(colors, { legend: false })));
    expect(new Set(encodings(plan.series)).size).toBe(6);
    expect(plan.unresolvedPairs).toBe(0);
  });

  it('dense lines take dash styles only (no per-vertex markers)', () => {
    const b = new FactsBuilder();
    b.hints = ['chart'];
    b.axes();
    ['#d62728', '#d82a29', '#da2c2b', '#dc2e2d', '#de302f', '#e03231'].forEach((color) =>
      b.line(color, { vertices: 400 }),
    );
    const chart = chartOf(b);
    expect(encodingCatalog(chart.series[0]!).every((e) => e.marker === null)).toBe(true);
    const result = planChart(chart, { profile: 'deuteranopia' });
    // Five dash styles for six conflicting dense series: honestly limited, not pretended.
    expect(result).toEqual({ status: 'limited', reason: 'encoding-exhausted' });
  });

  it('more conflicting bar series than patterns: limited', () => {
    // four reds and four greens: red/red, green/green and (for a deuteranope) red/green all conflict
    const colors = [
      '#d62728',
      '#d82a29',
      '#da2c2b',
      '#dc2e2d',
      '#2ca02c',
      '#2ea22e',
      '#30a430',
      '#32a632',
    ];
    const analysis = analyzeChart(barChart(colors, { legend: false }).build());
    if (analysis.status !== 'supported') throw new Error(analysis.status);
    expect(planChart(analysis.chart, { profile: 'deuteranopia' })).toEqual({
      status: 'limited',
      reason: 'encoding-exhausted',
    });
  });

  it('the marker budget bounds the work: too many marker instances is limited', () => {
    const b = new FactsBuilder();
    b.hints = ['chart'];
    b.axes();
    // Three paths per series: markers on the last three series would be 3 x 3 x 60 = 540 instances.
    [
      '#d62728',
      '#d82a29',
      '#da2c2b',
      '#dc2e2d',
      '#de302f',
      '#e03231',
      '#e23433',
      '#e43635',
    ].forEach((color) => {
      for (let n = 0; n < 3; n += 1)
        b.line(color, { vertices: 60, box: { x: 50, y: 40 + n * 5, w: 320, h: 100 } });
    });
    const analysis = analyzeChart(b.build());
    if (analysis.status !== 'supported') throw new Error(analysis.status);
    const result = planChart(analysis.chart, { profile: 'deuteranopia' });
    expect(result.status === 'limited' && result.reason).toBe('too-large');
  });
});

describe('identity stability (dynamic series)', () => {
  const colors3 = ['#d62728', '#d82a29', '#da2c2b'];
  const colors4 = [...colors3, '#dc2e2d'];

  it('appending a series keeps the others and gives the new one a free encoding', () => {
    const before = planOf(chartOf(lineChart(colors3, { legend: false })));
    const prior = new Map(before.series.map((s) => [s.seriesId, s.encoding]));
    const after = planOf(chartOf(lineChart(colors4, { legend: false })), 'deuteranopia', prior);
    expect(encodings(after.series).slice(0, 3)).toEqual(encodings(before.series));
    expect(new Set(encodings(after.series)).size).toBe(4);
  });

  it('removing a series from the middle leaves the others as they were', () => {
    const before = planOf(chartOf(lineChart(colors4, { legend: false })));
    const prior = new Map(before.series.map((s) => [s.seriesId, s.encoding]));
    const without = [colors4[0]!, colors4[2]!, colors4[3]!];
    const after = planOf(chartOf(lineChart(without, { legend: false })), 'deuteranopia', prior);
    expect(after.series.map((s) => encodingKey(s.encoding))).toEqual(
      [before.series[0]!, before.series[2]!, before.series[3]!].map((s) => encodingKey(s.encoding)),
    );
  });

  it('a remembered encoding that now collides is replaced, never duplicated', () => {
    const chart = chartOf(lineChart(colors3, { legend: false }));
    const same: Encoding = { dash: 'dashed', marker: null, pattern: null };
    const prior = new Map(chart.series.map((s) => [s.id, same]));
    const plan = planOf(chart, 'deuteranopia', prior);
    expect(new Set(encodings(plan.series)).size).toBe(3);
  });
});

describe('what a series remembers only matters while it needs it', () => {
  it('a series that is no longer in any conflict goes back to what the page drew', () => {
    const redGreen = chartOf(lineChart(['#d62728', '#2ca02c'], { legend: false }));
    const first = planOf(redGreen);
    expect(first.series[1]!.changed).toBe(true);
    const prior = new Map(first.series.map((s) => [s.seriesId, s.encoding]));
    // the same series seen by a tritanope (no conflict), or after the red series was recolored
    expect(planOf(redGreen, 'tritanopia', prior).adapts).toBe(false);
    const recolored = chartOf(lineChart(['#0072b2', '#2ca02c'], { legend: false }));
    const green = [...prior].filter(([id]) => id === 'c:#2ca02c');
    expect(planOf(recolored, 'deuteranopia', new Map(green)).adapts).toBe(false);
  });

  it('scatter shapes: the catalog runs diamond, triangle, plus, cross, ring, and then is honest', () => {
    const colors = ['#d62728', '#d82a29', '#da2c2b', '#dc2e2d', '#de302f', '#e03231', '#e23433'];
    const analysis = analyzeChart(scatterChart(colors, { legend: false }).build());
    if (analysis.status !== 'supported') throw new Error(analysis.status);
    // seven mutually conflicting series, six encodings (as drawn + five shapes): one too many
    expect(planChart(analysis.chart, { profile: 'deuteranopia' })).toEqual({
      status: 'limited',
      reason: 'encoding-exhausted',
    });
    const six = analyzeChart(scatterChart(colors.slice(0, 6), { legend: false }).build());
    if (six.status !== 'supported') throw new Error(six.status);
    const plan = planOf(six.chart);
    expect(plan.series.map((s) => s.encoding.marker)).toEqual([
      null,
      'diamond',
      'triangle',
      'plus',
      'cross',
      'ring',
    ]);
    // shapes cost no nodes: points are styled, never overlaid
    expect(plan.budget.overlays).toBe(0);
  });
});

describe('semantic color meaning is preserved', () => {
  it('colors, marks and order are never touched; only encodings are added', () => {
    const chart = chartOf(lineChart(CONFUSABLE));
    const plan = planOf(chart);
    expect(plan.series.map((s) => s.color)).toEqual(chart.series.map((s) => s.color));
    expect(plan.series.map((s) => s.marks)).toEqual(chart.series.map((s) => s.marks));
    expect(plan.series.map((s) => s.seriesId)).toEqual(chart.series.map((s) => s.id));
  });

  it('a pattern fill the page already uses is an existing channel, not overwritten', () => {
    const b = new FactsBuilder();
    b.hints = ['chart'];
    b.axes();
    for (let c = 0; c < 3; c += 1) {
      b.mark({
        tag: 'rect',
        fill: { kind: 'pattern', color: null, ref: 'url(#hatch1)', opacity: 1 },
        closed: true,
        box: { x: 60 + c * 100, y: 200 - c * 20, w: 20, h: 60 + c * 20 },
        stroke: paint('#d62728'),
        strokeWidth: 1,
      });
      b.mark({
        tag: 'rect',
        fill: { kind: 'pattern', color: null, ref: 'url(#hatch2)', opacity: 1 },
        closed: true,
        box: { x: 82 + c * 100, y: 190 - c * 15, w: 20, h: 70 + c * 15 },
        stroke: paint('#2ca02c'),
        strokeWidth: 1,
      });
    }
    const analysis = analyzeChart(b.build());
    if (analysis.status !== 'supported') throw new Error(analysis.status);
    const plan = planOf(analysis.chart);
    expect(plan.adapts).toBe(false);
  });
});
