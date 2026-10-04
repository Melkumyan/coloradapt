import { expect } from 'vitest';
import {
  barChartSvg,
  heatmapSvg,
  lineChartSvg,
  pieChartSvg,
  scatterChartSvg,
} from '../features/charts/engine';
import {
  HTML_LEGENDS,
  avatarRingSvg,
  barDirectLabels,
  calendarSvg,
  countElements,
  countShapes,
  donutChartSvg,
  donutIconSvg,
  flowSvg,
  gaugeSvg,
  hintedLogoSvg,
  infographicSvg,
  interactiveLegend,
  kpiIconSvg,
  networkSvg,
  orgChartSvg,
  padElements,
  padShapes,
  progressRingSvg,
  sliceLabels,
  spinnerSvg,
  sparklineSvg,
  timelineSvg,
  withExtraPaths,
  withVertices,
  withWidths,
} from '../features/charts/fixtures-r1';
import {
  CONFUSABLE,
  OKABE,
  REDS,
  RED_GREEN,
  SIX,
  type Scenario,
  type ScenarioContext,
  withMarkers,
} from './chart-scenarios';

/**
 * The M7.R1 scenarios (docs/CHARTS.md, "Benchmark"): supported charts of more kinds and profiles,
 * charts already told apart, external-legend variants, ambiguity, curated non-chart traps, ordered
 * palettes, pie/donut traps, structural boundaries, responsive and dynamic charts, interactive
 * legends and canvases. Every verdict is structural; real-browser confirmation is in e2e/chart-*.
 */
const card = (svg: string, around = '') =>
  `<div class="card">${svg}<div class="after">${around}</div></div>`;

const marks = (ctx: ScenarioContext) =>
  ctx.svg().querySelectorAll('[data-coloradapt-chart-mark]').length;
const nodes = () => document.querySelectorAll('[data-coloradapt-chart-node]').length;
const defsHtml = (ctx: ScenarioContext) => ctx.svg().querySelector('defs')?.innerHTML ?? '';
const sheet = () => document.getElementById('coloradapt-stylesheet')?.textContent ?? '';
const chartRules = () =>
  sheet()
    .split('\n')
    .filter((line) => line.includes('data-coloradapt-chart'))
    .map((line) => line.replace(/c\d+\./g, 'c.'))
    .join('\n');

/** The identity (dash + marker) the browser stand-in reports for every series line. */
const lineIdentities = (ctx: ScenarioContext) =>
  [...ctx.svg().querySelectorAll('path.line')].map((p) => {
    const style = ctx.env.getStyle(p);
    return `${style.getPropertyValue('stroke-dasharray')}|${style
      .getPropertyValue('marker-mid')
      .replace(/coloradapt-c\d+-/, 'coloradapt-')}`;
  });

const hiddenSvg = (svg: Element) => {
  const boxes = [...svg.querySelectorAll('[data-box]')].map(
    (el) => [el, el.getAttribute('data-box')!] as const,
  );
  for (const [el] of boxes) el.removeAttribute('data-box');
  return () => {
    for (const [el, value] of boxes) el.setAttribute('data-box', value);
  };
};

// ------------------------------------------------------------------------ the list

export const R1_SCENARIOS: readonly Scenario[] = [
  // ------------------------------------------------------- supported (kinds and profiles)
  {
    name: 'bars, three reds, protanopia',
    category: 'supported',
    profile: 'protanopia',
    markup: barChartSvg(REDS),
    expect: 'adapted',
  },
  {
    name: 'bars, red/green/orange, deuteranopia',
    category: 'supported',
    profile: 'deuteranopia',
    markup: barChartSvg(CONFUSABLE),
    expect: 'adapted',
  },
  {
    name: 'scatter, red/green/orange, deuteranopia',
    category: 'supported',
    profile: 'deuteranopia',
    markup: scatterChartSvg(CONFUSABLE),
    expect: 'adapted',
  },
  {
    name: 'scatter, three reds, tritanopia',
    category: 'supported',
    profile: 'tritanopia',
    markup: scatterChartSvg(REDS),
    expect: 'adapted',
  },
  {
    name: 'donut, three reds, protanopia, complete legend',
    category: 'supported',
    profile: 'protanopia',
    markup: donutChartSvg(REDS),
    expect: 'adapted',
  },
  {
    name: 'line, five reds (dash styles only)',
    category: 'supported',
    profile: 'deuteranopia',
    markup: lineChartSvg(SIX.slice(0, 5)),
    expect: 'adapted',
  },
  {
    name: 'line, keyed series with box legend swatches',
    category: 'supported',
    profile: 'deuteranopia',
    markup: lineChartSvg(RED_GREEN, { keys: true, legendKind: 'box' }),
    expect: 'adapted',
  },
  {
    name: 'line, labelled series, protanopia',
    category: 'supported',
    profile: 'protanopia',
    markup: lineChartSvg(['#2ca02c', '#ff7f0e'], { labels: ['Revenue', 'Cost'], keys: true }),
    expect: 'adapted',
  },
  {
    name: 'bars, three reds, deuteranomaly (MODEL_ASSUMPTION)',
    category: 'supported',
    profile: 'deuteranomaly',
    markup: barChartSvg(REDS),
    expect: 'adapted',
  },
  {
    name: 'scatter, three reds, protanomaly (MODEL_ASSUMPTION)',
    category: 'supported',
    profile: 'protanomaly',
    markup: scatterChartSvg(REDS),
    expect: 'adapted',
  },
  {
    name: 'line, six reds, tritanopia (markers)',
    category: 'supported',
    profile: 'tritanopia',
    markup: lineChartSvg(SIX),
    expect: 'adapted',
  },
  {
    name: 'chart in a card with unrelated prose around it',
    category: 'supported',
    profile: 'deuteranopia',
    markup: card(
      lineChartSvg(RED_GREEN, { legend: false }),
      '<p>Revenue grew 12% year over year, driven by the red and green regions.</p>',
    ),
    expect: 'adapted',
  },
  // --------------------------------------------------- already distinguishable
  {
    name: 'line, stroke widths differ by more than 2x',
    category: 'already distinguishable',
    profile: 'deuteranopia',
    markup: withWidths(lineChartSvg(REDS), [1, 3, 6]),
    expect: 'untouched',
  },
  {
    name: 'line, dashes and markers both already drawn',
    category: 'already distinguishable',
    profile: 'deuteranopia',
    markup: withMarkers(lineChartSvg(REDS, { dashes: [null, '6 3', '2 2'], legend: false })),
    expect: 'untouched',
  },
  {
    name: 'bars, direct labels in the series colors',
    category: 'already distinguishable',
    profile: 'deuteranopia',
    markup: barDirectLabels(barChartSvg(RED_GREEN, { legend: false }), RED_GREEN),
    expect: 'untouched',
  },
  {
    name: 'scatter, Okabe-Ito (distinct for every profile)',
    category: 'already distinguishable',
    profile: 'protanopia',
    markup: scatterChartSvg(OKABE.slice(0, 3)),
    expect: 'untouched',
  },
  {
    name: 'pie, a label in the color of each slice: told apart by labels, nothing added',
    category: 'already distinguishable',
    profile: 'deuteranopia',
    markup: sliceLabels(pieChartSvg(REDS), REDS),
    expect: 'untouched',
  },
  {
    name: 'donut, Okabe-Ito',
    category: 'already distinguishable',
    profile: 'deuteranopia',
    markup: donutChartSvg(OKABE.slice(0, 3)),
    expect: 'untouched',
  },
  // ------------------------------------------- external (HTML) legends: refused whole
  ...HTML_LEGENDS.map(([name, legend]): Scenario => ({
    name: `HTML legend: ${name}`,
    category: 'external legend',
    profile: 'deuteranopia',
    markup: `<div class="card">${lineChartSvg(RED_GREEN, { legend: false })}<div class="side">${legend}</div></div>`,
    expect: 'refused',
    reason: 'html-legend',
  })),
  {
    name: 'HTML legend above the chart',
    category: 'external legend',
    profile: 'deuteranopia',
    markup: `<div class="card"><div class="chart-legend"><span>Red</span><span>Green</span></div>${lineChartSvg(RED_GREEN, { legend: false })}</div>`,
    expect: 'refused',
    reason: 'html-legend',
  },
  {
    name: 'HTML legend beside the chart (a second column)',
    category: 'external legend',
    profile: 'deuteranopia',
    markup: `<div class="row"><div class="col">${lineChartSvg(RED_GREEN, { legend: false })}</div><div class="col"><ul class="legend"><li>Red</li><li>Green</li></ul></div></div>`,
    expect: 'refused',
    reason: 'html-legend',
  },
  {
    name: 'bars with an HTML legend',
    category: 'external legend',
    profile: 'deuteranopia',
    markup: `<div class="card">${barChartSvg(RED_GREEN, { legend: false })}<ul class="chart-legend"><li>Red</li><li>Green</li></ul></div>`,
    expect: 'refused',
    reason: 'html-legend',
  },
  {
    name: 'no legend evidence next to the chart: a title and a key-metric tile',
    category: 'external legend',
    profile: 'deuteranopia',
    markup: card(
      lineChartSvg(RED_GREEN, { legend: false }),
      '<h3>Revenue</h3><div class="key-metric">12%</div>',
    ),
    expect: 'adapted',
  },
  // ----------------------------------------------------- ambiguity inside the SVG
  {
    name: 'five series, four legend items (partial mapping)',
    category: 'ambiguous legend',
    profile: 'deuteranopia',
    markup: lineChartSvg(SIX.slice(0, 5), { keys: true }).replace(
      /<g class="legend-item">(?:(?!<g class="legend-item">)[\s\S])*<\/g><\/g><\/svg>$/,
      '</g></svg>',
    ),
    expect: 'refused',
    reason: 'legend-ambiguous',
  },
  {
    name: 'legend keys that name other series (evidence disagrees)',
    category: 'ambiguous legend',
    profile: 'deuteranopia',
    markup: lineChartSvg(REDS, { keys: true }).replace(
      /<line([^>]*)data-series="s2"/,
      '<line$1data-series="other"',
    ),
    expect: 'refused',
    reason: 'legend-ambiguous',
  },
  {
    name: 'legend swatches whose text is not next to them (orphans)',
    category: 'ambiguous legend',
    profile: 'deuteranopia',
    markup: lineChartSvg(RED_GREEN).replace(
      /(<line class="swatch"[^>]*><\/line>)(<text[^>]*>[^<]*<\/text>)/g,
      '$2$1',
    ),
    expect: 'refused',
    reason: 'legend-ambiguous',
  },
  {
    name: 'two legend entries of one color',
    category: 'ambiguous legend',
    profile: 'deuteranopia',
    markup: lineChartSvg(['#d62728', '#d62728', '#2ca02c'], { dashes: [null, '4 2', null] }),
    expect: 'refused',
    reason: 'legend-ambiguous',
  },
  // ---------------------------------------------- curated non-charts (false-positive traps)
  ...(
    [
      ['org chart', orgChartSvg()],
      ['network diagram', networkSvg()],
      ['flow diagram', flowSvg()],
      ['timeline (a row of colored dots, dated)', timelineSvg()],
      ['calendar grid', calendarSvg()],
      ['progress ring', progressRingSvg()],
      ['donut-like decorative icon', donutIconSvg()],
      ['infographic (big shapes, percentages)', infographicSvg()],
      ['sparkline decoration', sparklineSvg()],
      ['dashboard KPI icon', kpiIconSvg()],
      ['logo with "chart" in its class', hintedLogoSvg()],
      ['spinner (gray arc ramp)', spinnerSvg()],
      ['avatar ring', avatarRingSvg()],
      ['gauge', gaugeSvg()],
    ] as const
  ).map(([name, markup]): Scenario => ({
    name,
    category: 'false positive: SVG',
    profile: 'deuteranopia',
    markup,
    expect: 'not-claimed',
  })),
  // -------------------------------------------------------- pie / donut traps
  {
    name: 'pie with three slices and two legend entries',
    category: 'pie/donut traps',
    profile: 'deuteranopia',
    markup: pieChartSvg(REDS).replace(
      /<g class="legend-item">(?:(?!<g class="legend-item">)[\s\S])*<\/g><\/g><\/svg>$/,
      '</g></svg>',
    ),
    expect: 'not-claimed',
  },
  {
    name: 'pie with duplicate slice colors',
    category: 'pie/donut traps',
    profile: 'deuteranopia',
    markup: pieChartSvg(['#d62728', '#d62728', '#2ca02c']),
    expect: 'not-claimed',
  },
  {
    name: 'donut without a legend',
    category: 'pie/donut traps',
    profile: 'deuteranopia',
    markup: donutChartSvg(REDS).replace(/<g class="legend">[\s\S]*<\/g><\/svg>$/, '</svg>'),
    expect: 'not-claimed',
  },
  {
    name: 'pie whose class says pie but has no legend',
    category: 'pie/donut traps',
    profile: 'deuteranopia',
    markup: pieChartSvg(REDS, { legend: false }).replace('class="pie"', 'class="pie-chart chart"'),
    expect: 'not-claimed',
  },
  // --------------------------------------------- sequential, diverging and ordered
  ...(
    [
      ['bars, light-to-dark gray ramp', ['#f0f0f0', '#bdbdbd', '#737373', '#252525']],
      ['bars, diverging red-white-blue', ['#b2182b', '#ef8a62', '#f7f7f7', '#67a9cf', '#2166ac']],
      [
        'bars, diverging with a pale-yellow midpoint',
        ['#a50026', '#f46d43', '#fee090', '#74add1', '#313695'],
      ],
      [
        'bars, temperature-like scale (viridis)',
        ['#440154', '#3b528b', '#21908d', '#5dc863', '#fde725'],
      ],
      ['bars, ordered yellow-orange-red', ['#ffffb2', '#fecc5c', '#fd8d3c', '#e31a1c']],
    ] as const
  ).map(([name, colors]): Scenario => ({
    name,
    category: 'sequential',
    profile: 'deuteranopia',
    markup: barChartSvg(colors),
    expect: 'refused',
    reason: 'sequential-palette',
  })),
  {
    name: 'pie, four-step single-hue ramp with a legend',
    category: 'sequential',
    profile: 'deuteranopia',
    markup: pieChartSvg(['#deebf7', '#9ecae1', '#4292c6', '#08519c']),
    expect: 'refused',
    reason: 'sequential-palette',
  },
  {
    name: 'heatmap (color is magnitude)',
    category: 'sequential',
    profile: 'tritanopia',
    markup: heatmapSvg(),
    expect: 'refused',
    reason: 'heatmap-sequential',
  },
  // ---------------------------------------------------------------- dense / boundaries
  {
    name: '12 series (the limit)',
    category: 'dense',
    profile: 'deuteranopia',
    markup: lineChartSvg(
      Array.from({ length: 12 }, (_, i) => `#${(0xd6 + i).toString(16)}2728`),
      { legend: false },
    ),
    expect: 'adapted',
  },
  {
    name: '500 marker instances (10 paths x 50 vertices)',
    category: 'dense',
    profile: 'deuteranopia',
    markup: withExtraPaths(lineChartSvg(SIX), SIX[5]!, 9, 50).replace(
      /(<path class="line line-5"[^>]*?) d="[^"]*"/,
      (_m, head: string) =>
        `${head} d="${Array.from({ length: 50 }, (_, k) => `${k === 0 ? 'M' : 'L'}${60 + k} ${100 + ((k * 7) % 40)}`).join(' ')}"`,
    ),
    expect: 'adapted',
  },
  {
    name: '510 marker instances (10 paths x 51 vertices)',
    category: 'dense',
    profile: 'deuteranopia',
    markup: withExtraPaths(lineChartSvg(SIX), SIX[5]!, 9, 51).replace(
      /(<path class="line line-5"[^>]*?) d="[^"]*"/,
      (_m, head: string) =>
        `${head} d="${Array.from({ length: 51 }, (_, k) => `${k === 0 ? 'M' : 'L'}${60 + k} ${100 + ((k * 7) % 40)}`).join(' ')}"`,
    ),
    expect: 'refused',
    reason: 'too-large',
  },
  {
    name: '2000 marks (the limit)',
    category: 'dense',
    profile: 'deuteranopia',
    markup: padShapes(lineChartSvg(REDS), 2000),
    expect: 'adapted',
  },
  {
    name: '2001 marks (over the limit)',
    category: 'dense',
    profile: 'deuteranopia',
    markup: padShapes(lineChartSvg(REDS), 2001),
    expect: 'refused',
    reason: 'too-large',
  },
  {
    name: '6000 descendants (the limit)',
    category: 'dense',
    profile: 'deuteranopia',
    markup: padElements(lineChartSvg(REDS), 6000),
    expect: 'adapted',
  },
  {
    name: '6001 descendants (over the limit)',
    category: 'dense',
    profile: 'deuteranopia',
    markup: padElements(lineChartSvg(REDS), 6001),
    expect: 'refused',
    reason: 'too-large',
  },
  {
    name: '6 reds, 100 vertices each: dashes alone run out',
    category: 'dense',
    profile: 'deuteranopia',
    markup: withVertices(lineChartSvg(SIX), 100),
    expect: 'refused',
    reason: 'encoding-exhausted',
  },
  // -------------------------------------------------------------------- responsive
  ...(
    [
      ['bars, wide -> narrow -> wide', barChartSvg(REDS)],
      ['line with markers, wide -> narrow -> wide', lineChartSvg(SIX)],
      ['scatter, wide -> narrow -> wide', scatterChartSvg(REDS)],
      ['pie, wide -> narrow -> wide', pieChartSvg(REDS)],
      ['donut, wide -> narrow -> wide', donutChartSvg(REDS)],
    ] as const
  ).map(([name, markup]): Scenario => ({
    name,
    category: 'responsive',
    profile: 'deuteranopia',
    markup,
    expect: 'adapted',
    steps(ctx) {
      const first = defsHtml(ctx);
      const firstRules = chartRules();
      ctx.env.scale = 0.5;
      ctx.updateAt(ctx.svg());
      const narrow = defsHtml(ctx);
      ctx.env.scale = 2;
      ctx.updateAt(ctx.svg());
      const wide = defsHtml(ctx);
      // the scale is in the artifacts (hatches and markers keep their pixel size)...
      if (first !== '') {
        expect(narrow).not.toBe(first);
        expect(wide).not.toBe(narrow);
      }
      // ...and the ids never pile up
      expect(new Set([...ctx.svg().querySelectorAll('[id]')].map((el) => el.id)).size).toBe(
        ctx.svg().querySelectorAll('[id]').length,
      );
      ctx.env.scale = 1;
      ctx.updateAt(ctx.svg());
      expect(defsHtml(ctx)).toBe(first);
      expect(chartRules()).toBe(firstRules);
      expect(ctx.svg().querySelectorAll('defs[data-coloradapt-chart-node]').length).toBe(
        first === '' ? 0 : 1,
      );
    },
  })),
  {
    name: 'bars, the container shrinks 4x and grows back',
    category: 'responsive',
    profile: 'deuteranopia',
    markup: barChartSvg(REDS),
    expect: 'adapted',
    steps(ctx) {
      const first = defsHtml(ctx);
      ctx.env.scale = 4;
      ctx.updateAt(ctx.svg());
      expect(defsHtml(ctx)).not.toBe(first);
      ctx.env.scale = 0.25;
      ctx.updateAt(ctx.svg());
      ctx.env.scale = 1;
      ctx.updateAt(ctx.svg());
      expect(defsHtml(ctx)).toBe(first);
    },
  },
  {
    name: 'line with markers: a height-only change leaves the chart untouched (nothing to redo)',
    category: 'responsive',
    profile: 'deuteranopia',
    markup: lineChartSvg(SIX),
    expect: 'adapted',
    steps(ctx) {
      const before = ctx.charts.diagnostics();
      ctx.updateAt(ctx.svg());
      ctx.updateAt(ctx.svg());
      expect(ctx.charts.diagnostics().chartPassesSkipped).toBe(before.chartPassesSkipped + 2);
    },
  },
  {
    name: 'display:none -> visible: artifacts follow what is laid out',
    category: 'responsive',
    profile: 'deuteranopia',
    markup: lineChartSvg(SIX),
    expect: 'adapted',
    steps(ctx) {
      const identities = lineIdentities(ctx);
      const show = hiddenSvg(ctx.svg());
      ctx.update();
      expect(nodes()).toBe(0);
      expect(marks(ctx)).toBe(0);
      show();
      ctx.update();
      expect(lineIdentities(ctx)).toEqual(identities);
    },
  },
  {
    name: 'the SVG legend moves to the top on a narrow screen: same mapping, same adaptation',
    category: 'responsive',
    profile: 'deuteranopia',
    markup: lineChartSvg(REDS, { keys: true }),
    expect: 'adapted',
    steps(ctx) {
      const identities = lineIdentities(ctx);
      const legend = ctx.svg().querySelector('g.legend')!;
      ctx.svg().prepend(legend);
      ctx.update();
      expect(lineIdentities(ctx)).toEqual(identities);
      expect(ctx.svg().querySelectorAll('[data-coloradapt-chart-legend]').length).toBeGreaterThan(
        0,
      );
    },
  },
  {
    name: 'the legend collapses into an HTML list on a narrow screen: the adaptation goes',
    category: 'responsive',
    profile: 'deuteranopia',
    markup: card(lineChartSvg(REDS, { keys: true })),
    expect: 'refused',
    reason: 'html-legend',
    steps(ctx) {
      ctx.svg().querySelector('g.legend')!.remove();
      document
        .querySelector('.after')!
        .insertAdjacentHTML('beforeend', '<ul class="legend"><li>A</li><li>B</li><li>C</li></ul>');
      ctx.update();
    },
  },
  // ------------------------------------------------------------------------ dynamic
  {
    name: 'dynamic: series added, the others keep their identity',
    category: 'dynamic',
    profile: 'deuteranopia',
    markup: lineChartSvg(SIX.slice(0, 2), { keys: true, legend: false }),
    expect: 'adapted',
    steps(ctx) {
      const before = lineIdentities(ctx);
      const third = ctx.svg().querySelector('path.line:last-of-type')!.cloneNode(true) as Element;
      for (const name of third.getAttributeNames()) {
        if (name.startsWith('data-coloradapt')) third.removeAttribute(name);
      }
      third.setAttribute('stroke', SIX[2]!);
      third.setAttribute('data-series', 's2');
      ctx.svg().querySelector('path.line:last-of-type')!.after(third);
      ctx.update();
      const after = lineIdentities(ctx);
      expect(after.slice(0, 2)).toEqual(before);
      expect(new Set(after).size).toBe(3);
    },
  },
  {
    name: 'dynamic: series removed, the others keep their identity, no artifact of the gone one',
    category: 'dynamic',
    profile: 'deuteranopia',
    markup: lineChartSvg(SIX.slice(0, 4), { keys: true, legend: false }),
    expect: 'adapted',
    steps(ctx) {
      const before = lineIdentities(ctx);
      ctx.svg().querySelectorAll('path.line')[1]!.remove();
      ctx.update();
      expect(lineIdentities(ctx)).toEqual([before[0], before[2], before[3]]);
      expect(marks(ctx)).toBe(2);
    },
  },
  {
    name: 'dynamic: geometry update (a path grows past the marker density limit)',
    category: 'dynamic',
    profile: 'deuteranopia',
    markup: lineChartSvg(SIX.slice(0, 5)),
    expect: 'adapted',
    steps(ctx) {
      const line = ctx.svg().querySelector('path.line')!;
      line.setAttribute(
        'd',
        Array.from(
          { length: 200 },
          (_, k) => `${k === 0 ? 'M' : 'L'}${60 + k} ${100 + ((k * 7) % 40)}`,
        ).join(' '),
      );
      ctx.update();
      expect(ctx.svg().querySelector('defs')).toBeNull();
      expect(ctx.env.getStyle(line).getPropertyValue('marker-mid')).toBe('none');
    },
  },
  {
    name: 'dynamic: palette update (red/green becomes blue/yellow)',
    category: 'dynamic',
    profile: 'deuteranopia',
    markup: lineChartSvg(RED_GREEN, { keys: true }),
    expect: 'untouched',
    steps(ctx) {
      const [a, b] = ctx.svg().querySelectorAll('path.line');
      const [la, lb] = ctx.svg().querySelectorAll('line.swatch');
      a!.setAttribute('stroke', '#0072b2');
      la!.setAttribute('stroke', '#0072b2');
      b!.setAttribute('stroke', '#f0e442');
      lb!.setAttribute('stroke', '#f0e442');
      ctx.update();
      expect(nodes()).toBe(0);
      expect(chartRules()).toBe('');
    },
  },
  {
    name: 'dynamic: palette update the other way (distinct becomes confusable)',
    category: 'dynamic',
    profile: 'deuteranopia',
    markup: lineChartSvg(['#0072b2', '#f0e442'], { keys: true }),
    expect: 'adapted',
    steps(ctx) {
      const [a, b] = ctx.svg().querySelectorAll('path.line');
      const [la, lb] = ctx.svg().querySelectorAll('line.swatch');
      a!.setAttribute('stroke', '#d62728');
      la!.setAttribute('stroke', '#d62728');
      b!.setAttribute('stroke', '#2ca02c');
      lb!.setAttribute('stroke', '#2ca02c');
      ctx.update();
    },
  },
  {
    name: 'dynamic: legend item removed (mapping becomes partial): nothing is left of the adaptation',
    category: 'dynamic',
    profile: 'deuteranopia',
    markup: lineChartSvg(REDS, { keys: true }),
    expect: 'refused',
    reason: 'legend-ambiguous',
    steps(ctx) {
      ctx.svg().querySelectorAll('g.legend-item')[2]!.remove();
      ctx.update();
      expect(marks(ctx)).toBe(0);
      expect(chartRules()).toBe('');
    },
  },
  {
    name: 'dynamic: legend item removed, then put back',
    category: 'dynamic',
    profile: 'deuteranopia',
    markup: lineChartSvg(REDS, { keys: true }),
    expect: 'adapted',
    steps(ctx) {
      const before = lineIdentities(ctx);
      const item = ctx.svg().querySelectorAll('g.legend-item')[2]!;
      const parent = item.parentElement!;
      item.remove();
      ctx.update();
      expect(marks(ctx)).toBe(0);
      parent.append(item);
      ctx.update();
      expect(lineIdentities(ctx)).toEqual(before);
    },
  },
  {
    name: 'dynamic: legend label text changes (same swatch): mapping and encoding unchanged',
    category: 'dynamic',
    profile: 'deuteranopia',
    markup: lineChartSvg(REDS, { keys: true }),
    expect: 'adapted',
    steps(ctx) {
      const before = lineIdentities(ctx);
      for (const text of ctx.svg().querySelectorAll('g.legend-item text'))
        text.textContent = 'renamed';
      ctx.update();
      expect(lineIdentities(ctx)).toEqual(before);
    },
  },
  {
    name: 'dynamic: chart replaced by a look-alike (re-render)',
    category: 'dynamic',
    profile: 'deuteranopia',
    markup: lineChartSvg(SIX),
    expect: 'adapted',
    steps(ctx) {
      const before = lineIdentities(ctx);
      const parent = ctx.svg().parentElement!;
      ctx.svg().remove();
      parent.insertAdjacentHTML('beforeend', lineChartSvg(SIX));
      ctx.update();
      expect(lineIdentities(ctx)).toEqual(before);
      expect(document.querySelectorAll('defs[data-coloradapt-chart-node]')).toHaveLength(1);
    },
  },
  {
    name: 'dynamic: a series hidden by the page, then shown again (identity remembered)',
    category: 'dynamic',
    profile: 'deuteranopia',
    markup: lineChartSvg(SIX.slice(0, 3), { keys: true, legend: false }),
    expect: 'adapted',
    steps(ctx) {
      const before = lineIdentities(ctx);
      const hidden = ctx.svg().querySelectorAll('path.line')[1]!;
      hidden.setAttribute('display', 'none');
      ctx.update();
      hidden.removeAttribute('display');
      ctx.update();
      expect(lineIdentities(ctx)).toEqual(before);
    },
  },
  {
    name: 'dynamic: profile switch protanopia -> tritanopia leaves nothing of protanopia',
    category: 'dynamic',
    profile: 'protanopia',
    markup: lineChartSvg(CONFUSABLE),
    expect: 'untouched',
    steps(ctx) {
      expect(marks(ctx)).toBeGreaterThan(0);
      ctx.charts.begin({ enabled: true, adaptCharts: true, visionProfile: 'tritanopia' });
      ctx.update();
      expect(marks(ctx)).toBe(0);
      expect(chartRules()).toBe('');
    },
  },
  // -------------------------------------------------------------- interactive legend
  {
    name: 'interactive SVG legend: buttons keep role, name, tabindex and place',
    category: 'interactive legend',
    profile: 'deuteranopia',
    markup: interactiveLegend(lineChartSvg(REDS, { keys: true })),
    expect: 'adapted',
    verify(ctx) {
      const items = [...ctx.svg().querySelectorAll('g.legend-item')];
      expect(items).toHaveLength(3);
      for (const item of items) {
        expect(item.getAttribute('role')).toBe('button');
        expect(item.getAttribute('tabindex')).toBe('0');
        expect(item.getAttribute('aria-label')).toMatch(/^Toggle series/);
        expect(item.parentElement?.getAttribute('class')).toBe('legend');
      }
    },
  },
  {
    name: 'interactive SVG legend on bars',
    category: 'interactive legend',
    profile: 'deuteranopia',
    markup: interactiveLegend(barChartSvg(REDS)),
    expect: 'adapted',
    verify(ctx) {
      for (const item of ctx.svg().querySelectorAll('g.legend-item')) {
        expect(item.getAttribute('role')).toBe('button');
        expect(item.querySelector('[data-coloradapt-chart-node]')).toBeNull();
      }
    },
  },
  {
    name: 'interactive SVG legend: a series toggled off and on keeps its identity',
    category: 'interactive legend',
    profile: 'deuteranopia',
    markup: interactiveLegend(lineChartSvg(REDS, { keys: true })),
    expect: 'adapted',
    steps(ctx) {
      const before = lineIdentities(ctx);
      const path = ctx.svg().querySelectorAll('path.line')[1]!;
      path.setAttribute('style', 'opacity:0.15');
      ctx.update();
      path.removeAttribute('style');
      ctx.update();
      expect(lineIdentities(ctx)).toEqual(before);
    },
  },
];

/** Sanity of the fixtures themselves, so the boundary scenarios mean what they say. */
export const FIXTURE_FACTS = {
  at2000: countShapes(padShapes(lineChartSvg(REDS), 2000)),
  at2001: countShapes(padShapes(lineChartSvg(REDS), 2001)),
  at6000: countElements(padElements(lineChartSvg(REDS), 6000)),
  at6001: countElements(padElements(lineChartSvg(REDS), 6001)),
};
