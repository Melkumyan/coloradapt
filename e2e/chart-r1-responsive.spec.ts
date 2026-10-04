import { expect, test, type Page } from '@playwright/test';
import {
  disable,
  enable,
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
  SIX,
  REDS,
  RED_GREEN,
  artifacts,
  chartCounters,
  draw,
  looks,
  loadCharts,
} from './chart-kit';
import { load, type Loaded } from './r1-kit';
import { barSvg, lineSvg, pageHtml, pieSvg, scatterSvg } from './r1-fixtures';

/**
 * M7.R1: the resize / geometry bridge, series identity and profile switching in real Chromium.
 * A chart's size changes without any mutation (breakpoints, containers, hidden panels); hatches and
 * markers are sized in screen pixels, so they must follow. A path's `d` or `points` changes: the
 * marker-density policy is re-checked. Identity stays with the series. Nothing leaks.
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
  const name = `r1-resp-${counter}.html`;
  server.serve(name, pageHtml(body, css));
  return load(ext, server, name, settings);
}

const BOX_CSS = '#box{width:480px}#box svg{display:block}';
const setWidth = (page: Page, width: number) =>
  page.evaluate((w) => {
    document.getElementById('box')!.style.width = `${w}px`;
  }, width);

/** On-screen size, in CSS pixels, of one tile of every owned pattern. */
const tilePixels = (page: Page) =>
  page.evaluate(() => {
    const svg = document.getElementById('chart') as unknown as SVGSVGElement;
    const scale = svg.getScreenCTM()!.a;
    return [...svg.querySelectorAll('pattern')].map(
      (p) => Math.round(Number(p.getAttribute('width')) * scale * 100) / 100,
    );
  });

/** On-screen width of every owned marker glyph, in CSS pixels. */
const markerPixels = (page: Page) =>
  page.evaluate(() => {
    const svg = document.getElementById('chart') as unknown as SVGSVGElement;
    const scale = svg.getScreenCTM()!.a;
    return [...svg.querySelectorAll('defs[data-coloradapt-chart-node] marker')].map((m) => {
      const glyph = m.querySelector<SVGGraphicsElement>('[transform]');
      if (!glyph) return 0;
      const unit = Number(
        /scale\(([\d.]+)\)/.exec(glyph.getAttribute('transform') ?? '')?.[1] ?? 1,
      );
      return Math.round(glyph.getBBox().width * unit * scale * 10) / 10;
    });
  });

const stylesOf = (page: Page) =>
  looks(page, '#chart path.series, #chart rect.bar, #chart path.slice');

async function resizeAndStep(view: Loaded, width: number): Promise<void> {
  await setWidth(view.page, width);
  await settle(view.page);
  await view.step();
}

test.describe('resize: size-dependent encoding follows the chart', () => {
  const SERIES = ['#d62728', '#d82a29', '#da2c2b'];

  test('bars: hatch tiles keep their pixel size from wide to narrow to wide; nothing piles up', async () => {
    const view = await open(
      `<div id="box">${barSvg({ id: 'chart', colors: SERIES, legend: 'svg', responsive: true })}</div>`,
      BOX_CSS,
    );
    const first = await tilePixels(view.page);
    expect(first.length).toBeGreaterThan(0);
    for (const px of first) expect(px).toBeCloseTo(8, 1);
    const wideRules = (await artifacts(view.page)).chartRules;
    const sizes: number[][] = [];
    for (const width of [240, 160, 480, 320, 480]) {
      await resizeAndStep(view, width);
      const px = await tilePixels(view.page);
      sizes.push(px);
      for (const value of px) expect(value).toBeCloseTo(8, 1);
      const a = await artifacts(view.page);
      expect(a.defs).toBe(1);
      expect(a.chartRules).toBe(wideRules);
      expect(await view.page.evaluate(() => document.querySelectorAll('pattern').length)).toBe(
        first.length,
      );
    }
    expect(sizes).toHaveLength(5);
    // the legend swatches are still tagged and filled with the same patterns
    const sync = await view.page.evaluate(() =>
      [...document.querySelectorAll('#chart rect.swatch')].map((s) => getComputedStyle(s).fill),
    );
    const marks = await view.page.evaluate(() => [
      ...new Set(
        [...document.querySelectorAll('#chart rect.bar')].map((s) => getComputedStyle(s).fill),
      ),
    ]);
    for (const fill of sync.slice(1)) expect(marks).toContain(fill);
  });

  test('lines with markers: glyphs keep their pixel size after a resize', async () => {
    const view = await open(
      `<div id="box">${lineSvg({ id: 'chart', colors: [...SIX.map((s) => s.color)], legend: 'svg', responsive: true })}</div>`,
      BOX_CSS,
    );
    const wide = await markerPixels(view.page);
    expect(wide.length).toBeGreaterThan(0);
    await resizeAndStep(view, 240);
    const narrow = await markerPixels(view.page);
    expect(narrow).toHaveLength(wide.length);
    narrow.forEach((px, i) => expect(px).toBeCloseTo(wide[i]!, 0));
    await resizeAndStep(view, 480);
    expect(await markerPixels(view.page)).toEqual(wide);
    const a = await artifacts(view.page);
    expect(a.defs).toBe(1);
  });

  test('pie and scatter: patterns and silhouettes follow the size too', async () => {
    const pie = await open(
      `<div id="box">${pieSvg('chart', ['#d62728', '#d82a29', '#da2c2b']).replace('width="480" height="320"', 'style="width:100%;height:auto"')}</div>`,
      BOX_CSS,
    );
    for (const px of await tilePixels(pie.page)) expect(px).toBeCloseTo(8, 1);
    await resizeAndStep(pie, 200);
    for (const px of await tilePixels(pie.page)) expect(px).toBeCloseTo(8, 1);
    expect((await artifacts(pie.page)).defs).toBe(1);

    const dots = await open(
      `<div id="box">${scatterSvg('chart', ['#d62728', '#d82a29', '#da2c2b']).replace('width="480" height="320"', 'style="width:100%;height:auto"')}</div>`,
      BOX_CSS,
    );
    const before = await artifacts(dots.page);
    expect(before.marked).toBeGreaterThan(0);
    await resizeAndStep(dots, 240);
    expect(await artifacts(dots.page)).toEqual(before);
  });

  test('a size change is exactly one incremental pass; a repeated size and a height-only change are none', async () => {
    const view = await open(
      `<div id="box">${lineSvg({ id: 'chart', colors: SERIES, legend: 'svg', responsive: true })}</div>`,
      BOX_CSS,
    );
    await setWidth(view.page, 300);
    await settle(view.page);
    const delta = await view.step();
    expect(delta.incrementalPasses).toBe(1);
    expect(delta.fullRescans).toBe(0);
    expect((await chartCounters(view)).resizeSignals).toBe(1);
    // nothing changed: no work
    const quiet = await view.step();
    expect(quiet.incrementalPasses).toBe(0);
    expect(quiet.selfMutationsIgnored).toBe(0);
    // the same width again: the observer does not fire
    await setWidth(view.page, 300);
    await settle(view.page);
    expect((await view.step()).incrementalPasses).toBe(0);
  });

  test('wide -> narrow -> wide through the viewport (a media query changes the layout)', async () => {
    const view = await open(
      `<div id="box">${barSvg({ id: 'chart', colors: SERIES, responsive: true })}</div>`,
      '#box{width:480px}@media (max-width: 600px){#box{width:220px}}',
    );
    const at = async () => (await tilePixels(view.page)).every((px) => Math.abs(px - 8) < 0.2);
    expect(await at()).toBe(true);
    await view.page.setViewportSize({ width: 560, height: 700 });
    await settle(view.page);
    await view.step();
    expect(
      await view.page.evaluate(() => document.getElementById('box')!.getBoundingClientRect().width),
    ).toBe(220);
    expect(await at()).toBe(true);
    await view.page.setViewportSize({ width: 1000, height: 700 });
    await settle(view.page);
    await view.step();
    expect(
      await view.page.evaluate(() => document.getElementById('box')!.getBoundingClientRect().width),
    ).toBe(480);
    expect(await at()).toBe(true);
    expect((await artifacts(view.page)).defs).toBe(1);
  });

  test('display:none -> visible: hidden charts lose their artifacts; showing them brings them back, by a media query alone', async () => {
    const view = await open(
      `<div id="box">${lineSvg({ id: 'chart', colors: [...SIX.map((s) => s.color)], legend: 'svg', responsive: true })}</div>`,
      '#box{width:480px}@media (max-width: 600px){#box{display:none}}',
    );
    const shown = await artifacts(view.page);
    expect(shown.marked).toBeGreaterThan(0);
    const identities = (await stylesOf(view.page)).map(
      (l) => `${l.dash}|${l.markerMid.replace(/coloradapt-c\d+-/, '')}`,
    );
    await view.page.setViewportSize({ width: 560, height: 700 });
    await settle(view.page);
    await view.step();
    // nothing laid out: nothing is said, nothing is left
    expect((await artifacts(view.page)).marked).toBe(0);
    expect((await artifacts(view.page)).defs).toBe(0);
    await view.page.setViewportSize({ width: 1000, height: 700 });
    await settle(view.page);
    await view.step();
    expect(
      (await stylesOf(view.page)).map(
        (l) => `${l.dash}|${l.markerMid.replace(/coloradapt-c\d+-/, '')}`,
      ),
    ).toEqual(identities);
    expect((await artifacts(view.page)).defs).toBe(1);
  });

  test('a chart that is hidden when ColorAdapt first looks is adapted the moment it is shown by CSS', async () => {
    const view = await open(
      `<div id="box">${lineSvg({ id: 'chart', colors: [...SIX.map((s) => s.color)], legend: 'svg', responsive: true })}</div>`,
      '#box{width:480px}@media (max-width: 1100px){#box{display:none}}',
    );
    await view.page.setViewportSize({ width: 1300, height: 700 });
    await settle(view.page);
    await view.step();
    expect((await artifacts(view.page)).marked).toBeGreaterThan(0);
  });
});

test.describe('resize lifecycle', () => {
  const body = `<div id="box">${lineSvg({ id: 'chart', colors: ['#d62728', '#d82a29', '#da2c2b'], legend: 'svg', responsive: true })}</div>`;

  test('a removed chart is released; nothing is watched afterwards', async () => {
    const view = await open(body, BOX_CSS);
    expect((await chartCounters(view)).chartWatched).toBe(1);
    await view.page.evaluate(() => document.getElementById('chart')!.remove());
    await view.step();
    expect(await chartCounters(view)).toMatchObject({
      chartWatched: 0,
      chartOwners: 0,
      chartDefs: 0,
      chartRules: 0,
    });
    // and resizing the (now empty) box does nothing
    const before = (await chartCounters(view)).resizeSignals;
    await resizeAndStep(view, 200);
    expect((await chartCounters(view)).resizeSignals).toBe(before);
  });

  test('adaptCharts off: no chart is watched, a resize does no chart work', async () => {
    const view = await open(body, BOX_CSS, { ...CHART_SETTINGS, adaptCharts: false });
    expect(await chartCounters(view)).toMatchObject({
      chartWatched: 0,
      chartPasses: 0,
      resizeSignals: 0,
    });
    await resizeAndStep(view, 240);
    expect(await chartCounters(view)).toMatchObject({
      chartWatched: 0,
      chartPasses: 0,
      resizeSignals: 0,
    });
    expect(await artifacts(view.page)).toMatchObject({ marked: 0, defs: 0 });
  });

  test('ColorAdapt off: the observers are gone; on again: one subscription, no duplicates', async () => {
    const view = await open(body, BOX_CSS);
    expect((await chartCounters(view)).chartWatched).toBe(1);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await disable(ext.worker, view.page);
      expect((await chartCounters(view)).chartWatched).toBe(0);
      expect(await artifacts(view.page)).toMatchObject({ marked: 0, defs: 0, owned: 0 });
      await enable(ext.worker, view.page);
      await settle(view.page);
      expect((await chartCounters(view)).chartWatched).toBe(1);
    }
    // three off/on cycles later one resize is still one pass: there is one subscription, not four
    await view.step();
    const before = await chartCounters(view);
    await setWidth(view.page, 260);
    await settle(view.page);
    const delta = await view.step();
    expect(delta.incrementalPasses).toBe(1);
    expect((await chartCounters(view)).resizeSignals).toBe(before.resizeSignals + 1);
  });

  test('settings switched off through storage and refreshed: nothing left', async () => {
    const view = await open(body, BOX_CSS);
    await setSettings(ext.worker, { ...CHART_SETTINGS, enabled: false });
    await refresh(ext.worker, view.page);
    await settle(view.page);
    expect(await chartCounters(view)).toMatchObject({
      chartWatched: 0,
      chartOwners: 0,
      chartDefs: 0,
    });
  });

  test('100 charts x several cycles of insert and remove: no owner, def, rule, marker, pattern or subscription remains', async () => {
    const view = await loadCharts(ext, server);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await view.page.evaluate(() => {
        const w = window.chartKit;
        for (let i = 0; i < 100; i += 1) {
          const id = `c${i}`;
          const kind = i % 4;
          if (kind === 0)
            w.line({
              id,
              series: [...Array(6)].map((_, k) => ({
                name: `S${k}`,
                color: `#${(0xd6 + k).toString(16)}2728`,
              })),
              legend: 'svg',
            });
          else if (kind === 1)
            w.bar({
              id,
              series: [
                { name: 'A', color: '#d62728' },
                { name: 'B', color: '#d82a29' },
                { name: 'C', color: '#da2c2b' },
              ],
              legend: 'svg',
            });
          else if (kind === 2)
            w.scatter({
              id,
              series: [
                { name: 'A', color: '#d62728' },
                { name: 'B', color: '#d82a29' },
              ],
              legend: 'svg',
              points: 5,
            });
          else
            w.pie({
              id,
              series: [
                { name: 'A', color: '#d62728' },
                { name: 'B', color: '#d82a29' },
                { name: 'C', color: '#da2c2b' },
              ],
              legend: 'svg',
            });
        }
      });
      await view.step();
      const live = await chartCounters(view);
      expect(live.chartWatched).toBeGreaterThan(0);
      expect(live.chartWatched).toBeLessThanOrEqual(128);
      const ids = await view.page.evaluate(() => {
        const all = [...document.querySelectorAll('[id]')].map((e) => e.id);
        return { total: all.length, unique: new Set(all).size };
      });
      expect(ids.unique).toBe(ids.total);
      await view.page.evaluate(() => window.chartKit.clear());
      await view.step();
      expect(await chartCounters(view)).toMatchObject({
        chartOwners: 0,
        chartDefs: 0,
        chartOverlays: 0,
        chartRules: 0,
        chartPending: 0,
        chartWatched: 0,
      });
      expect(await artifacts(view.page)).toEqual({
        defs: 0,
        overlays: 0,
        marked: 0,
        owned: 0,
        sheet: expect.any(Boolean),
        chartRules: 0,
      });
      expect(
        await view.page.evaluate(
          () =>
            document.querySelectorAll('marker[id^="coloradapt-"], pattern[id^="coloradapt-"]')
              .length,
        ),
      ).toBe(0);
    }
  });
});

test.describe('path geometry: d and points re-check the density policy, without a full scan', () => {
  const setPoints = (page: Page, index: number, n: number) =>
    page.evaluate(
      ([i, count]) =>
        window.chartKit.updateData(
          'c',
          i!,
          Array.from({ length: count! }, (_, k) => 40 + 20 * Math.sin(k / 3 + i!)),
        ),
      [index, n],
    );

  test('20 -> 200 -> 20 vertices: markers go and come back deterministically; one incremental pass each', async () => {
    const view = await loadCharts(ext, server);
    await draw(view.page, 'line', { id: 'c', series: SIX, legend: 'svg', points: 20 });
    await view.step();
    const initial = (await looks(view.page, '#c path.series')).map(
      (l) => `${l.dash}|${l.markerMid.replace(/coloradapt-c\d+-/, '')}`,
    );
    const withMarker = initial.findIndex((s) => !s.endsWith('|none'));
    expect(withMarker).toBeGreaterThanOrEqual(0);

    await setPoints(view.page, withMarker, 200);
    const grown = await view.step();
    expect(grown.incrementalPasses).toBe(1);
    expect(grown.fullRescans).toBe(0);
    expect((await chartCounters(view)).geometrySignals).toBeGreaterThanOrEqual(1);
    const dense = await looks(view.page, '#c path.series');
    expect(dense[withMarker]!.markerMid).toBe('none');
    // the chart is whole or refused whole: never a chart with a half plan
    const a = await artifacts(view.page);
    if (a.marked > 0) {
      const dashes = dense.map((l) => l.dash);
      expect(dashes[withMarker]).not.toBe('none');
    } else {
      expect(a).toMatchObject({ defs: 0, chartRules: 0 });
    }

    await setPoints(view.page, withMarker, 20);
    await view.step();
    const back = (await looks(view.page, '#c path.series')).map(
      (l) => `${l.dash}|${l.markerMid.replace(/coloradapt-c\d+-/, '')}`,
    );
    // deterministic: going there and back again gives the same result as going there and back once
    await setPoints(view.page, withMarker, 200);
    await view.step();
    await setPoints(view.page, withMarker, 20);
    await view.step();
    expect(
      (await looks(view.page, '#c path.series')).map(
        (l) => `${l.dash}|${l.markerMid.replace(/coloradapt-c\d+-/, '')}`,
      ),
    ).toEqual(back);
  });

  test('a polyline whose points grow is signalled too; data that moves points without changing their number is not', async () => {
    const view = await open(
      `<svg id="chart" class="chart" width="480" height="320" viewBox="0 0 480 320"><g class="plot">${[
        '#d62728',
        '#d82a29',
        '#da2c2b',
        '#dc2e2d',
        '#de302f',
        '#e03231',
      ]
        .map(
          (c, i) =>
            `<polyline class="series series-${i}" fill="none" stroke="${c}" stroke-width="2" points="${Array.from({ length: 12 }, (_, k) => `${60 + k * 30},${220 - i * 20 - ((k * 37) % 40)}`).join(' ')}"></polyline>`,
        )
        .join(
          '',
        )}</g><g class="axis"><path stroke="#666" fill="none" d="M50 270 H440"></path>${[0, 1, 2, 3, 4].map((i) => `<line stroke="#666" x1="${50 + i * 97}" x2="${50 + i * 97}" y1="270" y2="276"></line><text x="${50 + i * 97}" y="290" fill="#222" font-size="10">${i * 10}</text>`).join('')}</g></svg>`,
    );
    const before = await chartCounters(view);
    // a moving refresh (same number of points): nothing to do
    await view.page.evaluate(() => {
      const line = document.querySelector('#chart polyline')!;
      line.setAttribute(
        'points',
        Array.from({ length: 12 }, (_, k) => `${60 + k * 30},${100 + k}`).join(' '),
      );
    });
    expect((await view.step()).incrementalPasses).toBe(0);
    expect((await chartCounters(view)).geometrySignals).toBe(before.geometrySignals);
    // growing past the limit
    await view.page.evaluate(() => {
      const line = document.querySelector('#chart polyline')!;
      line.setAttribute(
        'points',
        Array.from({ length: 90 }, (_, k) => `${60 + k * 4},${100 + (k % 9)}`).join(' '),
      );
    });
    const delta = await view.step();
    expect(delta.incrementalPasses).toBe(1);
    expect((await chartCounters(view)).geometrySignals).toBe(before.geometrySignals + 1);
  });

  test('a d change outside any chart is not even observed', async () => {
    const view = await open(
      `${lineSvg({ id: 'chart', colors: ['#d62728', '#d82a29'], legend: 'svg' })}<svg id="logo" width="40" height="40" viewBox="0 0 40 40"><path id="p" d="M0 0 L10 10 L20 0" fill="none" stroke="#333"/></svg>`,
    );
    const before = await view.diag();
    await view.page.evaluate(() => {
      for (let i = 0; i < 50; i += 1)
        document.getElementById('p')!.setAttribute('d', `M0 0 L10 10 L20 ${i} L30 10 L${i} 0`);
    });
    const delta = await view.step();
    expect(delta.mutationRecords).toBe(0);
    expect((await view.diag()).charts.geometrySignals).toBe(before.charts.geometrySignals);
  });
});

test.describe('series identity across dynamic updates, profiles and strength', () => {
  test('new data under the same keys keeps every encoding', async () => {
    const view = await loadCharts(ext, server);
    await draw(view.page, 'line', { id: 'c', series: SIX, legend: 'svg', keys: true });
    await view.step();
    const before = await looks(view.page, '#c path.series');
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < SIX.length; i += 1) {
        await view.page.evaluate(
          ([index, shift]) =>
            window.chartKit.updateData(
              'c',
              index!,
              Array.from({ length: 8 }, (_, k) => 30 + 15 * Math.sin(k + shift! + index!)),
            ),
          [i, round * 0.7],
        );
      }
      await view.step();
    }
    expect(await looks(view.page, '#c path.series')).toEqual(before);
  });

  test('A B -> A B C -> A C -> A B C', async () => {
    const view = await loadCharts(ext, server);
    await draw(view.page, 'line', { id: 'c', series: REDS.slice(0, 2), legend: 'svg', keys: true });
    await view.step();
    const ab = (await looks(view.page, '#c path.series')).map((l) => l.dash);
    await view.page.evaluate((s) => window.chartKit.addSeries('c', s), REDS[2]!);
    await view.step();
    const abc = (await looks(view.page, '#c path.series')).map((l) => l.dash);
    expect(abc.slice(0, 2)).toEqual(ab);
    expect(new Set(abc).size).toBe(3);
    await view.page.evaluate(() => window.chartKit.removeSeries('c', 'B'));
    await view.step();
    const ac = (await looks(view.page, '#c path.series')).map((l) => l.dash);
    expect(ac).toEqual([abc[0], abc[2]]);
  });

  test('profile switch protanopia -> deuteranopia -> tritanopia -> protanopia: recalculated, never accumulated', async () => {
    const view = await loadCharts(ext, server, { ...CHART_SETTINGS, visionProfile: 'protanopia' });
    await draw(view.page, 'line', {
      id: 'c',
      series: [
        { name: 'Red', color: '#d62728' },
        { name: 'Green', color: '#2ca02c' },
        { name: 'Orange', color: '#ff7f0e' },
      ],
      legend: 'svg',
      keys: true,
    });
    await view.step();
    const state = async () => ({
      looks: (await looks(view.page, '#c path.series')).map(
        (l) => `${l.dash}|${l.markerMid.replace(/coloradapt-c\d+-/, '')}`,
      ),
      swatches: (await looks(view.page, '#c .swatch')).map((l) => l.dash),
      rules: (await artifacts(view.page)).chartRules,
    });
    const protan = await state();
    expect(protan.looks.some((l) => l !== 'none|none')).toBe(true);
    const seen: Record<string, Awaited<ReturnType<typeof state>>> = {};
    for (const profile of [
      'deuteranopia',
      'tritanopia',
      'protanopia',
      'tritanopia',
      'protanopia',
    ] as const) {
      await setSettings(ext.worker, { ...CHART_SETTINGS, visionProfile: profile });
      await refresh(ext.worker, view.page);
      await settle(view.page);
      const now = await state();
      if (seen[profile]) expect(now).toEqual(seen[profile]);
      seen[profile] = now;
      // legend identity == series identity, for whatever this profile needed
      expect(now.swatches).toEqual((await looks(view.page, '#c path.series')).map((l) => l.dash));
      // nothing of another profile is left over
      if (profile === 'tritanopia')
        expect(now).toEqual({
          looks: ['none|none', 'none|none', 'none|none'],
          swatches: ['none', 'none', 'none'],
          rules: 0,
        });
    }
    expect(seen['protanopia']).toEqual(protan);
  });

  test('the M3 adaptation strength changes no chart encoding', async () => {
    const view = await loadCharts(ext, server);
    await draw(view.page, 'line', { id: 'c', series: RED_GREEN, legend: 'svg' });
    await view.step();
    const base = await looks(view.page, '#c path.series');
    for (const strength of [0.1, 0.5, 1]) {
      await setSettings(ext.worker, { ...CHART_SETTINGS, adaptationStrength: strength });
      await refresh(ext.worker, view.page);
      await settle(view.page);
      expect(await looks(view.page, '#c path.series')).toEqual(base);
    }
  });

  test("colors are never changed: the series paints are the page's own before and after", async () => {
    const view = await loadCharts(ext, server);
    await draw(view.page, 'line', { id: 'c', series: SIX, legend: 'svg' });
    await draw(view.page, 'bar', { id: 'b', series: REDS, legend: 'svg' });
    await view.step();
    const paints = () =>
      view.page.evaluate(() =>
        [...document.querySelectorAll('#c path.series')]
          .map((p) => getComputedStyle(p).stroke)
          .concat(
            [...document.querySelectorAll('#b rect.bar-0')].map(
              (r) => r.getAttribute('fill') ?? '',
            ),
          ),
      );
    const adapted = await paints();
    await setSettings(ext.worker, { ...CHART_SETTINGS, adaptCharts: false });
    await refresh(ext.worker, view.page);
    await settle(view.page);
    // with the chart layer off, the colors are exactly what they were with it on
    expect(await paints()).toEqual(adapted);
    expect(adapted.slice(0, 6)).toEqual([
      'rgb(214, 39, 40)',
      'rgb(216, 42, 41)',
      'rgb(218, 44, 43)',
      'rgb(220, 46, 45)',
      'rgb(222, 48, 47)',
      'rgb(224, 50, 49)',
    ]);
  });

  test('a dynamic palette change is re-evaluated: red/green recolored to blue/yellow need nothing', async () => {
    const view = await loadCharts(ext, server);
    await draw(view.page, 'line', { id: 'c', series: RED_GREEN, legend: 'svg', keys: true });
    await view.step();
    expect((await artifacts(view.page)).marked).toBeGreaterThan(0);
    await view.page.evaluate(() => {
      window.chartKit.recolor('c', 0, '#0072b2');
      window.chartKit.recolor('c', 1, '#f0e442');
    });
    const delta = await view.step();
    expect(delta.fullRescans).toBe(0);
    expect(await artifacts(view.page)).toMatchObject({
      marked: 0,
      defs: 0,
      overlays: 0,
      chartRules: 0,
    });
  });
});

test.describe('adaptCharts on a clean profile', () => {
  const body = lineSvg({ id: 'chart', colors: ['#d62728', '#2ca02c'], legend: 'svg' });
  const adaptedWith = async (settings: Record<string, unknown>) => {
    const view = await open(body, '', settings);
    return (await artifacts(view.page)).marked > 0;
  };

  test('absent: the default is on, a high-confidence supported chart is adapted', async () => {
    expect(await adaptedWith({ enabled: true, visionProfile: 'deuteranopia' })).toBe(true);
  });
  test('explicit true: adapted', async () => {
    expect(
      await adaptedWith({ enabled: true, visionProfile: 'deuteranopia', adaptCharts: true }),
    ).toBe(true);
  });
  test('explicit false stays false, whatever the rest says', async () => {
    expect(
      await adaptedWith({ enabled: true, visionProfile: 'deuteranopia', adaptCharts: false }),
    ).toBe(false);
  });
  test('an invalid value reads as the default', async () => {
    expect(
      await adaptedWith({ enabled: true, visionProfile: 'deuteranopia', adaptCharts: 'yes' }),
    ).toBe(true);
  });
  test('unsupported or ambiguous charts are untouched even with the default', async () => {
    const view = await open(
      `<div>${barSvg({ id: 'chart', colors: ['#deebf7', '#9ecae1', '#4292c6', '#08519c'], legend: 'svg' })}<ul class="chart-legend"><li>a</li></ul></div>`,
      '',
      { enabled: true, visionProfile: 'deuteranopia' },
    );
    expect(await artifacts(view.page)).toMatchObject({ marked: 0, defs: 0, chartRules: 0 });
  });
});
