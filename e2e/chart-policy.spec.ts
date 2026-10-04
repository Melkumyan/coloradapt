import { expect, test, type Page } from '@playwright/test';
import {
  launchExtension,
  refresh,
  setSettings,
  settle,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';
import {
  CHART_SETTINGS,
  DISTINCT,
  NOTHING,
  REDS,
  RED_GREEN,
  SIX,
  artifacts,
  chartCounters,
  draw,
  loadCharts,
  looks,
  markup,
  type SeriesSpec,
} from './chart-kit';

/**
 * What M7 will and will not touch, in a real Chromium: unsupported chart types are detected and left
 * alone, things that are not charts are not claimed, canvases are never adapted, a page's own CSS is
 * never fought, and every limit is structural (docs/CHARTS.md, "Policy").
 */
let server: PageServer;
let ext: ExtensionSession;

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

const OWNED_ONLY = { ...NOTHING, owned: 1 };

test.describe('chart types M7 recognizes and does not adapt', () => {
  test('heatmap: detected (owned, so M5 stays away), never adapted: color there is magnitude', async () => {
    const view = await loadCharts(ext, server);
    await view.page.evaluate(() => window.chartKit.heatmap({ id: 'h' }));
    await view.step();
    expect(await artifacts(view.page)).toEqual(OWNED_ONLY);
    expect((await chartCounters(view)).chartsUnsupported).toBe(1);
  });

  test('area and stacked bars: classified, never adapted', async () => {
    const view = await loadCharts(ext, server);
    await draw(view.page, 'area', { id: 'a', series: RED_GREEN, legend: 'svg' });
    await draw(view.page, 'stacked', { id: 's', series: REDS, legend: 'svg' });
    await view.step();
    expect(await artifacts(view.page)).toEqual({ ...NOTHING, owned: 2 });
    expect((await chartCounters(view)).chartsUnsupported).toBe(2);
  });

  test('an HTML legend next to the chart cannot be synchronized: the chart is left as drawn', async () => {
    const view = await loadCharts(ext, server);
    await draw(view.page, 'line', { id: 'c', series: RED_GREEN, legend: 'html' });
    await view.step();
    expect(await artifacts(view.page)).toEqual(OWNED_ONLY);
    expect((await looks(view.page, '#c path.series')).every((l) => l.dash === 'none')).toBe(true);
  });

  test('a legend that cannot be paired with its series is ambiguous: nothing is written', async () => {
    const view = await loadCharts(ext, server);
    // two series of one color told apart by a dash the legend swatches also carry: color cannot pair them
    await draw(view.page, 'line', {
      id: 'c',
      series: [
        { name: 'A', color: '#d62728' },
        { name: 'B', color: '#d62728', dash: '4 2' },
        { name: 'C', color: '#2ca02c' },
      ],
      legend: 'svg',
    });
    await view.step();
    expect((await artifacts(view.page)).marked).toBe(0);
    expect(await artifacts(view.page)).toEqual(OWNED_ONLY);
  });

  test('a pie without a legend is not claimed or adapted: arcs in a circle are a gauge or a logo as often as a pie', async () => {
    const view = await loadCharts(ext, server);
    await draw(view.page, 'pie', { id: 'p', series: REDS, legend: 'none' });
    await view.step();
    expect(await artifacts(view.page)).toEqual(NOTHING);
  });
});

test.describe('things that are not charts', () => {
  test('logo, illustration (map-like), diagram and icon are not claimed and not touched', async () => {
    const view = await loadCharts(ext, server);
    await view.page.evaluate(() => {
      window.chartKit.logo({ id: 'logo' });
      window.chartKit.ambiguous({ id: 'map' });
      window.chartKit.diagram({ id: 'diagram' });
      window.chartKit.icon({ id: 'icon' });
    });
    await view.step();
    expect(await artifacts(view.page)).toEqual({
      ...NOTHING,
      sheet: await view.page.evaluate(
        () => document.getElementById('coloradapt-stylesheet') !== null,
      ),
    });
    expect((await artifacts(view.page)).owned).toBe(0);
    expect((await chartCounters(view)).chartsDetected).toBe(0);
  });
});

test.describe('canvas: detected, never adapted, never patched', () => {
  const canvases = (page: Page) =>
    page.evaluate(() => {
      const w = window.chartKit;
      w.canvas({ id: 'chartjs', class: 'chartjs-render-monitor', wrapClass: 'chart-container' });
      w.canvas({ id: 'game', class: 'game-board' });
      w.canvas({ id: 'draw', class: 'drawing-pad' });
      w.canvas({ id: 'sig', label: 'signature pad' });
      w.canvas({ id: 'video', class: 'video-frame-processor' });
    });
  const pixelsOf = (page: Page) =>
    page.evaluate(() =>
      Object.fromEntries(
        ['chartjs', 'game', 'draw', 'sig', 'video'].map((id) => {
          const canvas = document.getElementById(id) as HTMLCanvasElement;
          const data = canvas
            .getContext('2d')!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let hash = 0;
          for (let i = 0; i < data.length; i += 1) hash = (hash * 31 + data[i]!) >>> 0;
          return [id, hash];
        }),
      ),
    );

  test('a Chart.js-like canvas is reported as a canvas chart, the others as unknown; no canvas changes', async () => {
    const view = await loadCharts(ext, server);
    await canvases(view.page);
    const before = await pixelsOf(view.page);
    const html = await markup(view.page);
    await view.step();
    await refresh(ext.worker, view.page);
    await settle(view.page);
    expect(await pixelsOf(view.page)).toEqual(before);
    expect((await markup(view.page)).replace(/ data-coloradapt-id="[^"]*"/g, '')).toBe(html);
    expect(await artifacts(view.page)).toEqual(NOTHING);
    expect(await chartCounters(view)).toMatchObject({
      canvasCharts: 1,
      canvasUnknown: 4,
      chartsDetected: 0,
    });
  });

  test("the 2D context API is the browser's own: no property of CanvasRenderingContext2D is replaced", async () => {
    const view = await loadCharts(ext, server);
    await canvases(view.page);
    await view.step();
    const patched = await view.page.evaluate(() => {
      const proto = CanvasRenderingContext2D.prototype;
      const bad: string[] = [];
      for (const name of Object.getOwnPropertyNames(proto)) {
        const d = Object.getOwnPropertyDescriptor(proto, name) as {
          value?: unknown;
          get?: unknown;
          set?: unknown;
        };
        const candidates: unknown[] = [d.value, d.get, d.set];
        for (const fn of candidates) {
          if (
            typeof fn === 'function' &&
            !/\[native code\]/.test(Function.prototype.toString.call(fn))
          )
            bad.push(name);
        }
      }
      return bad;
    });
    expect(patched).toEqual([]);
  });
});

test.describe("a page's own CSS is never fought: the browser has the last word", () => {
  async function pageWith(css: string, inline = '') {
    const view = await loadCharts(ext, server);
    if (css) await view.page.addStyleTag({ content: css });
    await draw(view.page, 'line', { id: 'c', series: RED_GREEN, legend: 'svg' });
    if (inline)
      await view.page.evaluate(
        (style) =>
          document
            .querySelectorAll('#c path.series')
            .forEach((p) => p.setAttribute('style', style)),
        inline,
      );
    await view.step();
    return view;
  }
  const adapted = async (page: Page) =>
    (await looks(page, '#c path.series'))[1]!.dash !== 'none' &&
    (await looks(page, '#c path.series'))[1]!.dash !==
      (await looks(page, '#c path.series'))[0]!.dash;

  for (const [name, css] of [
    ['class', '.series { stroke-dasharray: none }'],
    ['id', '#c path.series-1 { stroke-dasharray: none }'],
    ['id chain', '#host #c-wrap #c .plot path.series { stroke-dasharray: none }'],
  ] as const) {
    test(`a page ${name} rule without !important: ours wins and the chart is adapted`, async () => {
      const view = await pageWith(css);
      expect(await adapted(view.page)).toBe(true);
      expect((await chartCounters(view)).chartNotApplied).toBe(0);
    });
  }

  test('an inline style without !important: ours wins', async () => {
    const view = await pageWith('', 'stroke-dasharray: none');
    expect(await adapted(view.page)).toBe(true);
  });

  for (const [name, css, inline] of [
    ['rule', '#c path.series { stroke-dasharray: 1 1 !important }', ''],
    ['inline', '', 'stroke-dasharray: 1 1 !important'],
  ] as const) {
    test(`a page !important ${name} that out-ranks ours: not applied, rolled back, nothing left`, async () => {
      const view = await pageWith(css, inline);
      expect(await artifacts(view.page)).toEqual(OWNED_ONLY);
      expect((await chartCounters(view)).chartNotApplied).toBe(1);
      // and the page's own dash is what is painted
      expect((await looks(view.page, '#c path.series')).every((l) => l.dash === '1px, 1px')).toBe(
        true,
      );
    });
  }

  test('a page !important fill on bars keeps patterns out: not applied', async () => {
    const view = await loadCharts(ext, server);
    await view.page.addStyleTag({ content: '#b rect.bar { fill: #888 !important }' });
    await draw(view.page, 'bar', { id: 'b', series: RED_GREEN, legend: 'svg' });
    await view.step();
    // the series colors the page forces are all one gray: nothing to separate any more, nothing written
    expect((await artifacts(view.page)).marked).toBe(0);
    expect((await artifacts(view.page)).defs).toBe(0);
  });
});

test.describe('settings and vision profiles', () => {
  const draws = async (page: Page, series: readonly SeriesSpec[]) => {
    await draw(page, 'line', { id: 'c', series, legend: 'svg' });
  };

  test('adaptCharts off, and normal vision: nothing is written or claimed', async () => {
    for (const settings of [
      { ...CHART_SETTINGS, adaptCharts: false },
      { ...CHART_SETTINGS, visionProfile: 'normal' },
      { ...CHART_SETTINGS, visionProfile: 'custom' },
    ]) {
      const view = await loadCharts(ext, server, settings);
      await draws(view.page, REDS);
      await view.step();
      expect(await artifacts(view.page)).toEqual(NOTHING);
      await view.page.close();
    }
  });

  test('protan, deutan and tritan each get adapted for the pairs they confuse, and not for the others', async () => {
    const cases: Array<[string, readonly SeriesSpec[], boolean]> = [
      ['deuteranopia', RED_GREEN, true],
      [
        'protanopia',
        [
          { name: 'Green', color: '#2ca02c' },
          { name: 'Orange', color: '#ff7f0e' },
        ],
        true,
      ],
      [
        'tritanopia',
        [
          { name: 'Blue', color: '#1f77b4' },
          { name: 'Green', color: '#2ca02c' },
        ],
        true,
      ],
      ['tritanopia', RED_GREEN, false],
      ['deuteranopia', DISTINCT, false],
      ['protanopia', DISTINCT, false],
      ['tritanopia', DISTINCT, false],
    ];
    for (const [profile, palette, expected] of cases) {
      const view = await loadCharts(ext, server, { ...CHART_SETTINGS, visionProfile: profile });
      await draws(view.page, palette);
      await view.step();
      expect(
        (await artifacts(view.page)).marked > 0,
        `${profile} ${palette.map((s) => s.name).join('/')}`,
      ).toBe(expected);
      await view.page.close();
    }
  });

  test('anomalous profiles are adapted too, with their M2 status unchanged (never upgraded)', async () => {
    for (const profile of ['deuteranomaly', 'protanomaly', 'tritanomaly', 'achromatopsia']) {
      const view = await loadCharts(ext, server, { ...CHART_SETTINGS, visionProfile: profile });
      await draws(view.page, REDS);
      await view.step();
      expect((await artifacts(view.page)).marked, profile).toBeGreaterThan(0);
      await view.page.close();
    }
  });

  test('switching the profile at run time re-plans the chart and removes it for normal vision', async () => {
    const view = await loadCharts(ext, server);
    await draws(view.page, RED_GREEN);
    await view.step();
    expect((await artifacts(view.page)).marked).toBeGreaterThan(0);
    await setSettings(ext.worker, { ...CHART_SETTINGS, visionProfile: 'normal' });
    await refresh(ext.worker, view.page);
    await settle(view.page);
    expect(await artifacts(view.page)).toEqual(NOTHING);
    await setSettings(ext.worker, { ...CHART_SETTINGS, visionProfile: 'deuteranopia' });
    await refresh(ext.worker, view.page);
    await settle(view.page);
    expect((await artifacts(view.page)).marked).toBeGreaterThan(0);
  });
});

test.describe('M6 stays out of charts', () => {
  test('a legend that looks like an error/success state gets no cue from the semantic layer', async () => {
    const view = await loadCharts(ext, server);
    await draw(view.page, 'line', {
      id: 'c',
      series: [
        { name: 'Errors', color: '#d62728' },
        { name: 'Success', color: '#2ca02c' },
      ],
      legend: 'svg',
    });
    await view.page.evaluate(() => {
      const legend = document.querySelector('#c .legend')!;
      legend.setAttribute('class', 'legend error');
      legend.setAttribute('role', 'alert');
      document
        .querySelectorAll('#c .legend-item')
        .forEach((item, i) => item.classList.add(i === 0 ? 'error' : 'success'));
    });
    await view.step();
    expect(
      await view.page.evaluate(() => document.querySelectorAll('#c [data-coloradapt-cue]').length),
    ).toBe(0);
  });
});

test.describe('structural limits', () => {
  test('10 series x 100 points: bounded work, stable output, identities distinct where color is not enough', async () => {
    const view = await loadCharts(ext, server);
    const tab10 = [
      '#1f77b4',
      '#ff7f0e',
      '#2ca02c',
      '#d62728',
      '#9467bd',
      '#8c564b',
      '#e377c2',
      '#7f7f7f',
      '#bcbd22',
      '#17becf',
    ];
    await draw(view.page, 'line', {
      id: 'c',
      series: tab10.map((color, i) => ({ name: `T${i}`, color })),
      legend: 'svg',
      points: 100,
    });
    await view.step();
    const counters = await chartCounters(view);
    expect(counters.chartsSupported).toBe(1);
    expect(counters.marksScanned).toBeLessThan(200);
    expect(counters.seriesAdapted).toBeGreaterThan(0);
    // dense lines (100 points) never get per-vertex markers
    expect((await looks(view.page, '#c path.series')).every((l) => l.markerMid === 'none')).toBe(
      true,
    );
    const first = await markup(view.page);
    for (let i = 0; i < 2; i += 1) {
      await refresh(ext.worker, view.page);
      await settle(view.page);
    }
    expect(await markup(view.page)).toBe(first);
    expect((await chartCounters(view)).chartPending).toBe(0);
  });

  test('12 series x 400 points: dash styles only, and honest when they run out', async () => {
    const view = await loadCharts(ext, server);
    // twelve reds: every pair conflicts, only five dash styles exist for dense lines => limited, nothing half-done
    const reds = Array.from({ length: 12 }, (_, i) => ({
      name: `R${i}`,
      color: `#${(200 + i).toString(16)}2828`,
    }));
    await draw(view.page, 'line', { id: 'c', series: reds, legend: 'svg', points: 400 });
    await view.step();
    expect((await artifacts(view.page)).marked).toBe(0);
    expect(await artifacts(view.page)).toEqual(OWNED_ONLY);
  });

  test('13 series are over the limit: left as drawn', async () => {
    const view = await loadCharts(ext, server);
    const reds = Array.from({ length: 13 }, (_, i) => ({
      name: `R${i}`,
      color: `#${(200 + i).toString(16)}2828`,
    }));
    await draw(view.page, 'line', { id: 'c', series: reds, legend: 'svg' });
    await view.step();
    expect(await artifacts(view.page)).toEqual(OWNED_ONLY);
  });

  test('a scatter over the mark budget is refused with bounded work', async () => {
    const view = await loadCharts(ext, server);
    await draw(view.page, 'scatter', { id: 's', series: RED_GREEN, legend: 'svg', points: 1100 });
    await view.step();
    const counters = await chartCounters(view);
    expect(counters.marksScanned).toBeLessThanOrEqual(2100);
    // an over-budget chart that is still recognized stays owned (M5 keeps away) but nothing is written
    expect(await artifacts(view.page)).toEqual(OWNED_ONLY);
  });

  test('a page full of charts is handled in structural passes, never left half-done', async () => {
    const view = await loadCharts(ext, server);
    for (let i = 0; i < 30; i += 1)
      await draw(view.page, 'line', { id: `c${i}`, series: SIX.slice(0, 3), legend: 'svg' });
    await view.step();
    await view.step();
    const counters = await chartCounters(view);
    expect(counters).toMatchObject({ chartsSupported: 30, chartPending: 0 });
    expect(
      await view.page.evaluate(
        () => document.querySelectorAll('.line-chart[data-coloradapt-chart-owned]').length,
      ),
    ).toBe(30);
  });
});
