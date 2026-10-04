import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StylesheetManager } from '@core/adaptation';
import { CHART_NODE_ATTRIBUTE } from '@core/charts';
import { ChartController } from '@features/charts';
import { createChartEnvironment, lineChartSvg } from './engine';
import { HTML_LEGENDS, sw } from './fixtures-r1';

/**
 * M7.R1: the HTML legend guard. A chart that has (or may have) a legend M7 cannot synchronize is
 * refused whole; a chart with no legend evidence keeps the normal policy; a legend that appears,
 * goes or moves later changes the verdict. Real-browser fixtures of the same variants are in
 * e2e/chart-r1-legends.spec.ts (pseudo-elements, computed layout, interactive controls).
 */
const SETTINGS = { enabled: true, adaptCharts: true, visionProfile: 'deuteranopia' as const };
const RED_GREEN = ['#d62728', '#2ca02c'];

function setup() {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  const sheet = new StylesheetManager(document);
  const env = createChartEnvironment(document);
  const charts = new ChartController({ doc: document, sheet, env });
  charts.begin(SETTINGS);
  const scan = () => charts.update([{ element: document.body, scope: 'subtree' }]);
  return { charts, scan };
}

const chartSvg = () => lineChartSvg(RED_GREEN, { legend: false });
const svgOf = () => document.getElementById('chart') as unknown as SVGSVGElement;
const written = () =>
  document.querySelectorAll(
    `[${CHART_NODE_ATTRIBUTE}],[data-coloradapt-chart-mark],[data-coloradapt-chart-legend]`,
  ).length;

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});
afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('HTML legend variants are refused whole (never "marks adapted, legend unchanged")', () => {
  for (const [name, legend] of HTML_LEGENDS) {
    for (const placement of ['below', 'above', 'beside'] as const) {
      it(`${name}, ${placement}: html-legend`, () => {
        const { charts, scan } = setup();
        const markup =
          placement === 'below'
            ? `<div class="card">${chartSvg()}<div class="side">${legend}</div></div>`
            : placement === 'above'
              ? `<div class="card"><div class="side">${legend}</div>${chartSvg()}</div>`
              : `<div class="row"><div class="col">${chartSvg()}</div><div class="col">${legend}</div></div>`;
        document.body.insertAdjacentHTML('beforeend', markup);
        scan();
        expect(charts.inspect(svgOf())).toMatchObject({ status: 'limited', reason: 'html-legend' });
        expect(written()).toBe(0);
        expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
        // refused charts are still owned: M5 must not recolor their marks either
        expect(charts.owns(svgOf())).toBe(true);
      });
    }
  }

  it('a chart directly in <body> looks at its siblings', () => {
    const { charts, scan } = setup();
    document.body.insertAdjacentHTML(
      'beforeend',
      `${chartSvg()}<div class="chart-legend"><span>Red</span><span>Green</span></div>`,
    );
    scan();
    expect(charts.inspect(svgOf())).toMatchObject({ status: 'limited', reason: 'html-legend' });
    expect(written()).toBe(0);
  });

  it('a legend named by aria-describedby is found wherever it is', () => {
    const { charts, scan } = setup();
    document.body.insertAdjacentHTML(
      'beforeend',
      `<main><section><div>${chartSvg().replace('<svg ', '<svg aria-describedby="key1" ')}</div></section></main><footer><div id="key1">${sw('#d62728')} Red ${sw('#2ca02c', '0,20,12,12')} Green</div></footer>`,
    );
    scan();
    expect(charts.inspect(svgOf())).toMatchObject({ status: 'limited', reason: 'html-legend' });
  });
});

describe('no legend evidence: the normal policy', () => {
  const NEUTRAL: ReadonlyArray<readonly [string, string]> = [
    ['nothing around it', ''],
    [
      'prose next to it',
      '<p>Revenue grew 12% year over year, driven by the red and green regions.</p>',
    ],
    ['a title and a caption', '<h3>Revenue</h3><p class="note">Source: finance</p>'],
    [
      'a class like key-metric or monkey',
      '<div class="key-metric">12%</div><div class="monkey">x</div>',
    ],
    ['one swatch only (a status dot)', `<p>${sw('#d62728')} Live</p>`],
    ['plain buttons', '<button>Export</button><button>Share</button>'],
    [
      'toggle buttons without color',
      '<button aria-pressed="false">Day</button><button aria-pressed="true">Week</button>',
    ],
    [
      'a gray glyph',
      '<p><span style="color:#555555">●</span> a</p><p><span style="color:#666666">●</span> b</p>',
    ],
    [
      'colored text that is not a series color (status words)',
      '<p><span style="color:#c0392b">Error</span> <span style="color:#27ae60">OK</span></p>',
    ],
    ['one series-colored label only', '<p><span style="color:#d62728">Revenue</span></p>'],
    [
      'the same swatch color twice',
      `<p>${sw('#d62728')} a</p><p>${sw('#d62728', '0,20,12,12')} b</p>`,
    ],
  ];
  for (const [name, around] of NEUTRAL) {
    it(`${name}: the chart is adapted as usual`, () => {
      const { charts, scan } = setup();
      document.body.insertAdjacentHTML(
        'beforeend',
        `<div class="card">${chartSvg()}<div class="after">${around}</div></div>`,
      );
      scan();
      expect(charts.inspect(svgOf())).toMatchObject({ status: 'supported', adapted: 1 });
      expect(written()).toBeGreaterThan(0);
    });
  }

  it('a legend two levels above the chart card is outside the neighbourhood (documented bound)', () => {
    const { charts, scan } = setup();
    document.body.insertAdjacentHTML(
      'beforeend',
      `<section><div class="chart-legend"><span>Red</span></div><div><div><div>${chartSvg()}</div></div></div></section>`,
    );
    scan();
    // the legend sits three ancestors away: not scanned (the bound is the parent and the grandparent)
    expect(charts.inspect(svgOf()).status).toBe('supported');
  });
});

describe('a legend that comes, goes or moves later changes the verdict', () => {
  it('adapted chart + legend appears: the adaptation is removed (nothing left in front of a plain legend)', () => {
    const { charts, scan } = setup();
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div class="card" id="card">${chartSvg()}<div id="slot"></div></div>`,
    );
    scan();
    expect(charts.inspect(svgOf())).toMatchObject({ status: 'supported', adapted: 1 });
    expect(written()).toBeGreaterThan(0);

    const slot = document.getElementById('slot')!;
    slot.innerHTML = `<p>${sw('#d62728')} Red</p><p>${sw('#2ca02c', '0,20,12,12')} Green</p>`;
    // M4 reports the added element as a region of its own; the chart is in its neighbourhood
    charts.update([{ element: slot, scope: 'subtree' }]);
    expect(charts.inspect(svgOf())).toMatchObject({ status: 'limited', reason: 'html-legend' });
    expect(written()).toBe(0);
  });

  it('refused chart + legend removed: the chart is re-read and adapted', () => {
    const { charts, scan } = setup();
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div class="card" id="card">${chartSvg()}<div class="chart-legend" id="lg"><span>Red</span><span>Green</span></div></div>`,
    );
    scan();
    expect(charts.inspect(svgOf()).status).toBe('limited');
    const card = document.getElementById('card')!;
    document.getElementById('lg')!.remove();
    // M4: a removal reports the parent as an anchor (peer seed), never a region
    charts.update([], [card]);
    expect(charts.inspect(svgOf())).toMatchObject({ status: 'supported', adapted: 1 });
  });

  it('a legend that changes its swatch color is re-read', () => {
    const { charts, scan } = setup();
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div class="card">${chartSvg()}<div id="slot"><p id="one">${sw('#888888')} a</p><p>${sw('#888888', '0,20,12,12')} b</p></div></div>`,
    );
    scan();
    expect(charts.inspect(svgOf()).status).toBe('supported');
    const one = document.getElementById('one')!;
    one.querySelector('span')!.setAttribute('style', 'background-color:#d62728');
    document
      .getElementById('slot')!
      .lastElementChild!.querySelector('span')!
      .setAttribute('style', 'background-color:#2ca02c');
    charts.update([{ element: document.getElementById('slot')!, scope: 'subtree' }]);
    expect(charts.inspect(svgOf())).toMatchObject({ status: 'limited', reason: 'html-legend' });
    expect(written()).toBe(0);
  });

  it('a legend moved elsewhere in the page (responsive layout) is still found or the chart still fails safe', () => {
    const { charts, scan } = setup();
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div class="card" id="card">${chartSvg()}<div id="a"><div class="chart-legend" id="lg"><span>Red</span><span>Green</span></div></div><div id="b"></div></div>`,
    );
    scan();
    expect(charts.inspect(svgOf()).status).toBe('limited');
    document.getElementById('b')!.append(document.getElementById('lg')!);
    charts.update(
      [{ element: document.getElementById('b')!, scope: 'subtree' }],
      [document.getElementById('a')!],
    );
    expect(charts.inspect(svgOf())).toMatchObject({ status: 'limited', reason: 'html-legend' });
    expect(written()).toBe(0);
    // and out of the neighbourhood altogether: the chart is no longer next to a legend
    document.body.append(document.getElementById('lg')!);
    charts.update([{ element: document.body, scope: 'subtree' }]);
    expect(charts.inspect(svgOf()).status).toBe('supported');
  });
});

describe('partial mapping inside the SVG refuses atomically', () => {
  it('five series, four legend items (one without an item): the whole chart is left alone', () => {
    const { charts, scan } = setup();
    const five = ['#d62728', '#d82a29', '#da2c2b', '#dc2e2d', '#de302f'];
    const markup = lineChartSvg(five, { keys: true });
    // drop the last legend entry from the legend group
    const trimmed = markup.replace(
      /<g class="legend-item">(?:(?!<g class="legend-item">).)*<\/g><\/g><\/svg>$/s,
      '</g></svg>',
    );
    expect(trimmed).not.toBe(markup);
    document.body.insertAdjacentHTML('beforeend', trimmed);
    scan();
    expect(charts.inspect(svgOf())).toMatchObject({ status: 'limited' });
    expect(written()).toBe(0);
  });

  it('a legend item that matches no series is not guessed at', () => {
    const { charts, scan } = setup();
    const markup = lineChartSvg(['#d62728', '#d82a29', '#da2c2b'], { keys: true }).replace(
      /<line([^>]*)data-series="s2"/,
      '<line$1data-series="other"',
    );
    document.body.insertAdjacentHTML('beforeend', markup);
    scan();
    expect(charts.inspect(svgOf()).status).toBe('limited');
    expect(written()).toBe(0);
  });
});
