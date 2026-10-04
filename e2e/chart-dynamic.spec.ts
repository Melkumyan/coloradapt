import { expect, test } from '@playwright/test';
import {
  launchExtension,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';
import {
  NOTHING,
  REDS,
  RED_GREEN,
  SIX,
  artifacts,
  chartCounters,
  draw,
  looks,
  loadCharts,
  markup,
} from './chart-kit';

/**
 * Charts that change: series appear and go, the chart is re-rendered or replaced, the palette
 * changes, data refreshes. All of it flows through the one M4 pipeline (no observer of the chart
 * layer's own); identities stay with their series; nothing is left behind (docs/CHARTS.md, "Dynamic charts").
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

const identity = (look: { dash: string; markerMid: string }) =>
  `${look.dash}|${look.markerMid.replace(/coloradapt-c\d+-/, 'coloradapt-')}`;
const series = async (page: Parameters<typeof looks>[0], id = 'c') =>
  (await looks(page, `#${id} path.series`)).map(identity);
const legend = async (page: Parameters<typeof looks>[0], id = 'c') =>
  (await looks(page, `#${id} g.legend-item .swatch`)).map((l) => l.dash);

test('a series appended: the others keep their identity, the new one is distinct, the legend follows, in one incremental pass', async () => {
  const view = await loadCharts(ext, server);
  const { page } = view;
  await draw(page, 'line', { id: 'c', series: REDS.slice(0, 2), legend: 'svg' });
  await view.step();
  const before = await series(page);
  expect(before[0]).toBe('none|none');
  expect(before[1]).not.toBe('none|none');

  await page.evaluate((s) => window.chartKit.addSeries('c', s), REDS[2]!);
  const delta = await view.step();
  expect(delta).toMatchObject({ incrementalPasses: 1, fullRescans: 0 });

  const after = await series(page);
  expect(after.slice(0, 2)).toEqual(before);
  expect(new Set(after).size).toBe(3);
  // legend: three samples, each with the dash of its series
  const samples = await legend(page);
  expect(samples).toHaveLength(3);
  expect(samples).toEqual((await looks(page, '#c path.series')).map((l) => l.dash));
});

test('a series removed: the others keep their identity and nothing of the removed one is left', async () => {
  const view = await loadCharts(ext, server);
  const { page } = view;
  await draw(page, 'line', { id: 'c', series: SIX, legend: 'svg', keys: true });
  await view.step();
  const before = await series(page);
  const defsBefore = (await artifacts(page)).defs;
  expect(defsBefore).toBe(1);

  await page.evaluate(() => window.chartKit.removeSeries('c', 'S3'));
  await view.step();
  const after = await series(page);
  expect(after).toEqual([before[0], before[1], before[3], before[4], before[5]]);
  // the legend lost the entry, the others still match their series
  expect(await legend(page)).toEqual((await looks(page, '#c path.series')).map((l) => l.dash));

  // removing the series that wore the marker removes the marker, and the owned <defs> with it
  await page.evaluate(() => window.chartKit.removeSeries('c', 'S6'));
  await view.step();
  expect((await artifacts(page)).defs).toBe(0);
  expect(
    await page.evaluate(() => document.querySelectorAll('[data-coloradapt-chart-node]').length),
  ).toBe(0);
});

test('a chart replaced by a re-render: the old artifacts are gone and the new chart is adapted the same way', async () => {
  const view = await loadCharts(ext, server);
  const { page } = view;
  const options = { id: 'c', series: SIX, legend: 'svg' } as const;
  await draw(page, 'line', options);
  await view.step();
  const first = await series(page);
  const owners = await page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll('[data-coloradapt-chart-owner]')].map((n) =>
        n.getAttribute('data-coloradapt-chart-owner'),
      ),
    ),
  ]);
  expect(owners).toHaveLength(1);

  await page.evaluate((o) => window.chartKit.replace('line', o), options);
  await view.step();
  const second = await series(page);
  expect(second).toEqual(first);
  const after = await page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll('[data-coloradapt-chart-owner]')].map((n) =>
        n.getAttribute('data-coloradapt-chart-owner'),
      ),
    ),
  ]);
  expect(after).toHaveLength(1);
  expect(after).not.toEqual(owners); // a new owner: nothing of the old chart's is reused
  expect((await artifacts(page)).defs).toBe(1);
  expect((await chartCounters(view)).chartsSupported).toBe(1);
});

test('a data update (only `d` changes) leaves identities, artifacts and the stylesheet untouched', async () => {
  const view = await loadCharts(ext, server);
  const { page } = view;
  await draw(page, 'line', { id: 'c', series: SIX, legend: 'svg' });
  await view.step();
  const html = await markup(page);
  const before = await series(page);
  for (let round = 0; round < 5; round += 1) {
    await page.evaluate(
      (r) =>
        window.chartKit.updateData(
          'c',
          1,
          Array.from({ length: 8 }, (_, k) => 40 + 10 * Math.sin(k + r)),
        ),
      round,
    );
  }
  await view.step();
  expect(await series(page)).toEqual(before);
  expect((await markup(page)).replace(/ d="[^"]*"/g, '')).toBe(html.replace(/ d="[^"]*"/g, ''));
});

test('a palette change: distinct colors drop the adaptation, the confusable ones bring it back with the same identities', async () => {
  const view = await loadCharts(ext, server);
  const { page } = view;
  await draw(page, 'line', { id: 'c', series: RED_GREEN, legend: 'svg' });
  await view.step();
  const before = await series(page);
  expect(before[1]).not.toBe('none|none');

  await page.evaluate(() => {
    window.chartKit.recolor('c', 0, '#0072b2');
    window.chartKit.recolor('c', 1, '#d55e00');
  });
  await view.step();
  expect(await series(page)).toEqual(['none|none', 'none|none']);
  expect((await artifacts(page)).marked).toBe(0);
  expect(
    await page.evaluate(
      () =>
        document
          .getElementById('coloradapt-stylesheet')
          ?.textContent?.includes('data-coloradapt-chart') ?? false,
    ),
  ).toBe(false);

  await page.evaluate(() => {
    window.chartKit.recolor('c', 0, '#d62728');
    window.chartKit.recolor('c', 1, '#2ca02c');
  });
  await view.step();
  expect(await series(page)).toEqual(before);
});

test('our own writes never start another pass: the page settles after one', async () => {
  const view = await loadCharts(ext, server);
  await draw(view.page, 'line', { id: 'c', series: SIX, legend: 'svg' });
  const first = await view.step();
  expect(first.incrementalPasses).toBe(1);
  const again = await view.step();
  expect(again).toMatchObject({ incrementalPasses: 0, fullRescans: 0 });
  expect((await view.diag()).charts.chartPending).toBe(0);
});

test('the real scheduler handles a chart that appears (no forced flush)', async () => {
  const view = await loadCharts(ext, server);
  await draw(view.page, 'line', { id: 'c', series: RED_GREEN, legend: 'svg' });
  await view.natural();
  expect((await series(view.page))[1]).not.toBe('none|none');
});

test('a chart that becomes visible later is adapted when it does', async () => {
  const view = await loadCharts(ext, server);
  const { page } = view;
  await page.evaluate(() => (document.getElementById('host')!.style.display = 'none'));
  await view.step();
  await draw(page, 'line', { id: 'c', series: RED_GREEN, legend: 'svg' });
  await view.step();
  expect((await artifacts(page)).marked).toBe(0); // not laid out: nothing can be said about it yet
  await page.evaluate(() => (document.getElementById('host')!.style.display = ''));
  await view.step();
  expect((await series(page))[1]).not.toBe('none|none');
});

test('retention: 100 charts created, adapted and removed leave no owner, def, rule or pending work', async () => {
  const view = await loadCharts(ext, server);
  const { page } = view;
  const base = await view.diag();
  for (let i = 0; i < 100; i += 1) {
    await draw(page, 'line', {
      id: `c${i}`,
      series: SIX.slice(0, 3 + (i % 4)),
      legend: 'svg',
      points: 4,
    });
    await view.step();
    await page.evaluate((id) => window.chartKit.remove(id), `c${i}`);
    await view.step();
  }
  const end = await view.diag();
  expect(end.charts).toMatchObject({
    chartOwners: 0,
    chartDefs: 0,
    chartOverlays: 0,
    chartRules: 0,
    chartPending: 0,
    chartsDetected: 0,
  });
  expect(end.trackedElements).toBe(base.trackedElements);
  expect(await artifacts(page)).toEqual(NOTHING);
  expect(end.charts.patternsCreated + end.charts.markersCreated).toBeGreaterThan(0);
});

test('re-rendering one container 50 times does not accumulate artifacts', async () => {
  const view = await loadCharts(ext, server);
  const { page } = view;
  const options = { id: 'c', series: SIX, legend: 'svg' } as const;
  await draw(page, 'line', options);
  await view.step();
  for (let i = 0; i < 50; i += 1) {
    await page.evaluate((o) => window.chartKit.replace('line', o), options);
    await view.step();
  }
  expect(await artifacts(page)).toMatchObject({ defs: 1, owned: 1 });
  expect((await view.diag()).charts).toMatchObject({
    chartOwners: 1,
    chartDefs: 1,
    chartPending: 0,
  });
});
