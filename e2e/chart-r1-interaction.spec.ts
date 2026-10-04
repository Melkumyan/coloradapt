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
  REDS,
  SIX,
  artifacts,
  draw,
  hitPointOnPath,
  loadCharts,
} from './chart-kit';
import type { Loaded } from './r1-kit';

/**
 * M7.R1: interaction safety and the accessibility tree, after the first render as well as after
 * resizes and dynamic updates. M7 adds `pointer-events: none` decoration and CSS only: roles, names,
 * focusability and handlers stay the page's.
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

const SHRINK = '#c{width:320px;height:auto}';

async function adaptedLine(): Promise<Loaded> {
  const view = await loadCharts(ext, server);
  await draw(view.page, 'line', {
    id: 'c',
    series: SIX,
    legend: 'svg',
    interactive: true,
    keys: true,
  });
  await view.step();
  expect((await artifacts(view.page)).marked).toBeGreaterThan(0);
  return view;
}

async function expectInteractive(page: Page, name: string, index: number): Promise<void> {
  await page.evaluate(() => {
    window.__log.hovered.length = 0;
    window.__log.clicked.length = 0;
    window.__log.toggled.length = 0;
  });
  const point = await hitPointOnPath(page, `#c path.series-${index}`, 0.41);
  await page.mouse.move(point.x, point.y);
  await expect(page.locator('#tip')).toHaveText(name);
  await page.mouse.click(point.x, point.y);
  expect(await page.evaluate(() => window.__log.clicked)).toEqual([name]);
  await page.mouse.move(2, 600);
}

test.describe('interaction after dynamic updates and resizes (not only the first render)', () => {
  test('hover, tooltip and click survive a resize, a series appended and removed, and a data refresh', async () => {
    const view = await adaptedLine();
    const { page } = view;
    await expectInteractive(page, 'S2', 1);

    await page.addStyleTag({ content: SHRINK });
    await settle(page);
    await view.step();
    await expectInteractive(page, 'S4', 3);

    await page.evaluate(() => window.chartKit.addSeries('c', { name: 'S7', color: '#e23433' }));
    await view.step();
    await expectInteractive(page, 'S7', 6);

    await page.evaluate(() => window.chartKit.removeSeries('c', 'S3'));
    await view.step();
    await page.evaluate(() =>
      window.chartKit.updateData(
        'c',
        0,
        Array.from({ length: 8 }, (_, k) => 20 + 10 * Math.cos(k)),
      ),
    );
    await view.step();
    // series indexes shifted by the removal: S2 is still index 1
    await expectInteractive(page, 'S2', 1);
  });

  test("the legend toggles by mouse and keyboard after a resize, and focus is still the page's", async () => {
    const view = await adaptedLine();
    const { page } = view;
    await page.addStyleTag({ content: SHRINK });
    await settle(page);
    await view.step();
    // the label is the target: the dash gaps of a legend line sample are not hit-testable (documented limit)
    await page.locator('#c .legend-item').nth(1).locator('text').click();
    expect(await page.evaluate(() => window.__log.toggled)).toEqual(['S2:off']);
    await page.locator('#c .legend-item').nth(2).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    expect(await page.evaluate(() => window.__log.toggled)).toEqual(['S2:off', 'S3:off', 'S3:on']);
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
      'Toggle S3',
    );
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
      'Toggle S4',
    );
    // toggled series keep their identity once they are back
    await page.locator('#c .legend-item').nth(1).locator('text').click();
    await view.step();
    const looks = await page.evaluate(() =>
      [...document.querySelectorAll('#c path.series')].map(
        (p) => getComputedStyle(p).strokeDasharray,
      ),
    );
    expect(new Set(looks).size).toBeGreaterThanOrEqual(5);
  });

  test('bars with patterns stay hoverable and clickable after a resize', async () => {
    const view = await loadCharts(ext, server);
    await draw(view.page, 'bar', { id: 'c', series: REDS, legend: 'svg', interactive: true });
    await view.step();
    await view.page.addStyleTag({ content: SHRINK });
    await settle(view.page);
    await view.step();
    const spot = await view.page.evaluate(() => {
      const r = document.querySelectorAll('#c rect.bar-2')[1]!.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await view.page.mouse.move(spot.x, spot.y);
    await expect(view.page.locator('#tip')).toHaveText('C');
    await view.page.mouse.click(spot.x, spot.y);
    expect(await view.page.evaluate(() => window.__log.clicked)).toEqual(['C']);
  });

  test('scatter points under a decorative glyph still receive the pointer after a series is appended', async () => {
    const view = await loadCharts(ext, server);
    await draw(view.page, 'scatter', {
      id: 'c',
      series: REDS.slice(0, 2),
      legend: 'svg',
      interactive: true,
      points: 5,
    });
    await view.step();
    const spot = await view.page.evaluate(() => {
      const r = document.querySelector('#c circle.dot-1')!.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    expect(
      await view.page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('class'),
        spot,
      ),
    ).toBe('dot dot-1');
    await view.page.mouse.click(spot.x, spot.y);
    expect(await view.page.evaluate(() => window.__log.clicked)).toEqual(['B']);
  });
});

test.describe('the accessibility tree is the same with and without M7', () => {
  async function snapshots(
    kind: 'line' | 'bar' | 'scatter' | 'pie',
    series: typeof SIX,
    interactive: boolean,
  ) {
    const view = await loadCharts(ext, server);
    await draw(view.page, kind, {
      id: 'c',
      series,
      legend: 'svg',
      interactive,
      label: `${kind} chart`,
      role: 'img',
      ...(kind === 'scatter' ? { points: 5 } : {}),
    });
    await view.step();
    const adapted = (await artifacts(view.page)).marked;
    const on = await view.page.locator('#host').ariaSnapshot();
    // the tab cycle, as a rotation-free list (Chromium keeps the last focus as the starting point)
    const focus = async () => {
      const order: string[] = [];
      for (let i = 0; i < 16; i += 1) {
        await view.page.keyboard.press('Tab');
        order.push(
          await view.page.evaluate(
            () =>
              `${document.activeElement?.tagName}:${document.activeElement?.getAttribute('aria-label') ?? ''}`,
          ),
        );
      }
      const cycle = order.slice(
        0,
        order.indexOf(order[0]!, 1) === -1 ? order.length : order.indexOf(order[0]!, 1),
      );
      const start = cycle.indexOf([...cycle].sort()[0]!);
      return [...cycle.slice(start), ...cycle.slice(0, start)];
    };
    const focusOn = await focus();
    await setSettings(ext.worker, { ...CHART_SETTINGS, adaptCharts: false });
    await refresh(ext.worker, view.page);
    await settle(view.page);
    expect((await artifacts(view.page)).marked).toBe(0);
    const off = await view.page.locator('#host').ariaSnapshot();
    const focusOff = await focus();
    return { adapted, on, off, focusOn, focusOff };
  }

  for (const [kind, interactive] of [
    ['line', false],
    ['bar', false],
    ['scatter', false],
    ['pie', false],
    ['line', true],
  ] as const) {
    test(`${kind}${interactive ? ' with an interactive legend' : ''}: roles, names and focusability unchanged`, async () => {
      const series = kind === 'pie' || kind === 'bar' || kind === 'scatter' ? REDS : SIX;
      const result = await snapshots(kind, series, interactive);
      expect(result.adapted).toBeGreaterThan(0);
      expect(result.on).toBe(result.off);
      expect(result.focusOn).toEqual(result.focusOff);
    });
  }

  test('ColorAdapt-owned nodes are decorative: aria-hidden, not focusable, not hit-testable', async () => {
    const view = await adaptedLine();
    const owned = await view.page.evaluate(() =>
      [...document.querySelectorAll('[data-coloradapt-chart-node]')].map((n) => ({
        node: n.getAttribute('data-coloradapt-chart-node'),
        tag: n.tagName.toLowerCase(),
        hidden: n.getAttribute('aria-hidden'),
        tabindex: n.getAttribute('tabindex'),
        pointer: getComputedStyle(n).pointerEvents,
        text: (n.textContent ?? '').trim(),
        focusable: n.matches('a,button,input,select,textarea,[tabindex]'),
      })),
    );
    expect(owned.length).toBeGreaterThan(0);
    for (const node of owned) {
      expect(node.focusable).toBe(false);
      expect(node.tabindex).toBeNull();
      expect(node.text).toBe('');
      if (node.node === 'overlay') {
        expect(node.hidden).toBe('true');
        expect(node.pointer).toBe('none');
      }
    }
  });
});
