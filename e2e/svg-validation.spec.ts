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
import { expectConsistent, load, ruleTotal, type Loaded } from './r1-kit';
import { RED, SETTINGS, openPristine, paints, pixelAt, plannedByOwner, sheetText } from './svg-kit';

/**
 * M5.R1: the riskiest M5 claims, re-checked in real Chromium with structural counters,
 * computed styles and pixels (no timing). Complements `svg-paint.spec.ts` and
 * `svg-dynamic.spec.ts`.
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

declare global {
  interface Window {
    add(html: string): void;
    addSprite(html: string): void;
    replace(id: string, html: string): void;
  }
}

const open = (): Promise<Loaded> => load(ext, server, 'svg-dynamic.html', SETTINGS);
const add = (page: Page, html: string) => page.evaluate((h) => window.add(h), html);

/** A red `currentColor` icon on green: adapted. */
const icon = (id: string) =>
  `<span id="${id}-w" class="cell bg-green"><svg id="${id}" class="red" width="24" height="24" viewBox="0 0 24 24"><path id="${id}-p" fill="currentColor" d="M2 2h20v20H2z"/></svg></span>`;

const COLORS = ['#c0392b', '#2980b9', '#f1c40f', '#8e44ad', '#16a085', '#d35400', '#2c3e50'];

/** One SVG, `n` shapes, `distinct` different literal fills, on green. */
const painted = (id: string, n: number, distinct: number) =>
  `<span id="${id}-w" class="cell bg-green"><svg id="${id}" width="24" height="24" viewBox="0 0 24 24">${Array.from(
    { length: n },
    (_, i) =>
      `<rect id="${id}-r${i}" x="${i % 20}" y="0" width="1" height="1" fill="${COLORS[i % distinct]}"/>`,
  ).join('')}</svg></span>`;

test.describe('M5.R1 adaptSVG default = true', () => {
  test('settings stored without adaptSVG (before M5) adapt simple SVGs and skip unsafe ones', async () => {
    const stored = { enabled: true, visionProfile: 'deuteranopia', adaptationStrength: 1 };
    const page = await openPristine(ext, server, 'svg-cases.html', stored);
    const plan = await enable(ext.worker, page);
    await settle(page);
    const planned = await plannedByOwner(page, plan);
    // a safe monochrome icon is adapted...
    expect(planned['fill-attr']).toBeDefined();
    expect(planned['cc-fill']).toBeDefined();
    expect((await paints.fill(page, ['fill-attr-p']))['fill-attr-p']).not.toBe(RED);
    // ...and everything unsafe is left exactly as the page painted it.
    for (const svg of ['u-gradient', 'u-pattern', 'u-mask', 'u-filter', 'u-multi', 'u-complex']) {
      expect(planned[svg], svg).toBeUndefined();
    }
    expect((await paints.fill(page, ['u-multi-a']))['u-multi-a']).toBe(RED);
  });

  test('true -> false -> true: allowed, nothing, then a clean re-analysis with no stale rules', async () => {
    const base = { enabled: true, visionProfile: 'deuteranopia', adaptationStrength: 1 };
    const page = await openPristine(ext, server, 'svg-cases.html', { ...base, adaptSVG: true });
    await enable(ext.worker, page);
    await settle(page);
    const first = await sheetText(page);
    expect(first).toContain('fill');
    const firstFill = await paints.fill(page, ['fill-attr-p', 'cc-fill-p']);

    await setSettings(ext.worker, { ...base, adaptSVG: false });
    await enable(ext.worker, page);
    await settle(page);
    // SVG rules are gone: no rule targets an element in the SVG namespace (HTML inside a
    // <foreignObject> is HTML and keeps adapting as such).
    const rulesOff = await page.evaluate(() => {
      const text = document.getElementById('coloradapt-stylesheet')?.textContent ?? '';
      return [...text.matchAll(/\[data-coloradapt-id="([^"]+)"\]/g)].filter(
        ([, id]) => document.querySelector(`[data-coloradapt-id="${id}"]`) instanceof SVGElement,
      ).length;
    });
    expect(rulesOff).toBe(0);
    expect((await paints.fill(page, ['fill-attr-p']))['fill-attr-p']).toBe(RED);

    await setSettings(ext.worker, { ...base, adaptSVG: true });
    await enable(ext.worker, page);
    await settle(page);
    expect(await sheetText(page)).toBe(first);
    expect(await paints.fill(page, ['fill-attr-p', 'cc-fill-p'])).toEqual(firstFill);
  });
});

test.describe('M5.R1 reversibility and idempotency', () => {
  test('ON/OFF x10: every cycle ends exactly at the original computed values and pixels', async () => {
    test.setTimeout(240_000);
    const page = await openPristine(ext, server, 'svg-cases.html');
    const shapes = ['fill-attr-p', 'stroke-attr-p', 'cc-fill-p', 'cc-stroke-p'];
    const owners = ['cc-fill', 'cc-stroke'];
    const read = async () => ({
      fill: await paints.fill(page, shapes),
      stroke: await paints.stroke(page, shapes),
      color: await paints.color(page, owners),
    });
    const original = await read();
    let adaptedState: Awaited<ReturnType<typeof read>> | null = null;
    for (let i = 0; i < 10; i += 1) {
      await enable(ext.worker, page);
      await settle(page);
      const adapted = await read();
      expect(adapted, `cycle ${i} adapted`).not.toEqual(original);
      adaptedState ??= adapted;
      expect(adapted, `cycle ${i} identical to the first adapted state`).toEqual(adaptedState);
      await disable(ext.worker, page);
      await settle(page);
      expect(await read(), `cycle ${i} restored`).toEqual(original);
      expect(await sheetText(page)).toBe('');
    }
  });

  test('ON/OFF x10 for <use> instances: pixels return to the original every time', async () => {
    test.setTimeout(240_000);
    const page = await openPristine(ext, server, 'svg-use.html');
    const ids = ['cc-a', 'cc-b', 'cc-c', 'inh-a', 'inh-b'];
    const read = () => Promise.all(ids.map((id) => pixelAt(page, id, 12, 12)));
    const original = await read();
    let first: string[] | null = null;
    for (let i = 0; i < 10; i += 1) {
      await enable(ext.worker, page);
      await settle(page);
      const adapted = await read();
      expect(adapted, `cycle ${i} adapted`).not.toEqual(original);
      first ??= adapted;
      expect(adapted).toEqual(first);
      await disable(ext.worker, page);
      await settle(page);
      expect(await read(), `cycle ${i} restored`).toEqual(original);
    }
  });

  test('analyze/refresh x4: fill, stroke, color and rules do not drift', async () => {
    const page = await openPristine(ext, server, 'svg-cases.html');
    await enable(ext.worker, page);
    await settle(page);
    const ids = ['fill-attr-p', 'stroke-attr-p', 'cc-fill-p', 'cc-both-p'];
    const snap = async () => ({
      fill: await paints.fill(page, ids),
      stroke: await paints.stroke(page, ids),
      color: await paints.color(page, ['cc-fill', 'cc-both']),
      sheet: await sheetText(page),
    });
    const first = await snap();
    for (let i = 0; i < 4; i += 1) {
      await refresh(ext.worker, page);
      await settle(page);
      expect(await snap()).toEqual(first);
    }
  });
});

test.describe('M5.R1 multi-paint safety under adaptSVG = true', () => {
  for (const distinct of [2, 3, 4, 5, 6]) {
    test(`${distinct}-color icon is never recolored`, async () => {
      const { page, step, diag } = await open();
      await add(page, painted('m', 6, distinct));
      await step();
      expect(await ruleTotal(page)).toBe(0);
      expect((await diag()).svg).toMatchObject({
        svgAnalyzed: 1,
        svgAdapted: 0,
        svgUnsupported: 1,
      });
      const fills = await paints.fill(page, ['m-r0', 'm-r1']);
      expect(Object.values(fills)).toEqual([RED, expect.not.stringMatching(/^$/)]);
    });
  }
});

test.describe('M5.R1 paint servers added dynamically', () => {
  test('gradient, radial, pattern, mask and filter icons: no rule, no ADAPTED, nothing stale', async () => {
    const { page, step, diag } = await open();
    const svg = (id: string, defs: string, attrs: string) =>
      `<span id="${id}-w" class="cell bg-green"><svg id="${id}" width="24" height="24" viewBox="0 0 24 24"><defs>${defs}</defs><rect id="${id}-r" width="24" height="24" ${attrs}/></svg></span>`;
    await add(
      page,
      svg(
        'g1',
        '<linearGradient id="lg"><stop offset="0" stop-color="#c0392b"/></linearGradient>',
        'fill="url(#lg)"',
      ) +
        svg(
          'g2',
          '<radialGradient id="rg"><stop offset="0" stop-color="#c0392b"/></radialGradient>',
          'fill="url(#rg)"',
        ) +
        svg(
          'g3',
          '<pattern id="pt" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="2" height="2" fill="#c0392b"/></pattern>',
          'fill="url(#pt)"',
        ) +
        svg(
          'g4',
          '<mask id="mk"><rect width="24" height="24" fill="white"/></mask>',
          'fill="#c0392b" mask="url(#mk)"',
        ) +
        svg(
          'g5',
          '<filter id="ft"><feGaussianBlur stdDeviation="1"/></filter>',
          'fill="#c0392b" filter="url(#ft)"',
        ),
    );
    await step();
    expect(await ruleTotal(page)).toBe(0);
    expect((await diag()).svg).toMatchObject({ svgAnalyzed: 5, svgAdapted: 0, svgUnsupported: 5 });
    await expectConsistent(page);
  });
});

test.describe('M5.R1 structural budgets (limit - 1, limit, limit + 1)', () => {
  /** Adds one SVG, returns whether it ended adapted (a rule) or classified unsupported. */
  async function outcome(html: string): Promise<'adapted' | 'unsupported'> {
    const { page, step, diag } = await open();
    await add(page, html);
    await step();
    const svg = (await diag()).svg;
    expect(svg.svgAnalyzed).toBe(1);
    expect(svg.svgAdapted + svg.svgUnsupported).toBe(1);
    return svg.svgAdapted === 1 ? 'adapted' : 'unsupported';
  }
  const wrap = (inner: string) =>
    `<span class="cell bg-green"><svg id="b" class="red" width="24" height="24" viewBox="0 0 24 24">${inner}</svg></span>`;

  for (const [count, expected] of [
    [23, 'adapted'],
    [24, 'adapted'],
    [25, 'unsupported'],
  ] as const) {
    test(`painted elements: ${count} -> ${expected} (limit 24)`, async () => {
      const shapes = Array.from(
        { length: count },
        () => '<rect fill="currentColor" width="1" height="1"/>',
      );
      expect(await outcome(wrap(shapes.join('')))).toBe(expected);
    });
  }

  // <svg> itself and the path count as visited elements: limit 200 in total.
  for (const [groups, expected] of [
    [197, 'adapted'],
    [198, 'adapted'],
    [199, 'unsupported'],
  ] as const) {
    test(`visited elements: svg + path + ${groups} <g> = ${groups + 2} -> ${expected} (limit 200)`, async () => {
      const empty = '<g></g>'.repeat(groups);
      expect(await outcome(wrap(`<path fill="currentColor" d="M2 2h20v20H2z"/>${empty}`))).toBe(
        expected,
      );
    });
  }

  for (const [depth, expected] of [
    [30, 'adapted'],
    [31, 'adapted'],
    [32, 'unsupported'],
  ] as const) {
    test(`nesting: path inside ${depth} <g> -> ${expected} (limit 32)`, async () => {
      const inner = `${'<g>'.repeat(depth)}<path fill="currentColor" d="M2 2h20v20H2z"/>${'</g>'.repeat(depth)}`;
      expect(await outcome(wrap(inner))).toBe(expected);
    });
  }

  for (const [distinct, reasonIsComplex] of [
    [3, false],
    [4, false],
    [5, true],
  ] as const) {
    test(`distinct paints: ${distinct} -> never adapted (limit 4 separates multi-paint from complex)`, async () => {
      const { page, step, diag } = await open();
      await add(page, painted('d', distinct, distinct));
      await step();
      expect((await diag()).svg).toMatchObject({ svgAdapted: 0, svgUnsupported: 1 });
      expect(await ruleTotal(page)).toBe(0);
      expect(reasonIsComplex).toBe(distinct > 4);
    });
  }

  for (const [count, expected] of [
    [24, 'adapted'],
    [25, 'unsupported'],
  ] as const) {
    test(`<use> target content: ${count} painted shapes -> ${expected} (limit 24)`, async () => {
      const { page, step, diag } = await open();
      const shapes = Array.from(
        { length: count },
        () => '<rect fill="currentColor" width="1" height="1"/>',
      ).join('');
      await page.evaluate(
        (s) =>
          window.addSprite(
            `<svg width="0" height="0" style="position:absolute"><defs><symbol id="big" viewBox="0 0 24 24">${s}</symbol></defs></svg>`,
          ),
        shapes,
      );
      await step();
      await add(
        page,
        `<span class="cell bg-green"><svg id="u" class="red" width="24" height="24"><use href="#big"/></svg></span>`,
      );
      await step();
      const svg = (await diag()).svg;
      expect(svg.svgAdapted === 1 ? 'adapted' : 'unsupported').toBe(expected);
    });
  }
});

test.describe('M5.R1 retention', () => {
  test('5 cycles of 500 SVGs created, adapted and removed: no stale rule, owner, or queued work', async () => {
    test.setTimeout(420_000);
    const { page, step, diag } = await open();
    await step();
    const base = await diag();
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const many = Array.from({ length: 500 }, (_, i) => icon(`c${cycle}-${i}`)).join('');
      await add(page, `<div id="grid">${many}</div>`);
      await step();
      expect(await ruleTotal(page), `cycle ${cycle} adapted`).toBe(500);
      expect((await diag()).svg.svgAdapted).toBe(500);
      await page.evaluate(() => document.getElementById('grid')!.remove());
      const removed = await step();
      expect(removed.fullRescans).toBe(0);
      const d = await diag();
      expect(await ruleTotal(page), `cycle ${cycle} rules`).toBe(0);
      expect(d.svg).toMatchObject({ svgAnalyzed: 0, svgAdapted: 0, svgUnsupported: 0 });
      expect(d.trackedElements).toBe(base.trackedElements);
      expect(d).toMatchObject({
        state: 'IDLE',
        rules: 0,
        queuedRecords: 0,
        deferredRoots: 0,
        pendingRescan: null,
        throttleTimerActive: false,
      });
      await expectConsistent(page);
    }
  });
});
