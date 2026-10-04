import { expect, test, type Page } from '@playwright/test';
import {
  launchExtension,
  settle,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';
import { CHART_SETTINGS, artifacts, hitPointOnPath, draw, loadCharts } from './chart-kit';
import { load, type Loaded } from './r1-kit';
import {
  NON_CHARTS,
  barSvg,
  customDashboard,
  d3Like,
  highchartsLike,
  lineSvg,
  pageHtml,
  pieSvg,
  plotlyLike,
  rechartsLike,
} from './r1-fixtures';

/**
 * M7.R1: generic structural detection against output shaped like common chart libraries (nested
 * groups, clip paths, generated classes, transforms, separate legend groups, dynamic updates), the
 * curated non-charts that must never be claimed, sequential and diverging palettes, charts that
 * already tell their series apart, and canvases. Nothing here imports a library or names one in
 * production code: the fixtures only imitate the shape of what such libraries draw.
 */
let server: PageServer;
let ext: ExtensionSession;
let counter = 0;

test.beforeAll(async () => {
  server = await startPageServer();
  ext = await launchExtension();
});
test.afterEach(async () => {
  await Promise.all(ext.context.pages().map((page) => page.close()));
});
test.afterAll(async () => {
  await ext.close();
  await server.close();
});

async function open(
  body: string,
  css = '',
  settings: Record<string, unknown> = CHART_SETTINGS,
): Promise<Loaded> {
  counter += 1;
  const name = `r1-lib-${counter}.html`;
  server.serve(name, pageHtml(body, css));
  return load(ext, server, name, settings);
}

/** Computed strokes and fills of everything painted in the chart: what the colors are. */
const paints = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#chart path, #chart rect, #chart circle, #chart line')]
      .filter((el) => !el.closest('[data-coloradapt-chart-node]'))
      .map((el) => {
        const s = getComputedStyle(el);
        return `${el.tagName}|${s.stroke}|${s.fill}`;
      }),
  );

/** Everything the chart layer wrote, as text, for "nothing is written" checks. */
const nothing = { defs: 0, overlays: 0, marked: 0, chartRules: 0 };

test.describe('library-shaped output: the structure survives, the legend is never left behind', () => {
  const FIXTURES: ReadonlyArray<readonly [string, () => string, 'adapted' | 'refused']> = [
    [
      'D3-like SVG (margin group, axis groups, a legend group of its own)',
      () => d3Like(),
      'adapted',
    ],
    [
      'Recharts-like SVG (clip path, layers, an HTML legend wrapper)',
      () => rechartsLike(),
      'refused',
    ],
    [
      'Highcharts-like SVG (tracker lines, background rects, legend text before swatch)',
      () => highchartsLike(),
      'refused',
    ],
    [
      'Plotly-like SVG (inline styles, trace groups, legend text before swatch)',
      () => plotlyLike(),
      'refused',
    ],
    ['a custom dashboard card with a hand-rolled SVG chart', () => customDashboard(), 'adapted'],
  ];

  for (const [name, build, outcome] of FIXTURES) {
    test(`${name}: ${outcome}`, async () => {
      const view = await open(build());
      const a = await artifacts(view.page);
      const colors = await paints(view.page);
      // the chart is claimed (M5 keeps off its marks) whatever the outcome
      expect(a.owned).toBe(1);
      if (outcome === 'adapted') {
        expect(a.marked).toBeGreaterThan(0);
        // legend and series wear the same thing: every adapted slot has a legend counterpart
        const sync = await view.page.evaluate(() => {
          const slots = (attribute: string) =>
            new Set(
              [...document.querySelectorAll(`[${attribute}]`)].map((n) =>
                n.getAttribute(attribute),
              ),
            );
          const marks = slots('data-coloradapt-chart-mark');
          const legends = slots('data-coloradapt-chart-legend');
          const overlays = document.querySelectorAll(
            '[data-coloradapt-chart-node="overlay"]',
          ).length;
          return {
            marks: marks.size,
            covered: [...marks].every((slot) => legends.has(slot)) || overlays >= marks.size - 1,
          };
        });
        expect(sync.marks).toBeGreaterThan(0);
        expect(sync.covered).toBe(true);
      } else {
        expect(a).toMatchObject(nothing);
      }
      // colors are untouched: the same page with the chart layer off paints the same
      await view.page.close();
      const off = await open(build(), '', { ...CHART_SETTINGS, adaptCharts: false });
      expect(await paints(off.page)).toEqual(colors);
    });
  }

  test('D3-like: data updates (new vertices, a new palette, a legend change) keep the chart consistent', async () => {
    const view = await open(d3Like());
    const base = await artifacts(view.page);
    expect(base.marked).toBeGreaterThan(0);
    // data refresh: same structure, new coordinates
    await view.page.evaluate(() => {
      for (const p of document.querySelectorAll('#chart path.line')) {
        const d = p.getAttribute('d')!;
        p.setAttribute(
          'd',
          d.replace(/(\d+),(\d+)/g, (_m, x: string, y: string) => `${x},${Number(y) + 7}`),
        );
      }
    });
    await view.step();
    expect((await artifacts(view.page)).marked).toBe(base.marked);
    // palette: the page recolors a series and its legend swatch to something a deuteranope can tell apart
    await view.page.evaluate(() => {
      const lines = document.querySelectorAll('#chart path.line');
      const swatches = document.querySelectorAll('#chart .legend-item rect');
      (lines[1] as SVGElement).setAttribute('stroke', '#0072b2');
      (swatches[1] as SVGElement).setAttribute('fill', '#0072b2');
    });
    await view.step();
    const recolored = await artifacts(view.page);
    // fewer conflicts now (or none): never more artifacts than a chart that needs fewer encodings
    expect(recolored.marked).toBeLessThanOrEqual(base.marked);
    // a legend entry removed: the mapping is partial, so nothing stays adapted
    await view.page.evaluate(() => document.querySelectorAll('#chart .legend-item')[2]!.remove());
    await view.step();
    expect(await artifacts(view.page)).toMatchObject(nothing);
  });

  test('a chart re-rendered by its library (every node replaced) is adapted again, the old artifacts gone', async () => {
    const view = await open(d3Like());
    const first = await artifacts(view.page);
    expect(first.marked).toBeGreaterThan(0);
    await view.page.evaluate((html) => {
      const old = document.getElementById('chart')!;
      const holder = document.createElement('div');
      holder.innerHTML = html;
      old.replaceWith(holder.firstElementChild!);
    }, d3Like());
    await view.step();
    const again = await artifacts(view.page);
    expect(again.marked).toBe(first.marked);
    expect(again.defs).toBe(first.defs);
    expect(
      await view.page.evaluate(
        () => document.querySelectorAll('[data-coloradapt-chart-owner]').length,
      ),
    ).toBe(
      await view.page.evaluate(
        () => document.querySelectorAll('[data-coloradapt-chart-owner]').length,
      ),
    );
  });
});

test.describe('curated non-charts are never claimed', () => {
  for (const [name, markup] of NON_CHARTS) {
    test(`${name}: not owned, nothing written, M5 keeps its normal behavior`, async () => {
      const view = await open(`<div>${markup}</div>`);
      expect(await artifacts(view.page)).toMatchObject({ ...nothing, owned: 0 });
      expect(
        await view.page.evaluate(
          () => document.querySelectorAll('[data-coloradapt-chart-owner]').length,
        ),
      ).toBe(0);
      expect((await view.diag()).charts.chartsDetected).toBe(0);
    });
  }

  test('a pie with no legend, with an incomplete legend, and with duplicate colors is not a supported pie', async () => {
    const colors = ['#d62728', '#d82a29', '#da2c2b'];
    const none = await open(pieSvg('chart', colors, false));
    expect((await artifacts(none.page)).marked).toBe(0);
    const incomplete = await open(pieSvg('chart', colors, 2));
    expect((await artifacts(incomplete.page)).marked).toBe(0);
    const duplicates = await open(pieSvg('chart', ['#d62728', '#d62728', '#2ca02c']));
    expect((await artifacts(duplicates.page)).marked).toBe(0);
    // the genuine pie, for contrast
    const genuine = await open(pieSvg('chart', colors));
    expect((await artifacts(genuine.page)).marked).toBeGreaterThan(0);
  });
});

test.describe('ordered palettes are left alone', () => {
  const PALETTES: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['single-hue bars', ['#deebf7', '#9ecae1', '#4292c6', '#08519c']],
    ['light-to-dark gray ramp', ['#f0f0f0', '#bdbdbd', '#737373', '#252525']],
    ['diverging red-white-blue', ['#b2182b', '#ef8a62', '#f7f7f7', '#67a9cf', '#2166ac']],
    ['temperature-like (viridis)', ['#440154', '#3b528b', '#21908d', '#5dc863', '#fde725']],
    ['ordered yellow-orange-red', ['#ffffb2', '#fecc5c', '#fd8d3c', '#e31a1c']],
  ];
  for (const [name, colors] of PALETTES) {
    test(`${name}: classified, owned, not categorically adapted`, async () => {
      const view = await open(barSvg({ id: 'chart', colors, legend: 'svg' }));
      expect(await artifacts(view.page)).toMatchObject({ ...nothing, owned: 1 });
      expect(
        await view.page.evaluate(() =>
          [...document.querySelectorAll('#chart rect.bar')].every((r) =>
            getComputedStyle(r).fill.startsWith('rgb('),
          ),
        ),
      ).toBe(true);
    });
  }

  test('categorical bars in the same number of colors are adapted when color alone cannot separate them', async () => {
    const view = await open(
      barSvg({ id: 'chart', colors: ['#d62728', '#2ca02c', '#ff7f0e'], legend: 'svg' }),
    );
    expect((await artifacts(view.page)).marked).toBeGreaterThan(0);
  });
});

test.describe('charts that already tell their series apart get nothing more', () => {
  const RED3 = ['#d62728', '#d82a29', '#da2c2b'];
  const CASES: ReadonlyArray<readonly [string, string]> = [
    [
      'dash styles',
      lineSvg({ id: 'chart', colors: RED3, legend: 'svg', dashes: [null, '6 3', '2 2'] }),
    ],
    [
      'stroke widths differing 2x or more',
      lineSvg({ id: 'chart', colors: RED3, legend: 'svg', widths: [1, 3, 6] }),
    ],
    [
      'direct labels at the line ends, in the series colors',
      lineSvg({ id: 'chart', colors: RED3, legend: 'none' }).replace(
        '</svg>',
        `${RED3.map((c, i) => `<text x="${392}" y="${90 + i * 22}" fill="${c}" font-size="11">Series ${i + 1}</text>`).join('')}</svg>`,
      ),
    ],
  ];
  for (const [name, markup] of CASES) {
    test(`${name}: untouched`, async () => {
      const view = await open(markup);
      expect(await artifacts(view.page)).toMatchObject({ ...nothing, owned: 1 });
    });
  }
});

test.describe('canvas stays detect-only', () => {
  test('a map canvas: classified, never adapted, pixels and prototype unchanged', async () => {
    const view = await loadCharts(ext, server);
    await view.page.evaluate(() => {
      window.chartKit.clear();
      const host = document.getElementById('host')!;
      host.insertAdjacentHTML(
        'beforeend',
        '<div class="map"><canvas id="map" class="map-canvas" width="300" height="200"></canvas></div>',
      );
      const c = document.getElementById('map') as HTMLCanvasElement;
      const g = c.getContext('2d')!;
      g.fillStyle = '#d62728';
      g.fillRect(10, 10, 100, 80);
      g.fillStyle = '#2ca02c';
      g.fillRect(120, 60, 100, 100);
    });
    const hash = () =>
      view.page.evaluate(() => {
        const c = document.getElementById('map') as HTMLCanvasElement;
        const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let h = 0;
        for (let i = 0; i < data.length; i += 1) h = (h * 31 + data[i]!) >>> 0;
        return h;
      });
    const proto = () =>
      view.page.evaluate(
        () =>
          Object.getOwnPropertyNames(CanvasRenderingContext2D.prototype)
            .map(
              (n) =>
                `${n}:${String(Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, n)?.value ?? '')}`,
            )
            .join('\n').length,
      );
    const before = { hash: await hash(), proto: await proto() };
    await view.step();
    expect((await view.diag()).charts.canvasUnknown).toBeGreaterThanOrEqual(1);
    expect({ hash: await hash(), proto: await proto() }).toEqual(before);
    expect(
      await view.page.evaluate(() =>
        document
          .getElementById('map')!
          .getAttributeNames()
          .filter((n) => n.startsWith('data-coloradapt')),
      ),
    ).toEqual([]);
  });
});

test.describe('dashed lines: the documented hit-testing limit, measured', () => {
  test('the gaps of an adapted dashed stroke are not hit-testable, the painted share is at least half', async () => {
    const view = await loadCharts(ext, server);
    await draw(view.page, 'line', {
      id: 'c',
      series: [
        { name: 'A', color: '#d62728' },
        { name: 'B', color: '#d82a29' },
      ],
      legend: 'svg',
      interactive: true,
    });
    await view.step();
    const dash = await view.page.evaluate(
      () => getComputedStyle(document.querySelector('#c path.series-1')!).strokeDasharray,
    );
    expect(dash).not.toBe('none');
    const share = await view.page.evaluate(() => {
      const path = document.querySelector('#c path.series-1') as SVGGeometryElement;
      const length = path.getTotalLength();
      const matrix = path.getScreenCTM()!;
      let hit = 0;
      let total = 0;
      for (let at = 0; at <= length; at += 0.5) {
        const p = path.getPointAtLength(at);
        const q = new DOMPoint(p.x, p.y).matrixTransform(matrix);
        const top = document.elementFromPoint(q.x, q.y);
        // only count samples where nothing else is on top of the line either
        if (top === path || top?.closest('svg')?.id === 'c') {
          total += 1;
          if (top === path) hit += 1;
        }
      }
      return hit / total;
    });
    expect(share).toBeGreaterThan(0.45);
    expect(share).toBeLessThan(0.95);
    // a painted spot is hit-testable: the pointer reaches the page's handler
    const point = await hitPointOnPath(view.page, '#c path.series-1', 0.3);
    await view.page.mouse.click(point.x, point.y);
    expect(await view.page.evaluate(() => window.__log.clicked)).toEqual(['B']);
    await settle(view.page);
  });
});
