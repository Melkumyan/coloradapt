import { expect, test } from '@playwright/test';
import {
  launchExtension,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';
import { RED_GREEN, SIX, artifacts, draw, hitPointOnPath, loadCharts, looks } from './chart-kit';

/**
 * Charts stay interactive: hover and tooltip, click handlers, legend toggling by mouse and keyboard,
 * focus. M7 only adds `pointer-events: none` decoration and CSS; it wraps nothing, replaces nothing
 * and listens to nothing, so what the page wired up keeps working (docs/CHARTS.md, "Interaction safety").
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

async function adaptedLine() {
  const view = await loadCharts(ext, server);
  await draw(view.page, 'line', { id: 'c', series: SIX, legend: 'svg', interactive: true });
  await view.step();
  expect((await artifacts(view.page)).marked).toBeGreaterThan(0);
  return view;
}

test("hovering an adapted line shows the page's tooltip for that series", async () => {
  const { page } = await adaptedLine();
  for (const [index, name] of [
    [1, 'S2'],
    [5, 'S6'],
  ] as const) {
    const point = await hitPointOnPath(page, `#c path.series-${index}`, 0.37);
    await page.mouse.move(point.x, point.y);
    await expect(page.locator('#tip')).toBeVisible();
    await expect(page.locator('#tip')).toHaveText(name);
    await page.mouse.move(2, 400); // leave
    await expect(page.locator('#tip')).toBeHidden();
  }
});

test('clicking an adapted line still reaches its handler', async () => {
  const { page } = await adaptedLine();
  const point = await hitPointOnPath(page, '#c path.series-2', 0.5);
  await page.mouse.click(point.x, point.y);
  expect(await page.evaluate(() => window.__log.clicked)).toEqual(['S3']);
});

test('the legend toggles a series by click and by keyboard, and keeps focus', async () => {
  const { page } = await adaptedLine();
  const item = page.locator('#c .legend-item').nth(2);
  await item.click();
  expect(await page.evaluate(() => window.__log.toggled)).toEqual(['S3:off']);
  expect(await page.locator('#c path.series-2').getAttribute('visibility')).toBe('hidden');

  await page.locator('#c .legend-item').nth(3).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  expect(await page.evaluate(() => window.__log.toggled)).toEqual(['S3:off', 'S4:off', 'S4:on']);
  // focus is still on the legend item the page made focusable (nothing of ours took or stole it)
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
    'Toggle S4',
  );
  // Tab moves through the page's own legend items only: none of our nodes is focusable
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
    'Toggle S5',
  );
});

test('a series toggled off and on again keeps its non-color identity', async () => {
  const view = await adaptedLine();
  const { page, step } = view;
  const before = await looks(page, '#c path.series');
  await page.locator('#c .legend-item').nth(1).click();
  await step(); // hidden: the series leaves the chart's analysis and its identity is remembered
  await page.locator('#c .legend-item').nth(1).click();
  await step();
  expect(await looks(page, '#c path.series')).toEqual(before);
});

test('bars with a pattern fill are still hit by the pointer and still clickable', async () => {
  const view = await loadCharts(ext, server);
  await draw(view.page, 'bar', { id: 'b', series: RED_GREEN, legend: 'svg', interactive: true });
  await view.step();
  const box = await view.page.evaluate(() => {
    const rect = [...document.querySelectorAll('#b rect.bar-1')][1]!;
    const r = rect.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await view.page.mouse.move(box.x, box.y);
  await expect(view.page.locator('#tip')).toHaveText('Green');
  await view.page.mouse.click(box.x, box.y);
  expect(await view.page.evaluate(() => window.__log.clicked)).toEqual(['Green']);
});

test('scatter points under a decorative glyph still receive the pointer', async () => {
  const view = await loadCharts(ext, server);
  await draw(view.page, 'scatter', {
    id: 's',
    series: RED_GREEN,
    legend: 'svg',
    interactive: true,
    points: 5,
  });
  await view.step();
  const target = await view.page.evaluate(() => {
    const dot = document.querySelector('#s circle.dot-1')!;
    const r = dot.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  // the glyph is on top of the point, and the pointer goes through it
  const hit = await view.page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('class'),
    target,
  );
  expect(hit).toBe('dot dot-1');
  await view.page.mouse.click(target.x, target.y);
  expect(await view.page.evaluate(() => window.__log.clicked)).toEqual(['Green']);
});

test('pie slices keep tooltips with patterns', async () => {
  const view = await loadCharts(ext, server);
  await draw(view.page, 'pie', {
    id: 'p',
    series: [
      { name: 'One', color: '#d62728' },
      { name: 'Two', color: '#d82a29' },
      { name: 'Three', color: '#da2c2b' },
    ],
    legend: 'svg',
    interactive: true,
  });
  await view.step();
  const spot = await view.page.evaluate(() => {
    const slice = document.querySelector('#p path.slice-1') as SVGGeometryElement;
    const r = slice.getBoundingClientRect();
    // a point inside the slice: halfway between its box center and the pie center is inside any wedge of this layout
    return { x: r.left + r.width * 0.6, y: r.top + r.height * 0.55 };
  });
  const name = await view.page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-s'),
    spot,
  );
  expect(name).not.toBeNull();
  await view.page.mouse.move(spot.x, spot.y);
  await expect(view.page.locator('#tip')).toHaveText(name!);
});
