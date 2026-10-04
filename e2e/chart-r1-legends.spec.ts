import { expect, test, type Page } from '@playwright/test';
import {
  launchExtension,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';
import { CHART_SETTINGS, artifacts } from './chart-kit';
import { load, type Loaded } from './r1-kit';
import {
  GREEN,
  LEGEND_VARIANTS,
  RED,
  barSvg,
  lineSvg,
  pageHtml,
  pieSvg,
  type LegendVariant,
} from './r1-fixtures';

/**
 * M7.R1: the HTML legend guard in real Chromium. A chart that may have a legend M7 cannot keep in
 * step is refused whole and left byte-identical; the same chart with no legend evidence keeps the
 * normal policy; a legend that comes, goes or moves later changes the verdict, in one incremental
 * pass. Interactive HTML legends are never touched.
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

const CHART = lineSvg({ id: 'chart', colors: [RED, GREEN], names: ['Red', 'Green'] });

async function open(body: string, css = ''): Promise<Loaded> {
  counter += 1;
  const name = `r1-legend-${counter}.html`;
  server.serve(name, pageHtml(body, css));
  return load(ext, server, name, CHART_SETTINGS);
}

const dashes = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#chart path.series')].map(
      (p) => getComputedStyle(p).strokeDasharray,
    ),
  );

/** Refused whole: claimed (M5 keeps off), nothing written, the series are drawn as the page drew them. */
async function expectRefused(page: Page): Promise<void> {
  const a = await artifacts(page);
  expect(a).toMatchObject({ defs: 0, overlays: 0, marked: 0, chartRules: 0, owned: 1 });
  expect(await dashes(page)).toEqual(['none', 'none']);
}
async function expectAdapted(page: Page): Promise<void> {
  const a = await artifacts(page);
  expect(a.marked).toBeGreaterThan(0);
  expect(a.owned).toBe(1);
  const d = await dashes(page);
  expect(d[0]).toBe('none');
  expect(d[1]).not.toBe('none');
}

const PLACEMENTS: ReadonlyArray<readonly [string, (legend: string) => string, string]> = [
  ['below', (legend) => `<div class="card">${CHART}<div class="after">${legend}</div></div>`, ''],
  ['above', (legend) => `<div class="card"><div class="before">${legend}</div>${CHART}</div>`, ''],
  [
    'beside',
    (legend) =>
      `<div class="row"><div class="col">${CHART}</div><div class="col">${legend}</div></div>`,
    '.row{display:flex;gap:16px;align-items:flex-start}',
  ],
];

for (const variant of LEGEND_VARIANTS) {
  for (const [placement, wrap, css] of PLACEMENTS) {
    test(`HTML legend "${variant.name}" ${placement} the chart: refused whole, the legend untouched`, async () => {
      const { page } = await open(wrap(variant.html), variant.css + css);
      await expectRefused(page);
      // the legend is exactly what the page wrote: no chart node or tag anywhere near it
      expect(
        await page.evaluate(
          () =>
            document.querySelectorAll(
              '[data-coloradapt-chart-node],[data-coloradapt-chart-mark],[data-coloradapt-chart-legend]',
            ).length,
        ),
      ).toBe(0);
    });
  }
}

test.describe('no legend evidence: the normal policy', () => {
  const NEUTRAL: ReadonlyArray<readonly [string, string, string]> = [
    ['nothing around it', '', ''],
    ['prose', '<p>Revenue grew 12% year over year, driven by the red and green regions.</p>', ''],
    ['a title and a caption', '<h3>Revenue</h3><p class="note">Source: finance</p>', ''],
    ['a key-metric tile', '<div class="key-metric">12%</div>', ''],
    [
      'one status dot',
      '<p><span style="display:inline-block;width:8px;height:8px;background:#d62728"></span> Live</p>',
      '',
    ],
    [
      'colored status words that are not series colors',
      '<p><span style="color:#c0392b">Error</span> <span style="color:#27ae60">OK</span></p>',
      '',
    ],
    ['plain buttons', '<button>Export</button> <button>Share</button>', ''],
  ];
  for (const [name, around, css] of NEUTRAL) {
    test(`${name}: the chart is adapted`, async () => {
      const { page } = await open(`<div class="card">${CHART}<div>${around}</div></div>`, css);
      await expectAdapted(page);
    });
  }
});

test.describe('a legend that comes, goes and moves', () => {
  const variant = LEGEND_VARIANTS[3] as LegendVariant; // CSS ::before swatches: nothing in the DOM says "legend"

  test('appears next to an adapted chart: the adaptation is removed in one incremental pass', async () => {
    const view = await open(
      `<div class="card" id="card">${CHART}<div id="slot"></div></div>`,
      variant.css,
    );
    await expectAdapted(view.page);
    await view.page.evaluate((html) => {
      document.getElementById('slot')!.innerHTML = html;
    }, variant.html);
    const delta = await view.step();
    expect(delta).toMatchObject({ fullRescans: 0 });
    expect(delta.incrementalPasses).toBeGreaterThanOrEqual(1);
    await expectRefused(view.page);
  });

  test('goes away: the refused chart is adapted again, from the removal alone', async () => {
    const view = await open(
      `<div class="card" id="card">${CHART}<div id="slot">${variant.html}</div></div>`,
      variant.css,
    );
    await expectRefused(view.page);
    await view.page.evaluate(() => document.getElementById('slot')!.remove());
    const delta = await view.step();
    expect(delta.fullRescans).toBe(0);
    await expectAdapted(view.page);
  });

  test('changes its swatch colors (gray status dots become series colors): re-read', async () => {
    const view = await open(
      `<div class="card">${CHART}<div id="slot"><p><i class="d" style="background:#888"></i>a</p><p><i class="d" style="background:#888"></i>b</p></div></div>`,
      '.d{display:inline-block;width:10px;height:10px;margin-right:4px}',
    );
    await expectAdapted(view.page);
    await view.page.evaluate(
      ([a, b]) => {
        const dots = document.querySelectorAll<HTMLElement>('#slot .d');
        dots[0]!.style.background = a!;
        dots[1]!.style.background = b!;
      },
      [RED, GREEN],
    );
    await view.step();
    await expectRefused(view.page);
  });

  test('responsive layout: the legend moves between columns; the verdict follows it and never desynchronizes', async () => {
    const view = await open(
      `<div class="row"><div class="col" id="a">${CHART}</div><div class="col" id="b"><div id="holder">${variant.html}</div></div></div>`,
      `${variant.css}.row{display:flex;gap:16px}`,
    );
    await expectRefused(view.page);
    // the legend leaves the chart's neighbourhood entirely (a different part of the page): the chart is on its own
    await view.page.evaluate(() => {
      const far = document.createElement('section');
      far.innerHTML = '<div><div><div><div id="far"></div></div></div></div>';
      document.body.append(far);
      document.getElementById('far')!.append(document.getElementById('holder')!);
    });
    await view.step();
    // either it is no longer next to the chart (adapted) or it still is (refused): never adapted next to a legend
    const a = await artifacts(view.page);
    const near = await view.page.evaluate(() => {
      const chart = document.getElementById('chart')!;
      const holder = document.getElementById('holder')!;
      const scope = chart.parentElement!.parentElement!;
      return scope.contains(holder);
    });
    if (near) expect(a.marked).toBe(0);
    else expect(a.marked).toBeGreaterThan(0);
    // and back
    await view.page.evaluate(() =>
      document.getElementById('b')!.append(document.getElementById('holder')!),
    );
    await view.step();
    await expectRefused(view.page);
  });
});

test.describe('interactive HTML legends are never touched', () => {
  test('toggle buttons keep role, name, focus, click and keyboard behavior (the chart is refused)', async () => {
    const script = `
      window.__toggles = [];
      document.querySelectorAll('.btn').forEach((b) => {
        b.addEventListener('click', () => { b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); window.__toggles.push(b.textContent.trim()); });
      });`;
    counter += 1;
    const name = `r1-legend-${counter}.html`;
    const variant = LEGEND_VARIANTS.find((v) => v.name === 'button legend item')!;
    server.serve(
      name,
      pageHtml(`<div class="card">${CHART}${variant.html}</div>`, variant.css, script),
    );
    const { page } = await load(ext, server, name, CHART_SETTINGS);
    await expectRefused(page);
    const before = await page.evaluate(() =>
      [...document.querySelectorAll('.btn')].map((b) =>
        [
          b.tagName,
          b.getAttribute('aria-pressed'),
          b.textContent,
          b.getAttributeNames().join(),
        ].join('|'),
      ),
    );
    await page.locator('.btn').first().click();
    await page.locator('.btn').nth(1).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    expect(
      await page.evaluate(() => (window as unknown as { __toggles: string[] }).__toggles),
    ).toEqual(['Red', 'Green', 'Green']);
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe('Green');
    const after = await page.evaluate(() =>
      [...document.querySelectorAll('.btn')].map((b) =>
        [
          b.tagName,
          b.getAttribute('aria-pressed'),
          b.textContent,
          b.getAttributeNames().join(),
        ].join('|'),
      ),
    );
    expect(after.map((s) => s.split('|')[0])).toEqual(before.map((s) => s.split('|')[0]));
    // nothing of the chart layer is on the legend (the color layer's own id tag is a different feature)
    expect(after.join()).not.toContain('coloradapt-chart');
  });
});

test.describe('refusal is atomic inside the SVG too', () => {
  test('five series, four legend items: the whole chart is left alone', async () => {
    const colors = ['#d62728', '#d82a29', '#da2c2b', '#dc2e2d', '#de302f'];
    const svg = lineSvg({ id: 'chart', colors, legend: 'svg', keys: true }).replace(
      /<g class="legend-item"[^>]*>(?:(?!<g class="legend-item")[\s\S])*<\/g><\/g><\/svg>$/,
      '</g></svg>',
    );
    const { page } = await open(svg);
    const a = await artifacts(page);
    expect(a).toMatchObject({ defs: 0, overlays: 0, marked: 0, chartRules: 0 });
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('#chart path.series')].map(
          (p) => getComputedStyle(p).strokeDasharray,
        ),
      ),
    ).toEqual(['none', 'none', 'none', 'none', 'none']);
  });

  test('a series the legend does not know (keys disagree) is not guessed at', async () => {
    const svg = lineSvg({
      id: 'chart',
      colors: ['#d62728', '#d82a29', '#da2c2b'],
      legend: 'svg',
      keys: true,
    }).replace(
      /<line class="swatch" data-series="Series 3"/,
      '<line class="swatch" data-series="other"',
    );
    const { page } = await open(svg);
    expect(await artifacts(page)).toMatchObject({ defs: 0, overlays: 0, marked: 0, chartRules: 0 });
  });

  test('pie and bars with an HTML legend are refused too', async () => {
    const pie = await open(
      `<div class="card">${pieSvg('chart', ['#d62728', '#d82a29', '#da2c2b'], false)}<ul class="chart-legend"><li>One</li><li>Two</li><li>Three</li></ul></div>`,
    );
    expect((await artifacts(pie.page)).marked).toBe(0);
    const bars = await open(
      `<div class="card">${barSvg({ id: 'chart', colors: [RED, GREEN] })}<ul class="legend"><li>Red</li><li>Green</li></ul></div>`,
    );
    expect(await artifacts(bars.page)).toMatchObject({ marked: 0, defs: 0 });
  });
});
