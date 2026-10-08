import { expect, test } from '@playwright/test';
import {
  disable,
  launchExtension,
  refresh,
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
  blockColors,
  chartCounters,
  draw,
  looks,
  loadCharts,
  markerShape,
  markup,
  pixels,
  pristine,
  vertices,
  type ChartOptions,
} from './chart-kit';

/**
 * M7 in a real Chromium: what the chart layer draws is what the browser paints. Computed styles,
 * rendered pixels, the accessibility tree and the DOM before/after are the evidence; the plan alone
 * is never enough (docs/CHARTS.md). Nothing sleeps.
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

/** A flat line at y = 270 - 2 * value: easy to sample along. */
const flat = (value: number) => Array.from({ length: 8 }, () => value);
const colorNear = (actual: string, hex: string, tolerance = 6) => {
  const want = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const got = (/\d+/g.exec(actual) ? (actual.match(/\d+/g) ?? []) : []).map(Number);
  return got.length === 3 && got.every((v, i) => Math.abs(v - want[i]!) <= tolerance);
};
const transitions = (row: readonly string[]) =>
  row.reduce((n, color, i) => (i > 0 && color !== row[i - 1] ? n + 1 : n), 0);

async function ready(settings: Record<string, unknown> = CHART_SETTINGS) {
  const loaded = await loadCharts(ext, server, settings);
  return {
    ...loaded,
    draw: async (kind: Parameters<typeof draw>[1], opts: ChartOptions) => {
      const id = await draw(loaded.page, kind, opts);
      await loaded.step();
      return id;
    },
  };
}

test.describe('line charts: dash style', () => {
  test('a dashed series is dashed in the pixels, the solid one is not, and the legend sample shows the same dashes', async () => {
    const { page, draw: add } = await ready();
    await add('line', {
      id: 'c',
      series: [
        { name: 'Red', color: '#d62728', values: flat(40) },
        { name: 'Green', color: '#2ca02c', values: flat(70) },
      ],
      legend: 'svg',
    });

    const [red, green] = await looks(page, '#c path.series');
    expect(red!.dash).toBe('none');
    expect(green!.dash).not.toBe('none');

    const solidRow = (await pixels(page, 'c', 60, 190, 300, 1))[0]!;
    const dashedRow = (await pixels(page, 'c', 60, 130, 300, 1))[0]!;
    expect(transitions(solidRow)).toBeLessThanOrEqual(2);
    expect(transitions(dashedRow)).toBeGreaterThanOrEqual(10);

    // legend: the sample of the second series carries the same dash array
    const swatches = await looks(page, '#c .legend-item line.swatch');
    expect(swatches[1]!.dash).toBe(green!.dash);
    expect(swatches[0]!.dash).toBe('none');
    // and it is visible there too (the sample is 20 units long: at least two dashes)
    const swatchRow = (await pixels(page, 'c', 330, 8 + 16 + 5, 20, 1))[0]!;
    expect(transitions(swatchRow)).toBeGreaterThanOrEqual(2);
  });

  test('six series: six distinct identities, five of them told apart by dash, one by a marker', async () => {
    const { page, draw: add } = await ready();
    await add('line', {
      id: 'c',
      series: SIX.map((s, i) => ({ ...s, values: flat(20 + i * 22) })),
      legend: 'svg',
    });

    const marks = await looks(page, '#c path.series');
    const identities = marks.map((m) => `${m.dash}|${m.markerMid}`);
    expect(new Set(identities).size).toBe(6);
    expect(marks.filter((m) => m.markerMid !== 'none')).toHaveLength(1);

    // chart mark identity == legend identity: same dash, same marker geometry
    const swatches = await looks(page, '#c .legend-item line.swatch');
    for (let i = 0; i < 6; i += 1) {
      expect(swatches[i]!.dash).toBe(marks[i]!.dash);
      const chartMarker =
        marks[i]!.markerMid !== 'none' ? await markerShape(page, marks[i]!.markerMid) : null;
      const legendMarker =
        swatches[i]!.markerStart !== 'none'
          ? await markerShape(page, swatches[i]!.markerStart)
          : null;
      expect(legendMarker).toBe(chartMarker);
    }
  });

  test('a box legend swatch of a line series gets a line sample drawn over it: the same dash pattern and marker shape', async () => {
    const { page, draw: add } = await ready();
    await add('line', {
      id: 'c',
      series: SIX.map((s, i) => ({ ...s, values: flat(20 + i * 22) })),
      legend: 'svg',
      legendKind: 'box',
    });
    const info = await page.evaluate(() => {
      const ratio = (dash: string) => {
        const [a, b] = dash
          .split(/[ ,px]+/)
          .filter(Boolean)
          .map(Number);
        return a && b ? Math.round((a / b) * 100) / 100 : null;
      };
      const marks = [...document.querySelectorAll('#c path.series')].map((p) =>
        getComputedStyle(p),
      );
      const samples = [
        ...document.querySelectorAll('#c [data-coloradapt-chart-node="overlay"] line'),
      ].map((l) => ({ style: getComputedStyle(l), marker: l.getAttribute('style') ?? '' }));
      const shape = (ref: string) => {
        const id = /#([^")]+)/.exec(ref)?.[1];
        return id
          ? (document.getElementById(id)?.querySelector('path')?.getAttribute('d') ?? null)
          : null;
      };
      return {
        count: samples.length,
        pattern: samples.map((s) => ratio(s.style.strokeDasharray)),
        chart: marks.slice(1, 5).map((m) => ratio(m.strokeDasharray)),
        sampleMarker: samples[4] ? shape(samples[4].style.markerStart) : null,
        chartMarker: shape(marks[5]!.markerMid),
        sixthDash: samples[5]?.style.strokeDasharray ?? null,
      };
    });
    // one sample per adapted series (five), none for the series left as drawn
    expect(info.count).toBe(5);
    expect(info.pattern.slice(0, 4)).toEqual(info.chart);
    expect(info.sampleMarker).not.toBeNull();
    expect(info.sampleMarker).toBe(info.chartMarker);
    // they sit over their swatches, are decorative, and the swatches themselves are untouched
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('#c rect.swatch')].every(
          (r) => !r.hasAttribute('style') && !r.hasAttribute('stroke-dasharray'),
        ),
      ),
    ).toBe(true);
  });

  test('a marker is painted at the vertices, in the series color, and sits on the line', async () => {
    const { page, draw: add } = await ready();
    await add('line', {
      id: 'c',
      series: SIX.map((s, i) => ({ ...s, values: flat(20 + i * 22) })),
      legend: 'none',
    });
    const withMarker = (await looks(page, '#c path.series')).findIndex(
      (m) => m.markerMid !== 'none',
    );
    expect(withMarker).toBe(5);
    const vs = await vertices(page, `#c path.series-${withMarker}`);
    const middle = vs[3]!;
    const above = (
      await pixels(page, 'c', Math.round(middle.x), Math.round(middle.y) - 2, 1, 1)
    )[0]![0]!;
    expect(colorNear(above, '#e03231', 10)).toBe(true);
    // the same offset above a vertex of a series without a marker is background
    const plain = (await vertices(page, '#c path.series-0'))[3]!;
    const none = (
      await pixels(page, 'c', Math.round(plain.x), Math.round(plain.y) - 2, 1, 1)
    )[0]![0]!;
    expect(none).toBe('rgb(255, 255, 255)');
  });

  test('palettes everybody can tell apart are left exactly as drawn', async () => {
    const { page, draw: add } = await ready();
    await add('line', { id: 'c', series: DISTINCT, legend: 'svg' });
    expect(await artifacts(page)).toEqual({ ...NOTHING, owned: 1 });
    expect((await looks(page, '#c path.series')).every((m) => m.dash === 'none')).toBe(true);
  });

  test('charts that already use dashes, markers or direct labels are not over-adapted', async () => {
    const view = await ready();
    const scenarios: Array<[string, ChartOptions]> = [
      [
        'dashed',
        {
          id: 'dashed',
          series: [{ ...REDS[0]! }, { ...REDS[1]!, dash: '6 3' }, { ...REDS[2]!, dash: '2 2' }],
          legend: 'svg',
        },
      ],
      [
        'marked',
        {
          id: 'marked',
          series: [
            { ...REDS[0]!, marker: 'circle' },
            { ...REDS[1]!, marker: 'square' },
            { ...REDS[2]!, dash: '4 4' },
          ],
          legend: 'none',
        },
      ],
      ['direct', { id: 'direct', series: REDS, legend: 'none', direct: true }],
    ];
    for (const [, options] of scenarios) {
      await view.draw('line', options);
      expect((await artifacts(view.page)).marked, options.id).toBe(0);
      await view.page.evaluate((id) => window.chartKit.remove(id), options.id);
      await view.page.evaluate(() => undefined);
      await view.step();
    }
  });
});

test.describe('bars, scatter, pie: patterns and shapes', () => {
  test('bars of the confusable series get a hatch pattern in the pixels, and the legend swatch has the same one', async () => {
    const { page, draw: add } = await ready();
    await add('bar', { id: 'b', series: RED_GREEN, legend: 'svg' });
    const rects = await page.evaluate(() =>
      [...document.querySelectorAll('#b rect.bar')].map((r) => ({
        x: +r.getAttribute('x')!,
        y: +r.getAttribute('y')!,
        w: +r.getAttribute('width')!,
        h: +r.getAttribute('height')!,
      })),
    );
    const plain = rects[0]!;
    const hatched = rects[1]!;
    expect(
      (await blockColors(page, 'b', Math.round(plain.x) + 4, Math.round(plain.y) + 4, 16)).size,
    ).toBe(1);
    expect(
      (await blockColors(page, 'b', Math.round(hatched.x) + 4, Math.round(hatched.y) + 4, 16)).size,
    ).toBeGreaterThanOrEqual(2);

    const fills = await looks(page, '#b rect.bar');
    expect(fills[0]!.fill).toMatch(/^rgb/);
    expect(fills[1]!.fill).toMatch(/^url\(/);
    const swatches = await looks(page, '#b .legend-item rect.swatch');
    expect(swatches[1]!.fill).toBe(fills[1]!.fill);
    // the swatch (10x10) shows the pattern too
    expect((await blockColors(page, 'b', 330, 8 + 16, 10)).size).toBeGreaterThanOrEqual(2);
    expect((await blockColors(page, 'b', 330, 8, 10)).size).toBe(1);
  });

  test('scatter series get another silhouette as CSS on their own points; no node is added, the points do not move', async () => {
    const { page, draw: add } = await ready();
    await add('scatter', { id: 's', series: RED_GREEN, legend: 'svg', points: 6 });
    const dots = await page.evaluate(() =>
      [...document.querySelectorAll('#s circle.dot')].map((c) => ({
        cx: +c.getAttribute('cx')!,
        cy: +c.getAttribute('cy')!,
        cls: c.getAttribute('class')!,
        clip: getComputedStyle(c).clipPath,
      })),
    );
    const first = dots.find((d) => d.cls.includes('dot-0'))!;
    const second = dots.find((d) => d.cls.includes('dot-1'))!;
    expect(first.clip).toBe('none');
    expect(second.clip).toMatch(/^polygon\(/);
    // the diamond covers fewer pixels than the disc it is cut from (and it is still there)
    const painted = async (d: { cx: number; cy: number }) =>
      (await pixels(page, 's', Math.round(d.cx) - 5, Math.round(d.cy) - 5, 10, 10))
        .flat()
        .filter((color) => color !== 'rgb(255, 255, 255)').length;
    const disc = await painted(first);
    const diamond = await painted(second);
    expect(disc).toBeGreaterThanOrEqual(30);
    expect(diamond).toBeGreaterThanOrEqual(15);
    expect(diamond).toBeLessThan(disc);
    // no node of ours in the chart, geometry untouched
    expect((await artifacts(page)).overlays).toBe(0);
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('#s circle.dot')].every(
          (c) => c.getAttribute('r') === '4' && c.hasAttribute('cx') && c.hasAttribute('cy'),
        ),
      ),
    ).toBe(true);
    // the legend dot of the second series has the same silhouette
    const legend = await looks(page, '#s .legend-item circle.swatch');
    expect(
      await page.evaluate(
        () => getComputedStyle(document.querySelectorAll('#s circle.swatch')[1]!).clipPath,
      ),
    ).toBe(second.clip);
    expect(legend).toHaveLength(2);
  });

  test('a pie with an SVG legend gets patterns; a donut too; slices keep their order and angles', async () => {
    const { page, draw: add } = await ready();
    await add('pie', { id: 'p', series: REDS, legend: 'svg' });
    await add('pie', { id: 'd', series: REDS, legend: 'svg', donut: true });
    for (const id of ['p', 'd']) {
      const fills = await looks(page, `#${id} path.slice`);
      expect(new Set(fills.map((f) => f.fill)).size).toBe(3);
      expect(fills.filter((f) => f.fill.startsWith('url(')).length).toBeGreaterThanOrEqual(2);
      const swatches = await looks(page, `#${id} .legend-item rect.swatch`);
      expect(swatches.map((s) => s.fill)).toEqual(fills.map((f) => f.fill));
    }
  });
});

test.describe('geometry the page controls', () => {
  test('a chart scaled by CSS gets hatches and markers the same size in pixels', async () => {
    const view = await ready();
    await view.page.addStyleTag({ content: '#host svg { width: 960px; height: 640px; }' });
    await view.draw('bar', { id: 'b', series: RED_GREEN, legend: 'svg' });
    // the SVG is drawn at 2x: a tile of 8 screen pixels is 4 user units
    expect(
      await view.page.evaluate(() => document.querySelector('#b pattern')?.getAttribute('width')),
    ).toBe('4');
    expect(
      await view.page.evaluate(() =>
        document.querySelector('#b pattern g')?.getAttribute('transform'),
      ),
    ).toBe('scale(0.5)');
  });

  test('a <base href> does not break the references to our markers and patterns', async () => {
    const view = await ready();
    await view.page.evaluate(() =>
      document.head.insertAdjacentHTML('afterbegin', '<base href="http://127.0.0.1:9/elsewhere/">'),
    );
    await view.draw('bar', { id: 'b', series: RED_GREEN, legend: 'svg' });
    await view.draw('line', {
      id: 'l',
      series: SIX.map((s, i) => ({ ...s, values: flat(20 + i * 22) })),
      legend: 'none',
    });
    const rects = await view.page.evaluate(() =>
      [...document.querySelectorAll('#b rect.bar')].map((r) => ({
        x: +r.getAttribute('x')!,
        y: +r.getAttribute('y')!,
        w: +r.getAttribute('width')!,
        h: +r.getAttribute('height')!,
      })),
    );
    const hatched = rects[1]!;
    expect(
      (await blockColors(view.page, 'b', Math.round(hatched.x) + 4, Math.round(hatched.y) + 4, 16))
        .size,
    ).toBeGreaterThanOrEqual(2);
    const vs = await vertices(view.page, '#l path.series-5');
    const above = (
      await pixels(view.page, 'l', Math.round(vs[3]!.x), Math.round(vs[3]!.y) - 2, 1, 1)
    )[0]![0]!;
    expect(colorNear(above, '#e03231', 10)).toBe(true);
  });
});

test.describe('reversibility, idempotency, accessibility', () => {
  const rich = async () => {
    const view = await ready();
    await view.draw('line', { id: 'l', series: SIX, legend: 'svg', interactive: true });
    // a legend of boxes: the dash and marker are shown as a sample line drawn over each box
    await view.draw('line', { id: 'lb', series: REDS, legend: 'svg', legendKind: 'box' });
    await view.draw('bar', { id: 'b', series: RED_GREEN, legend: 'svg' });
    await view.draw('scatter', { id: 's', series: RED_GREEN, legend: 'svg', points: 5 });
    await view.draw('pie', { id: 'p', series: REDS, legend: 'svg' });
    return view;
  };

  test('OFF restores the exact original chart: no node, attribute, rule, marker, pattern or sheet is left', async () => {
    const view = await rich();
    const adapted = await artifacts(view.page);
    expect(adapted.marked).toBeGreaterThan(0);
    expect(adapted.defs).toBeGreaterThan(0);
    expect(adapted.overlays).toBeGreaterThan(0);
    const original = await pristine(view.page);
    await disable(ext.worker, view.page);
    await settle(view.page);
    // (ids M3/M5 gave elements while analyzing are bookkeeping of the older layers, not of this one)
    expect((await markup(view.page)).replace(/ data-coloradapt-(id|s)="[^"]*"/g, '')).toBe(
      original,
    );
    expect(await artifacts(view.page)).toEqual(NOTHING);
  });

  test('refresh x3 changes nothing: no duplicate patterns, markers, overlays or dashes', async () => {
    const view = await rich();
    const html = await markup(view.page);
    const css = await view.page.evaluate(
      () => document.getElementById('coloradapt-stylesheet')!.textContent,
    );
    const first = await artifacts(view.page);
    for (let i = 0; i < 3; i += 1) {
      await refresh(ext.worker, view.page);
      await settle(view.page);
      expect(await artifacts(view.page)).toEqual(first);
    }
    expect(await markup(view.page)).toBe(html);
    expect(
      await view.page.evaluate(() => document.getElementById('coloradapt-stylesheet')!.textContent),
    ).toBe(css);
    // dash arrays are not "longer" after a refresh
    const dashes = await looks(view.page, '#l path.series');
    expect(dashes.every((d) => d.dash.split(',').length <= 4)).toBe(true);
  });

  test('the accessibility tree is the same with and without the chart layer', async () => {
    const view = await rich();
    const on = await view.page.locator('body').ariaSnapshot();
    await view.page.evaluate(() => undefined);
    await disable(ext.worker, view.page);
    await settle(view.page);
    const off = await view.page.locator('body').ariaSnapshot();
    expect(on).toBe(off);
    expect(on).toContain('Toggle S1'); // the interactive legend is still there, as the page wrote it
  });

  test('overlays are decorative: hidden from assistive technology, not hit-testable, not focusable', async () => {
    const view = await rich();
    const info = await view.page.evaluate(() =>
      [...document.querySelectorAll('[data-coloradapt-chart-node="overlay"]')].map((n) => ({
        hidden: n.getAttribute('aria-hidden'),
        pe: getComputedStyle(n).pointerEvents,
        focusable: n.querySelector('[tabindex]') !== null || n.hasAttribute('tabindex'),
      })),
    );
    expect(info.length).toBeGreaterThan(0);
    expect(info.every((o) => o.hidden === 'true' && o.pe === 'none' && !o.focusable)).toBe(true);
  });
});

test('chart-owned SVGs are not recolored by M5, even a one-series chart', async () => {
  const view = await ready();
  await view.draw('line', {
    id: 'one',
    series: [{ name: 'Only', color: '#c0392b' }],
    legend: 'none',
  });
  const ownedRules = await view.page.evaluate(() => {
    // a rule reaches an element through its token (M12.5)
    return document.querySelectorAll('#one[data-coloradapt-s], #one [data-coloradapt-s]').length;
  });
  expect(ownedRules).toBe(0);
  expect((await artifacts(view.page)).owned).toBe(1);
});

test('counters report what happened (no telemetry, only gauges and counts)', async () => {
  const view = await ready();
  await view.draw('line', { id: 'c', series: SIX, legend: 'svg' });
  const counters = await chartCounters(view);
  expect(counters).toMatchObject({
    chartsDetected: 1,
    chartsSupported: 1,
    seriesAnalyzed: 6,
    seriesAdapted: 5,
    legendsMapped: 1,
    chartNotApplied: 0,
    chartPending: 0,
  });
  expect(counters.markersCreated).toBeGreaterThanOrEqual(2);
});
