import { expect, test, type Page } from '@playwright/test';
import {
  computedColors,
  disable,
  launchExtension,
  refresh,
  settle,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';
import {
  expectConsistent,
  expectNoWork,
  load,
  ruleSelectors,
  ruleTotal,
  type Loaded,
} from './r1-kit';
import { RED, SETTINGS, paints, pixelAt, sheetRules } from './svg-kit';

/**
 * M5 through the M4 pipeline: inline SVG that appears, changes and goes away is
 * handled by the same observer, the same batches and the same incremental session
 * as everything else (no separate SVG observer), and a settled page equals what a
 * full rescan would produce. Counters are structural; nothing sleeps.
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

const open = (): Promise<Loaded> => load(ext, server, 'svg-dynamic.html', SETTINGS);

/** A red `currentColor` icon on green: adapted. `extra` goes on the <svg>. */
const icon = (id: string, extra = '', cls = 'red') =>
  `<span id="${id}-w" class="cell bg-green"><svg id="${id}" class="${cls}" width="24" height="24" viewBox="0 0 24 24" ${extra}><path id="${id}-p" fill="currentColor" d="M2 2h20v20H2z"/></svg></span>`;

/** A shape-owned fill (class based), red on green: adapted. */
const filled = (id: string, cls = 'f-red') =>
  `<span id="${id}-w" class="cell bg-green"><svg id="${id}" width="24" height="24" viewBox="0 0 24 24"><path id="${id}-p" class="${cls}" d="M2 2h20v20H2z"/></svg></span>`;

const add = (page: Page, html: string) => page.evaluate((h) => window.add(h), html);

/** What every settled state must satisfy, plus: it is what a full rescan would produce. */
async function expectEquivalent(page: Page, ids: readonly string[]): Promise<void> {
  const before = {
    fill: await paints.fill(page, ids),
    color: await paints.color(page, ids),
    rules: (await sheetRules(page)).length,
  };
  await refresh(ext.worker, page);
  await settle(page);
  expect({
    fill: await paints.fill(page, ids),
    color: await paints.color(page, ids),
    rules: (await sheetRules(page)).length,
  }).toEqual(before);
}

declare global {
  interface Window {
    /** Defined by `e2e/pages/svg-dynamic.html`. */
    add(html: string): void;
    addSprite(html: string): void;
    replace(id: string, html: string): void;
  }
}

test.describe('M5 dynamic SVG', () => {
  test('an SVG appended after load is adapted through the incremental pass, not a rescan', async () => {
    const { page, step } = await open();
    await step();
    await add(page, icon('a'));
    const delta = await step();
    expect(delta.fullRescans).toBe(0);
    expect(delta.incrementalPasses).toBeGreaterThanOrEqual(1);
    expect(delta.rulesAdded).toBe(1);
    expect(delta.elementsProcessed).toBeLessThanOrEqual(3);
    const [fill] = Object.values(await paints.fill(page, ['a-p']));
    expect(fill).not.toBe(RED);
    expect(delta.svg.svgAnalyzed).toBe(1);
    expect(delta.svg.svgAdapted).toBe(1);
    await expectConsistent(page);
    await expectEquivalent(page, ['a-p']);
  });

  test('an icon button rendered later: text and icon follow one color', async () => {
    const { page, step } = await open();
    await add(
      page,
      `<button id="b" class="cell bg-green red" style="border:0"><svg id="bi" width="16" height="16" viewBox="0 0 24 24"><path id="bi-p" fill="currentColor" d="M2 2h20v20H2z"/></svg> Save</button>`,
    );
    const delta = await step();
    expect(delta.fullRescans).toBe(0);
    const [buttonColor] = Object.values(await paints.color(page, ['b']));
    const [iconFill] = Object.values(await paints.fill(page, ['bi-p']));
    expect(buttonColor).not.toBe(RED);
    expect(iconFill).toBe(buttonColor);
    await expectConsistent(page);
  });

  test('replacing an SVG (old removed, new inserted) leaves one rule and no stale one', async () => {
    const { page, step } = await open();
    await add(page, icon('a'));
    await step();
    expect(await ruleTotal(page)).toBe(1);
    const oldRule = (await ruleSelectors(page))[0];

    await page.evaluate((html) => window.replace('a-w', html), icon('a2'));
    const delta = await step();
    expect(delta.fullRescans).toBe(0);
    expect(await ruleTotal(page)).toBe(1);
    expect((await ruleSelectors(page))[0]).not.toBe(oldRule);
    await expectConsistent(page);
    const [fill] = Object.values(await paints.fill(page, ['a2-p']));
    expect(fill).not.toBe(RED);
  });

  test('removing an SVG removes its rules', async () => {
    const { page, step, diag } = await open();
    await add(page, icon('a') + icon('b'));
    await step();
    expect(await ruleTotal(page)).toBe(2);
    await page.evaluate(() => document.getElementById('a-w')!.remove());
    const delta = await step();
    expect(delta.rulesRemoved).toBe(1);
    expect(await ruleTotal(page)).toBe(1);
    expect((await diag()).svg.svgAnalyzed).toBe(1);
    await expectConsistent(page);
  });

  test('a class change on the shape re-derives the paint', async () => {
    const { page, step } = await open();
    await add(page, filled('a'));
    await step();
    const before = (await paints.fill(page, ['a-p']))['a-p'];
    await page.evaluate(() => document.getElementById('a-p')!.setAttribute('class', 'f-blue'));
    const delta = await step();
    expect(delta.fullRescans).toBe(0);
    expect(delta.incrementalPasses).toBe(1);
    expect(delta.elementsProcessed).toBe(1);
    await expectConsistent(page);
    // The rule follows the new original color: whatever the plan is, the browser agrees with a rescan.
    await expectEquivalent(page, ['a-p']);
    expect(before).toBeDefined();
  });

  test('a fill attribute change: adapted for the new color', async () => {
    const { page, step } = await open();
    await add(
      page,
      `<span id="a-w" class="cell bg-green"><svg id="a" width="24" height="24"><path id="a-p" fill="#c0392b" d="M2 2h20v20H2z"/></svg></span>`,
    );
    await step();
    const first = (await paints.fill(page, ['a-p']))['a-p'];
    await page.evaluate(() => document.getElementById('a-p')!.setAttribute('fill', '#2980b9'));
    const delta = await step();
    expect(delta.incrementalPasses).toBe(1);
    expect(delta.fullRescans).toBe(0);
    await expectEquivalent(page, ['a-p']);
    expect(first).not.toBe(RED);
  });

  test('a stroke attribute change', async () => {
    const { page, step } = await open();
    await add(
      page,
      `<span id="a-w" class="cell bg-green"><svg id="a" width="24" height="24"><path id="a-p" fill="none" stroke="#c0392b" stroke-width="3" d="M3 3h18v18H3z"/></svg></span>`,
    );
    await step();
    expect((await paints.stroke(page, ['a-p']))['a-p']).not.toBe(RED);
    await page.evaluate(() => document.getElementById('a-p')!.setAttribute('stroke', '#2980b9'));
    const delta = await step();
    expect(delta.incrementalPasses).toBe(1);
    await expectConsistent(page);
    const before = await paints.stroke(page, ['a-p']);
    await refresh(ext.worker, page);
    await settle(page);
    expect(await paints.stroke(page, ['a-p'])).toEqual(before);
  });

  test('changing the color source (a class on the <svg>, then an inline style) is followed', async () => {
    const { page, step } = await open();
    await add(page, icon('a'));
    await step();
    const first = (await paints.fill(page, ['a-p']))['a-p'];
    await page.evaluate(() => document.getElementById('a')!.setAttribute('class', 'blue'));
    await step();
    await expectEquivalent(page, ['a-p']);
    await page.evaluate(() => (document.getElementById('a')!.style.color = '#c0392b'));
    await step();
    expect((await paints.fill(page, ['a-p']))['a-p']).toBe(first);
    await expectConsistent(page);
  });

  test('changing the color of a page ancestor re-derives the icon below it', async () => {
    const { page, step } = await open();
    await add(
      page,
      `<div id="host" class="red cell bg-green"><svg id="a" width="24" height="24" viewBox="0 0 24 24"><path id="a-p" fill="currentColor" d="M2 2h20v20H2z"/></svg></div>`,
    );
    await step();
    const first = (await paints.fill(page, ['a-p']))['a-p'];
    await page.evaluate(() => (document.getElementById('host')!.className = 'blue cell bg-green'));
    const delta = await step();
    expect(delta.fullRescans).toBe(0);
    await expectEquivalent(page, ['a-p']);
    await page.evaluate(() => (document.getElementById('host')!.className = 'red cell bg-green'));
    await step();
    expect((await paints.fill(page, ['a-p']))['a-p']).toBe(first);
  });

  test('adding a second paint makes the unit unsupported (rules gone); removing it adapts again', async () => {
    const { page, step, diag } = await open();
    await add(page, icon('a'));
    await step();
    expect(await ruleTotal(page)).toBe(1);

    await page.evaluate(() => {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.id = 'extra';
      circle.setAttribute('r', '4');
      circle.setAttribute('fill', '#ffffff');
      document.getElementById('a')!.appendChild(circle);
    });
    await step();
    expect(await ruleTotal(page)).toBe(0);
    expect((await paints.color(page, ['a']))['a']).toBe(RED);
    expect((await diag()).svg).toMatchObject({ svgAnalyzed: 1, svgAdapted: 0, svgUnsupported: 1 });

    await page.evaluate(() => document.getElementById('extra')!.remove());
    await step();
    expect(await ruleTotal(page)).toBe(1);
    expect((await diag()).svg).toMatchObject({ svgAdapted: 1, svgUnsupported: 0 });
    await expectConsistent(page);
  });

  test('SVG text: emptying and refilling it changes eligibility through the same pipeline', async () => {
    const { page, step } = await open();
    await add(
      page,
      `<span id="a-w" class="cell bg-green"><svg id="a" width="80" height="24"><text id="t" x="2" y="18" fill="#c0392b">Label</text></svg></span>`,
    );
    await step();
    expect(await ruleTotal(page)).toBe(1);
    await page.evaluate(() => (document.getElementById('t')!.textContent = ''));
    await step();
    expect(await ruleTotal(page)).toBe(0);
    expect((await paints.fill(page, ['t']))['t']).toBe(RED);
    await page.evaluate(() => (document.getElementById('t')!.textContent = 'Back'));
    await step();
    expect(await ruleTotal(page)).toBe(1);
    expect((await paints.fill(page, ['t']))['t']).not.toBe(RED);
    await expectConsistent(page);
  });

  test('a <use> whose href changes is re-analyzed for the new content', async () => {
    const { page, step } = await open();
    await add(
      page,
      `<span id="a-w" class="cell bg-green"><svg id="a" class="red" width="24" height="24"><use id="a-u" href="#sym-cc"/></svg></span>`,
    );
    await step();
    expect(await ruleTotal(page)).toBe(1);
    expect((await sheetRules(page))[0]?.[1]).toBe('color');
    const planned = (await sheetRules(page))[0]?.[2];
    expect(await pixelAt(page, 'a', 12, 12)).toBe(hex(planned));

    // The same <use> now points at content that inherits fill (the <use> has none: black, which is fine on green? no: still a plan)
    await page.evaluate(() => document.getElementById('a-u')!.setAttribute('href', '#sym-inherit'));
    const delta = await step();
    expect(delta.fullRescans).toBe(0);
    expect(delta.incrementalPasses).toBe(1);
    await expectConsistent(page);
    // Whatever the rules are now, nothing for the old content is left and the shared symbols are untouched.
    const css = await page.evaluate(
      () => document.getElementById('coloradapt-stylesheet')?.textContent ?? '',
    );
    expect(css).not.toContain('sym-');
    // (the probe may tag the symbol's *parent*, e.g. <defs>, with the plain id attribute; a rule never targets it)
    const symbols = await page.evaluate(
      () =>
        document.querySelectorAll(
          '#sprite symbol[data-coloradapt-id], #sprite symbol [data-coloradapt-id]',
        ).length,
    );
    expect(symbols).toBe(0);
  });

  test('a <use> instance changing class or color is followed per instance', async () => {
    const { page, step } = await open();
    await add(
      page,
      `<span id="a-w" class="cell bg-green"><svg id="a" class="red" width="24" height="24"><use href="#sym-cc"/></svg></span>
       <span id="b-w" class="cell bg-green"><svg id="b" class="red" width="24" height="24"><use href="#sym-cc"/></svg></span>`,
    );
    await step();
    const a = await pixelAt(page, 'a', 12, 12);
    const b = await pixelAt(page, 'b', 12, 12);
    expect(a).toBe(b);
    expect(a).not.toBe(RED);
    await page.evaluate(() => (document.getElementById('b')!.style.color = '#2980b9'));
    const delta = await step();
    expect(delta.fullRescans).toBe(0);
    expect(delta.elementsProcessed).toBe(1); // only the instance that changed
    expect(await pixelAt(page, 'a', 12, 12)).toBe(a); // the other instance did not move
    expect(await pixelAt(page, 'b', 12, 12)).not.toBe(a);
    // Whatever the plan for the new color, the settled state is what a full rescan produces.
    const settled = [await pixelAt(page, 'a', 12, 12), await pixelAt(page, 'b', 12, 12)];
    const rules = (await sheetRules(page)).length;
    await refresh(ext.worker, page);
    await settle(page);
    expect([await pixelAt(page, 'a', 12, 12), await pixelAt(page, 'b', 12, 12)]).toEqual(settled);
    expect((await sheetRules(page)).length).toBe(rules);
    await expectConsistent(page);
  });

  test('a sprite that arrives after its instances brings them to life (no rescan)', async () => {
    const { page, step } = await open();
    await add(
      page,
      `<span id="a-w" class="cell bg-green"><svg id="a" class="red" width="24" height="24"><use href="#late"/></svg></span>`,
    );
    await step();
    expect(await ruleTotal(page)).toBe(0); // unresolved

    await page.evaluate(() =>
      window.addSprite(
        '<svg id="sprite2" width="0" height="0" style="position:absolute"><symbol id="late" viewBox="0 0 24 24"><rect width="24" height="24" fill="currentColor"/></symbol></svg>',
      ),
    );
    const delta = await step();
    expect(delta.fullRescans).toBe(0);
    expect(await ruleTotal(page)).toBe(1);
    expect(await pixelAt(page, 'a', 12, 12)).not.toBe(RED);
    await expectConsistent(page);
  });

  test('a legacy xlink:href change is not observable, and the next full refresh picks it up', async () => {
    const { page, step } = await open();
    await add(
      page,
      `<span id="a-w" class="cell bg-green"><svg id="a" class="red" width="24" height="24"><use id="a-u" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#sym-cc"/></svg></span>`,
    );
    await step();
    expect(await ruleTotal(page)).toBe(1);
    await page.evaluate(() =>
      document
        .getElementById('a-u')!
        .setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#missing'),
    );
    const delta = await step();
    expectNoWork(delta); // never delivered: documented limitation
    await refresh(ext.worker, page);
    await settle(page);
    expect(await ruleTotal(page)).toBe(0);
  });

  test('turning ColorAdapt OFF removes every SVG rule and restores the page', async () => {
    const { page, step } = await open();
    await add(page, icon('a') + filled('b'));
    await step();
    expect(await ruleTotal(page)).toBe(2);
    const adapted = await paints.fill(page, ['a-p', 'b-p']);
    await disable(ext.worker, page);
    await settle(page);
    expect(await page.evaluate(() => document.getElementById('coloradapt-stylesheet'))).toBeNull();
    expect(await paints.fill(page, ['a-p', 'b-p'])).not.toEqual(adapted);
    expect(await paints.fill(page, ['a-p', 'b-p'])).toEqual({ 'a-p': RED, 'b-p': RED });
  });
});

/** `#rrggbb` -> `rgb(r, g, b)` */
function hex(value: string | undefined): string {
  const n = Number.parseInt((value ?? '#000000').slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

test.describe('M5 SVG stress (structural bounds, no timing)', () => {
  test('500 icons at once, then 100 replacements: bounded work, one rule per icon, nothing stale', async () => {
    test.setTimeout(420_000);
    const { page, step, diag } = await open();
    await step();
    const many = Array.from({ length: 500 }, (_, i) => icon(`i${i}`)).join('');
    await add(page, `<div id="grid">${many}</div>`);
    const appended = await step();
    expect(appended.fullRescans).toBe(0);
    expect(await ruleTotal(page)).toBe(500);
    expect((await diag()).svg).toMatchObject({ svgAnalyzed: 500, svgAdapted: 500 });
    await expectConsistent(page);

    const before = await step();
    expectNoWork(before);

    for (let i = 0; i < 100; i += 1) {
      await page.evaluate(([id, html]) => window.replace(id, html), [
        `i${i}-w`,
        icon(`n${i}`),
      ] as const);
      const delta = await step();
      expect(delta.fullRescans).toBe(0);
      // one removed SVG, one added: both regions bounded to that icon
      expect(delta.elementsProcessed).toBeLessThanOrEqual(3);
    }
    expect(await ruleTotal(page)).toBe(500);
    expect((await diag()).svg).toMatchObject({ svgAnalyzed: 500, svgAdapted: 500 });
    expect((await diag()).trackedElements).toBe(500);
    await expectConsistent(page);
    const colors = await computedColors(page, ['n0-p', 'n99-p', 'i100-p', 'i499-p'], 'fill');
    expect(new Set(Object.values(colors)).size).toBe(1);
    expect(Object.values(colors)[0]).not.toBe(RED);
  });
});
