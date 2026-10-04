import { describe, expect, it } from 'vitest';
import { analyzeChart, ownsChart } from '@core/charts';
import {
  CONFUSABLE,
  DISTINCT,
  FactsBuilder,
  barChart,
  lineChart,
  paint,
  pieChart,
  scatterChart,
  server,
} from './builders';

function supportedChart(builder: FactsBuilder) {
  const analysis = analyzeChart(builder.build());
  if (analysis.status !== 'supported') {
    throw new Error(
      `expected supported, got ${JSON.stringify(analysis, (_k: string, v: unknown): unknown => (v instanceof Set ? [...v] : v))}`,
    );
  }
  return analysis.chart;
}

describe('chart classification: supported types', () => {
  it('a 3-series line chart with axes and a legend is a HIGH-confidence line chart', () => {
    const chart = supportedChart(lineChart(CONFUSABLE));
    expect(chart.type).toBe('line');
    expect(chart.confidence).toBe('HIGH');
    expect(chart.series).toHaveLength(3);
    expect(chart.legend.status).toBe('mapped');
  });

  it('a line chart without a legend is still supported (nothing to synchronize)', () => {
    const chart = supportedChart(lineChart(CONFUSABLE, { legend: false }));
    expect(chart.legend.status).toBe('none');
  });

  it('a grouped bar chart is a bar chart; its legend swatches are not bars', () => {
    const chart = supportedChart(barChart(['#d62728', '#2ca02c']));
    expect(chart.type).toBe('bar');
    expect(chart.series).toHaveLength(2);
    expect(chart.series.every((s) => s.kind === 'bar')).toBe(true);
  });

  it('a scatter plot groups its points by color', () => {
    const chart = supportedChart(scatterChart(['#d62728', '#2ca02c', '#1f77b4']));
    expect(chart.type).toBe('scatter');
    expect(chart.series.map((s) => s.marks.length)).toEqual([8, 8, 8]);
  });

  it('a pie with a complete legend is a pie; with ring segments it is a donut', () => {
    expect(supportedChart(pieChart(['#d62728', '#2ca02c', '#1f77b4'])).type).toBe('pie');
    expect(supportedChart(pieChart(['#d62728', '#2ca02c', '#1f77b4'], { donut: true })).type).toBe(
      'donut',
    );
  });

  it('series are stable ids: the author key when written, the paint otherwise', () => {
    expect(supportedChart(lineChart(CONFUSABLE)).series.map((s) => s.id)).toEqual([
      'c:#d62728',
      'c:#2ca02c',
      'c:#ff7f0e',
    ]);
    expect(supportedChart(lineChart(CONFUSABLE, { keys: true })).series.map((s) => s.id)).toEqual([
      'k:s0',
      'k:s1',
      'k:s2',
    ]);
  });

  it('two lines of one color but different dashes are two series', () => {
    const chart = supportedChart(
      lineChart(['#d62728', '#d62728'], { dashes: [null, '4 2'], legend: false }),
    );
    expect(chart.series).toHaveLength(2);
  });
});

describe('chart classification: policy for types M7 does not adapt', () => {
  it('a heatmap is detected and left alone: color there is magnitude, not identity', () => {
    const b = new FactsBuilder();
    b.hints = ['heatmap chart'];
    b.axes();
    for (let r = 0; r < 4; r += 1) {
      for (let c = 0; c < 5; c += 1) {
        b.rect(`#${(40 + r * 30).toString(16)}${(60 + c * 30).toString(16)}c0`, {
          x: 50 + c * 30,
          y: 40 + r * 30,
          w: 28,
          h: 28,
        });
      }
    }
    const analysis = analyzeChart(b.build());
    expect(analysis).toMatchObject({
      status: 'unsupported',
      reason: 'heatmap-sequential',
      type: 'heatmap',
    });
    expect(ownsChart(analysis)).toBe(true);
  });

  it('stacked bars are classified and not adapted', () => {
    const b = new FactsBuilder();
    b.hints = ['chart'];
    b.axes();
    for (let c = 0; c < 4; c += 1) {
      b.rect('#d62728', { x: 60 + c * 60, y: 200 - c * 10, w: 40, h: 60 + c * 10 });
      b.rect('#2ca02c', { x: 60 + c * 60, y: 140 - c * 10, w: 40, h: 60 });
    }
    expect(analyzeChart(b.build())).toMatchObject({
      status: 'unsupported',
      reason: 'type-not-adapted',
      type: 'stacked-bar',
    });
  });

  it('a gradient on a data mark means it may be a sequential encoding: unsupported', () => {
    const b = lineChart(CONFUSABLE, { legend: false });
    b.marks[b.marks.length - 1] = {
      ...b.marks[b.marks.length - 1]!,
      stroke: server('gradient', 'url(#g)'),
    };
    expect(analyzeChart(b.build())).toMatchObject({
      status: 'unsupported',
      reason: 'paint-gradient',
    });
  });

  it.each(['animated', 'filter', 'mask', 'foreign-object', 'embedded-image'] as const)(
    'a chart with %s is unsupported',
    (blocker) => {
      const b = lineChart(CONFUSABLE);
      b.blockers = [blocker];
      expect(analyzeChart(b.build())).toMatchObject({ status: 'unsupported', reason: blocker });
    },
  );

  it('a chart over the structural budget is unsupported, never half-read', () => {
    const b = lineChart(CONFUSABLE);
    b.overBudget = true;
    expect(analyzeChart(b.build())).toMatchObject({ status: 'unsupported', reason: 'too-large' });
  });

  it('more series than M7 will distinguish is limited', () => {
    const colors = Array.from(
      { length: 13 },
      (_, i) => `#${(40 + i * 15).toString(16).padStart(2, '0')}60c0`,
    );
    const analysis = analyzeChart(lineChart(colors, { legend: false }).build());
    expect(analysis).toMatchObject({ status: 'limited', reason: 'too-many-series' });
  });

  it('an HTML legend beside the chart cannot be synchronized: limited', () => {
    const b = lineChart(CONFUSABLE, { legend: false });
    b.blockers = ['html-legend'];
    expect(analyzeChart(b.build())).toMatchObject({ status: 'limited', reason: 'html-legend' });
  });

  it('a pie without a legend is not claimed: arcs in a circle are a logo or a gauge as often as a pie', () => {
    const analysis = analyzeChart(
      pieChart(['#d62728', '#2ca02c', '#1f77b4'], { legend: false }).build(),
    );
    expect(analysis).toMatchObject({ status: 'unsupported', reason: 'low-confidence' });
    expect(ownsChart(analysis)).toBe(false);
  });

  it('a chart word in a class is a hint; generic UI words (top-bar, progress-bar) are not', () => {
    for (const word of ['top-bar', 'progress-bar', 'header-line', 'pie-menu']) {
      const b = pieChart(['#d62728', '#2ca02c', '#1f77b4'], { legend: false });
      b.hints = [word];
      expect(analyzeChart(b.build())).toMatchObject({ confidence: 'LOW' });
    }
    const b = pieChart(['#d62728', '#2ca02c', '#1f77b4'], { legend: false });
    b.hints = ['donut-chart'];
    expect(analyzeChart(b.build())).toMatchObject({ confidence: 'MEDIUM' });
  });
});

describe('chart classification: sequential palettes and orphan legend swatches', () => {
  it('bars in a single-hue ramp are refused: color there is magnitude, a pattern would suggest categories', () => {
    const blues = ['#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#3182bd', '#08519c'];
    expect(analyzeChart(barChart(blues).build())).toMatchObject({
      status: 'limited',
      reason: 'sequential-palette',
    });
    const grays = ['#eeeeee', '#cccccc', '#999999', '#666666', '#333333'];
    expect(analyzeChart(barChart(grays).build())).toMatchObject({
      status: 'limited',
      reason: 'sequential-palette',
    });
  });

  it('a categorical palette, or fewer than four series, is not a ramp', () => {
    expect(
      analyzeChart(barChart(['#d62728', '#2ca02c', '#1f77b4', '#ff7f0e']).build()).status,
    ).toBe('supported');
    expect(analyzeChart(barChart(['#9ecae1', '#6baed6', '#3182bd']).build()).status).toBe(
      'supported',
    );
  });

  it('a legend whose swatches are not paired with their text is not guessed at: the chart is refused', () => {
    const b = lineChart(CONFUSABLE, { legend: false });
    // swatches (colored line samples) with their texts far apart in the tree
    CONFUSABLE.forEach((color, i) =>
      b.mark({
        tag: 'line',
        stroke: paint(color),
        strokeWidth: 2,
        vertices: 2,
        rectilinear: true,
        box: { x: 300, y: 15 + i * 16, w: 20, h: 0 },
        parent: 40 + i,
      }),
    );
    CONFUSABLE.forEach((_c, i) =>
      b.text(`Series ${i}`, { x: 325, y: 10 + i * 16, w: 50, h: 10 }, { parent: 60 }),
    );
    expect(analyzeChart(b.build())).toMatchObject({
      status: 'limited',
      reason: 'legend-ambiguous',
    });
  });

  it('a Highcharts-style legend (line sample, marker, text in one group) leaves its line sample unclaimed: refused', () => {
    const b = lineChart(CONFUSABLE, { legend: false });
    CONFUSABLE.forEach((color, i) => {
      const group = 80 + i;
      b.mark({
        tag: 'path',
        stroke: paint(color),
        strokeWidth: 2,
        vertices: 2,
        box: { x: 300, y: 15 + i * 16, w: 16, h: 0 },
        parent: group,
        grandparent: 79,
      });
      b.mark({
        tag: 'circle',
        fill: paint(color),
        closed: true,
        box: { x: 304, y: 11 + i * 16, w: 8, h: 8 },
        parent: group,
        grandparent: 79,
      });
      b.text(`Series ${i}`, { x: 322, y: 10 + i * 16, w: 50, h: 10 }, { parent: group });
    });
    expect(analyzeChart(b.build())).toMatchObject({
      status: 'limited',
      reason: 'legend-ambiguous',
    });
  });

  it('a short reference line in a series color is the same kind of thing: not adapted', () => {
    const b = lineChart(CONFUSABLE, { legend: false });
    b.mark({
      tag: 'line',
      stroke: paint(CONFUSABLE[0]!),
      strokeWidth: 1,
      vertices: 2,
      rectilinear: true,
      box: { x: 100, y: 200, w: 30, h: 0 },
      parent: 70,
    });
    expect(analyzeChart(b.build()).status).toBe('limited');
  });
});

describe('chart classification: confidence', () => {
  it('without axis evidence or a hint a chart-shaped set of lines is not HIGH', () => {
    const b = new FactsBuilder();
    for (const color of CONFUSABLE) b.line(color);
    const analysis = analyzeChart(b.build());
    expect(analysis.status).toBe('unsupported');
    expect(analysis).toMatchObject({ reason: 'low-confidence' });
    expect(ownsChart(analysis)).toBe(false);
  });

  it('a hint alone is not enough either', () => {
    const b = new FactsBuilder();
    b.hints = ['my-chart'];
    for (const color of CONFUSABLE) b.line(color);
    expect(analyzeChart(b.build())).toMatchObject({
      status: 'unsupported',
      reason: 'low-confidence',
      confidence: 'MEDIUM',
    });
  });
});

describe('chart classification: things that are not charts', () => {
  const colors = ['#e63946', '#f1faee', '#a8dadc', '#457b9d', '#1d3557', '#ffb703', '#fb8500'];

  function expectNotAdapted(b: FactsBuilder): void {
    const analysis = analyzeChart(b.build());
    expect(['supported', 'limited']).not.toContain(analysis.status);
    expect(ownsChart(analysis)).toBe(false);
  }

  it('an illustration: many closed paths of many fills, no axes', () => {
    const b = new FactsBuilder();
    colors.forEach((color, i) => {
      for (let n = 0; n < 5; n += 1) {
        b.mark({
          tag: 'path',
          fill: paint(color),
          closed: true,
          vertices: 9,
          arcCount: n % 2,
          box: { x: 10 + i * 40, y: 10 + n * 30, w: 60, h: 40 },
        });
      }
    });
    expectNotAdapted(b);
  });

  it('a logo: a ring of colored arcs without a legend or a hint', () => {
    const b = new FactsBuilder();
    for (const color of colors.slice(0, 3)) {
      b.mark({
        tag: 'path',
        fill: paint(color),
        closed: true,
        vertices: 4,
        arcCount: 2,
        box: { x: 100, y: 100, w: 100, h: 100 },
      });
    }
    expectNotAdapted(b);
  });

  it('a map-like SVG: dozens of regions in different fills, a few labels', () => {
    const b = new FactsBuilder();
    for (let i = 0; i < 40; i += 1) {
      b.mark({
        tag: 'path',
        fill: paint(colors[i % colors.length]!),
        stroke: paint('#ffffff'),
        closed: true,
        vertices: 14,
        box: { x: (i % 8) * 45, y: Math.floor(i / 8) * 55, w: 50, h: 60 },
      });
    }
    b.text('North', { x: 20, y: 20, w: 30, h: 10 });
    b.text('South', { x: 220, y: 220, w: 30, h: 10 });
    expectNotAdapted(b);
  });

  it('a flowchart: boxes, connectors and labels', () => {
    const b = new FactsBuilder();
    for (let i = 0; i < 6; i += 1) {
      b.rect(colors[i]!, {
        x: 20 + i * 55,
        y: 30 + (i % 3) * 70,
        w: 40 + (i % 2) * 10,
        h: 30 + (i % 3) * 8,
      });
      b.text(`Step ${i}`, { x: 22 + i * 55, y: 40 + (i % 3) * 70, w: 30, h: 10 });
    }
    for (let i = 0; i < 5; i += 1) {
      b.mark({
        tag: 'path',
        stroke: paint('#666666'),
        vertices: 3,
        rectilinear: true,
        box: { x: 60 + i * 55, y: 45, w: 15, h: 40 },
      });
    }
    expectNotAdapted(b);
  });

  it('a complex icon: a few shapes in one paint', () => {
    const b = new FactsBuilder();
    for (let i = 0; i < 6; i += 1)
      b.mark({
        tag: 'path',
        fill: paint('#333333'),
        closed: true,
        vertices: 6,
        box: { x: i * 3, y: i * 3, w: 12, h: 12 },
      });
    expectNotAdapted(b);
  });

  it('a chart that is not laid out (no mark has a box) is unknown, whatever its markup says', () => {
    const b = lineChart(CONFUSABLE);
    const facts = b.build();
    const unrendered = { ...facts, marks: facts.marks.map((mark) => ({ ...mark, box: null })) };
    expect(analyzeChart(unrendered)).toEqual({ status: 'unknown' });
  });

  it('nothing at all is unknown', () => {
    expect(analyzeChart(new FactsBuilder().build())).toEqual({ status: 'unknown' });
  });

  it('a chart whose marks the page filtered away leaves no half-claim', () => {
    const b = lineChart(DISTINCT);
    b.blockers = ['filter'];
    const analysis = analyzeChart(b.build());
    expect(analysis.status).toBe('unsupported');
  });
});
