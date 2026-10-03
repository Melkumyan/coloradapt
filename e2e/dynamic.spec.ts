import { expect, test, type Page } from '@playwright/test';
import type { DynamicDiagnostics } from '../src/domain/models';
import {
  allIds,
  computedColors,
  disable,
  dynamicDiagnostics,
  enable,
  flushDynamic,
  hasStylesheet,
  hexToRgb,
  launchExtension,
  refresh,
  setSettings,
  settle,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';

/**
 * Dynamic sites (docs/DYNAMIC_ANALYSIS.md), verified in real Chromium against
 * `getComputedStyle`. Nothing here sleeps or reads a clock: the page is
 * mutated, the pipeline is flushed through the debug channel, and structural
 * counters (passes, roots, elements) are asserted. One test lets the real
 * scheduler run, to prove the unforced path works too.
 */
const ORIGINAL_BAD = hexToRgb('#c0392b');

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

interface Loaded {
  readonly page: Page;
  readonly diag: () => Promise<DynamicDiagnostics>;
  /** Flushes and returns counters relative to the previous call of `step`. */
  readonly step: () => Promise<DynamicDiagnostics>;
}

const SETTINGS = { enabled: true, visionProfile: 'deuteranopia', adaptationStrength: 1 } as const;

/** Loads the dynamic page with ColorAdapt ON and the initial adaptation applied. */
async function load(): Promise<Loaded> {
  await setSettings(ext.worker, SETTINGS);
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/dynamic.html`);
  await expect.poll(() => hasStylesheet(page)).toBe(true);
  await flushDynamic(ext.worker, page);
  await settle(page);
  let last = await dynamicDiagnostics(ext.worker, page);
  return {
    page,
    diag: () => dynamicDiagnostics(ext.worker, page),
    step: async () => {
      const now = await flushDynamic(ext.worker, page);
      await settle(page);
      const delta = diffCounters(now, last);
      last = now;
      return delta;
    },
  };
}

/** `now - before` for the numeric counters; state/gauges are taken from `now`. */
function diffCounters(now: DynamicDiagnostics, before: DynamicDiagnostics): DynamicDiagnostics {
  const out: Record<string, unknown> = { ...now };
  for (const key of Object.keys(now) as Array<keyof DynamicDiagnostics>) {
    const a = now[key];
    const b = before[key];
    if (
      typeof a === 'number' &&
      typeof b === 'number' &&
      key !== 'trackedElements' &&
      key !== 'rules'
    ) {
      out[key] = a - b;
    }
  }
  return out as unknown as DynamicDiagnostics;
}

const rule = async (page: Page, id: string): Promise<boolean> =>
  page.evaluate((elementId) => {
    const el = document.getElementById(elementId);
    const cid = el?.getAttribute('data-coloradapt-id');
    const text = document.getElementById('coloradapt-stylesheet')?.textContent ?? '';
    return !!cid && text.includes(`[data-coloradapt-id="${cid}"]`);
  }, id);

const ruleTotal = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (
        (document.getElementById('coloradapt-stylesheet')?.textContent ?? '').match(
          /\[data-coloradapt-id="[^"]+"\]/g,
        ) ?? []
      ).length,
  );

const duplicateIds = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const ids = [...document.querySelectorAll('[data-coloradapt-id]')].map((e) =>
      e.getAttribute('data-coloradapt-id'),
    );
    return ids.length - new Set(ids).size;
  });

/** The incremental result must equal what a full rescan of the same page produces. */
async function expectEquivalentToFullRescan(page: Page): Promise<void> {
  const ids = await allIds(page);
  const incremental = await computedColors(page, ids);
  const rulesBefore = await ruleTotal(page);
  await refresh(ext.worker, page);
  await settle(page);
  expect(await computedColors(page, ids)).toEqual(incremental);
  expect(await ruleTotal(page)).toBe(rulesBefore);
}

test.describe('real browser: dynamic sites', () => {
  test('A. appended conflicting content is adapted by an incremental pass, not a full scan', async () => {
    const { page, step } = await load();
    const staticBefore = (await computedColors(page, ['static']))['static'];
    expect(staticBefore).not.toBe(ORIGINAL_BAD);

    await page.evaluate(() => document.getElementById('app')!.append(window.rows('a', 5)));
    const delta = await step();

    expect(delta.incrementalPasses).toBe(1);
    expect(delta.fullRescans).toBe(0);
    expect(delta.elementsProcessed).toBe(5);
    const colors = await computedColors(page, ['a0', 'a4']);
    expect(colors['a0']).not.toBe(ORIGINAL_BAD);
    expect(colors['a0']).toBe(staticBefore);
    expect((await computedColors(page, ['static']))['static']).toBe(staticBefore);
    expect(await duplicateIds(page)).toBe(0);
    await expectEquivalentToFullRescan(page);
  });

  test('B. accessible content is left exactly as the page rendered it', async () => {
    const { page, step } = await load();
    await page.evaluate(() => document.getElementById('app')!.append(window.rows('g', 3, 'good')));
    await step();
    expect(await computedColors(page, ['g0', 'g2'])).toEqual({
      g0: 'rgb(0, 0, 0)',
      g2: 'rgb(0, 0, 0)',
    });
    expect(await rule(page, 'g0')).toBe(false);
  });

  test('C. React-like replacement: old node out, new node in, one rule per live node', async () => {
    const { page, step } = await load();
    await page.evaluate(() => document.getElementById('app')!.append(window.rows('v1-', 1)));
    await step();
    const rulesWithV1 = await ruleTotal(page);

    for (let round = 2; round <= 6; round += 1) {
      await page.evaluate((r) => {
        const next = window.rows(`v${r}-`, 1).firstElementChild!;
        document.getElementById('app')!.firstElementChild!.replaceWith(next);
      }, round);
      const delta = await step();
      expect(delta.fullRescans).toBe(0);
      expect(delta.incrementalPasses).toBe(1);
    }

    expect(await ruleTotal(page)).toBe(rulesWithV1);
    expect(await rule(page, 'v6-0')).toBe(true);
    expect((await computedColors(page, ['v6-0']))['v6-0']).not.toBe(ORIGINAL_BAD);
    expect(await duplicateIds(page)).toBe(0);
    await expectEquivalentToFullRescan(page);
  });

  test('D. replaceChildren re-render of a list keeps exactly one rule per live row', async () => {
    const { page, step, diag } = await load();
    await page.evaluate(() => document.getElementById('app')!.append(window.rows('r', 20)));
    await step();
    const base = await ruleTotal(page);
    const tracked = (await diag()).trackedElements;

    for (let round = 0; round < 4; round += 1) {
      await page.evaluate(
        (r) => document.getElementById('app')!.replaceChildren(window.rows(`rr${r}-`, 20)),
        round,
      );
      await step();
      expect(await ruleTotal(page)).toBe(base);
    }
    const final = await diag();
    expect(final.trackedElements).toBe(tracked);
    expect(final.rules).toBe(base);
  });

  test('E. infinite scroll: new rows adapt, old rows are never re-analyzed, rules do not pile up', async () => {
    const { page, step } = await load();
    await page.evaluate(() => document.getElementById('app')!.append(window.rows('p0-', 100)));
    await step();
    const before = await ruleTotal(page);
    const sample = ['p0-0', 'p0-50', 'p0-99'];
    const firstColors = await computedColors(page, sample);

    for (let pageNo = 1; pageNo <= 3; pageNo += 1) {
      await page.evaluate(
        (n) => document.getElementById('app')!.append(window.rows(`p${n}-`, 100)),
        pageNo,
      );
      const delta = await step();
      expect(delta.incrementalPasses).toBe(1);
      expect(delta.fullRescans).toBe(0);
      expect(delta.elementsProcessed).toBe(100); // only the new rows
      expect(delta.rulesAdded).toBe(100);
      expect(delta.rulesRemoved).toBe(0);
      expect(await ruleTotal(page)).toBe(before + pageNo * 100);
    }
    expect(await computedColors(page, sample)).toEqual(firstColors);
    expect((await computedColors(page, ['p3-99']))['p3-99']).toBe(firstColors['p0-0']);
    expect(await duplicateIds(page)).toBe(0);
  });

  test('F. rapid class changes in one task: one pass, final state wins', async () => {
    const { page, step } = await load();
    await page.evaluate(() => {
      const el = document.getElementById('static')!;
      el.className = 'good';
      el.className = 'bad';
      el.className = 'good';
      el.className = 'bad';
      el.className = 'good';
    });
    const delta = await step();

    expect(delta.incrementalPasses).toBe(1);
    expect(delta.mutationRecords).toBeGreaterThanOrEqual(5);
    expect(await rule(page, 'static')).toBe(false);
    expect((await computedColors(page, ['static']))['static']).toBe('rgb(0, 0, 0)');

    await page.evaluate(() => (document.getElementById('static')!.className = 'bad'));
    await step();
    expect(await rule(page, 'static')).toBe(true);
    await expectEquivalentToFullRescan(page);
  });

  test('G. parent background change re-adapts the child without a full scan', async () => {
    const { page, step } = await load();
    expect(await rule(page, 'child')).toBe(false);
    expect((await computedColors(page, ['child']))['child']).toBe(ORIGINAL_BAD);

    await page.evaluate(() => (document.getElementById('parent')!.className = 'bg-green'));
    const delta = await step();

    expect(delta.fullRescans).toBe(0);
    expect(delta.incrementalPasses).toBe(1);
    expect(delta.elementsProcessed).toBe(1);
    expect(await rule(page, 'child')).toBe(true);
    expect((await computedColors(page, ['child']))['child']).not.toBe(ORIGINAL_BAD);
    await expectEquivalentToFullRescan(page);

    await page.evaluate(() => (document.getElementById('parent')!.className = 'bg-white'));
    await step();
    expect(await rule(page, 'child')).toBe(false);
    expect((await computedColors(page, ['child']))['child']).toBe(ORIGINAL_BAD);
  });

  test('H. parent opacity change invalidates the subtree and never double-applies opacity', async () => {
    const { page, step } = await load();
    await page.evaluate(() => (document.getElementById('parent')!.className = 'bg-green dim'));
    const delta = await step();
    expect(delta.fullRescans).toBe(0);
    expect(delta.elementsProcessed).toBe(1);
    await expectEquivalentToFullRescan(page);
  });

  test('I. show/hide: display none drops the rule, display block restores it', async () => {
    const { page, step } = await load();
    expect(await rule(page, 'static')).toBe(true);
    const adapted = (await computedColors(page, ['static']))['static'];

    await page.evaluate(() => (document.getElementById('static')!.style.display = 'none'));
    await step();
    expect(await rule(page, 'static')).toBe(false);

    await page.evaluate(() => (document.getElementById('static')!.style.display = ''));
    await step();
    expect(await rule(page, 'static')).toBe(true);
    expect((await computedColors(page, ['static']))['static']).toBe(adapted);

    await page.evaluate(() => (document.getElementById('static')!.hidden = true));
    await step();
    expect(await rule(page, 'static')).toBe(false);
    await page.evaluate(() => (document.getElementById('static')!.hidden = false));
    await step();
    expect(await rule(page, 'static')).toBe(true);
  });

  test('J. enabled/disabled button: disabled controls are skipped and re-adapted when enabled', async () => {
    const { page, step } = await load();
    expect(await rule(page, 'btn')).toBe(true);
    await page.evaluate(() => document.getElementById('btn')!.setAttribute('disabled', ''));
    await step();
    expect(await rule(page, 'btn')).toBe(false);
    await page.evaluate(() => document.getElementById('btn')!.removeAttribute('disabled'));
    await step();
    expect(await rule(page, 'btn')).toBe(true);
  });

  test('K. removing an adapted node removes its rule and bookkeeping', async () => {
    const { page, step, diag } = await load();
    await page.evaluate(() => document.getElementById('app')!.append(window.rows('x', 50)));
    await step();
    const withRows = await diag();

    await page.evaluate(() => document.getElementById('app')!.replaceChildren());
    const delta = await step();

    expect(delta.rulesRemoved).toBe(50);
    expect(delta.fullRescans).toBe(0);
    const after = await diag();
    expect(after.trackedElements).toBe(withRows.trackedElements - 50);
    expect(after.rules).toBe(withRows.rules - 50);
    expect(await ruleTotal(page)).toBe(after.rules);
  });

  test('L. route-like replacement of the whole view', async () => {
    const { page, step } = await load();
    await page.evaluate(() => {
      history.pushState({}, '', '/dynamic.html?route=a');
      document.getElementById('app')!.append(window.rows('home-', 10));
    });
    await step();

    await page.evaluate(() => {
      history.pushState({}, '', '/dynamic.html?route=b');
      document.getElementById('app')!.replaceChildren(window.rows('about-', 8));
    });
    const delta = await step();

    expect(delta.fullRescans).toBe(0);
    expect(delta.incrementalPasses).toBe(1);
    expect(await rule(page, 'about-0')).toBe(true);
    expect(await page.evaluate(() => document.getElementById('home-0'))).toBeNull();
    await expectEquivalentToFullRescan(page);
  });

  test('M. one external mutation never starts an observer cycle', async () => {
    const { page, step, diag } = await load();
    await page.evaluate(() => document.getElementById('app')!.append(window.rows('m', 3)));
    const delta = await step();
    expect(delta.incrementalPasses).toBe(1);

    // Real frames go by: nothing further may run, whatever our own writes did.
    const after = await diag();
    await settle(page);
    await settle(page);
    const later = await diag();
    expect(later.incrementalPasses).toBe(after.incrementalPasses);
    expect(later.fullRescans).toBe(after.fullRescans);
    expect(later.state).toBe('IDLE');
    expect(later.selfMutationsIgnored).toBeGreaterThan(0);
  });

  test('N. the unforced path: the real scheduler processes a mutation by itself', async () => {
    const { page, diag } = await load();
    const before = await diag();
    await page.evaluate(() => document.getElementById('app')!.append(window.rows('nat', 4)));

    await expect
      .poll(async () => (await diag()).incrementalPasses - before.incrementalPasses)
      .toBe(1);
    await settle(page);
    expect(await rule(page, 'nat0')).toBe(true);
    expect((await diag()).state).toBe('IDLE');
  });

  test('O. 500 synchronous inserts are one pass, not 500', async () => {
    const { page, step } = await load();
    await page.evaluate(() => {
      const app = document.getElementById('app')!;
      for (let i = 0; i < 500; i += 1) app.append(window.rows(`bulk${i}-`, 1));
    });
    const delta = await step();

    expect(delta.incrementalPasses).toBe(1);
    expect(delta.fullRescans).toBe(0);
    expect(delta.affectedRoots).toBe(500);
    expect(delta.elementsProcessed).toBe(500);
    expect(await rule(page, 'bulk499-0')).toBe(true);
    expect(await duplicateIds(page)).toBe(0);
  });

  test('P. a dynamically added <style> is a controlled full rescan', async () => {
    const { page, step } = await load();
    await page.evaluate(() => {
      document
        .getElementById('app')!
        .insertAdjacentHTML('beforeend', '<p id="late" class="late">Late</p>');
    });
    await step();
    expect(await rule(page, 'late')).toBe(false);

    await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = '.late { color: #c0392b; background-color: #27ae60; }';
      document.head.append(style);
    });
    const delta = await step();

    expect(delta.fullRescans).toBe(1);
    expect(delta.fullRescansByReason.stylesheet).toBe(1);
    expect(await rule(page, 'late')).toBe(true);
    await expectEquivalentToFullRescan(page);
  });

  test('Q. a stylesheet <link> triggers one rescan after it has loaded', async () => {
    const { page, step } = await load();
    await page.evaluate(() => {
      document
        .getElementById('app')!
        .insertAdjacentHTML('beforeend', '<p id="th" class="themed">Themed</p>');
    });
    await step();
    expect(await rule(page, 'th')).toBe(false);

    const loaded = page.evaluate(
      (href) =>
        new Promise<void>((resolve) => {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = href;
          link.addEventListener('load', () => resolve(), { once: true });
          document.head.append(link);
        }),
      `${server.origin}/dynamic-theme.css`,
    );
    await loaded;
    const delta = await step();

    expect(delta.fullRescansByReason.stylesheet).toBe(1);
    expect(await rule(page, 'th')).toBe(true);
  });

  test('R. unresolved content (gradient background) stays fail-safe when added dynamically', async () => {
    const { page, step } = await load();
    await page.evaluate(() =>
      document
        .getElementById('app')!
        .insertAdjacentHTML('beforeend', '<p id="grad" class="gradient">Gradient</p>'),
    );
    await step();
    expect(await rule(page, 'grad')).toBe(false);
    expect((await computedColors(page, ['grad']))['grad']).toBe(ORIGINAL_BAD);
  });

  test('S. ON/OFF/ON: no ghost observers, OFF restores the page, mutations while OFF are ignored', async () => {
    const { page, step, diag } = await load();
    const pristineBad = ORIGINAL_BAD;

    await disable(ext.worker, page);
    await settle(page);
    expect(await hasStylesheet(page)).toBe(false);
    expect((await computedColors(page, ['static']))['static']).toBe(pristineBad);

    await page.evaluate(() => document.getElementById('app')!.append(window.rows('off', 3)));
    const whileOff = await flushDynamic(ext.worker, page);
    expect(whileOff.state).toBe('STOPPED');
    expect(await hasStylesheet(page)).toBe(false);

    const startsBefore = (await diag()).observerStarts;
    await enable(ext.worker, page);
    await enable(ext.worker, page);
    await settle(page);
    expect((await diag()).observerStarts).toBe(startsBefore + 1);
    expect(await rule(page, 'off0')).toBe(true); // picked up by the full pass on ON

    await page.evaluate(() => document.getElementById('app')!.append(window.rows('on', 2)));
    const delta = await step();
    expect(delta.incrementalPasses).toBe(1); // a single subscription -> a single pass

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await disable(ext.worker, page);
      await enable(ext.worker, page);
    }
    await page.evaluate(() => document.getElementById('app')!.append(window.rows('again', 2)));
    const again = await step();
    expect(again.incrementalPasses).toBe(1);
  });

  test('T. changing profile/strength is a full refresh and never compounds', async () => {
    const { page, step } = await load();
    await page.evaluate(() => document.getElementById('app')!.append(window.rows('s', 4)));
    await step();
    const ids = await allIds(page);
    const deutan = await computedColors(page, ids);

    const changes = [
      { visionProfile: 'protanopia', adaptationStrength: 1 },
      { visionProfile: 'tritanopia', adaptationStrength: 0.5 },
      { visionProfile: 'deuteranopia', adaptationStrength: 0 },
      { visionProfile: 'deuteranopia', adaptationStrength: 1 },
    ] as const;
    for (const [index, change] of changes.entries()) {
      await setSettings(ext.worker, { ...SETTINGS, ...change });
      await refresh(ext.worker, page);
      await settle(page);
      // Rows added afterwards are planned with the new settings, and everything stays one rule per element.
      await page.evaluate(
        (prefix) => document.getElementById('app')!.append(window.rows(prefix, 1)),
        `z${index}-`,
      );
      await step();
      expect(await duplicateIds(page)).toBe(0);
    }
    // Back on deuteranopia: the original rows have exactly the colors they had at first.
    expect(await computedColors(page, ids)).toEqual(deutan);
  });

  test('U. repeated incremental updates never drift', async () => {
    const { page, step } = await load();
    const first = await computedColors(page, ['static', 'btn']);
    for (let i = 0; i < 12; i += 1) {
      await page.evaluate((n) => {
        const el = document.getElementById('static')!;
        el.className = n % 2 === 0 ? 'good' : 'bad';
        document.getElementById('app')!.append(window.rows(`d${n}-`, 1));
      }, i);
      await step();
    }
    await page.evaluate(() => (document.getElementById('static')!.className = 'bad'));
    await step();
    expect(await computedColors(page, ['static', 'btn'])).toEqual(first);
    await expectEquivalentToFullRescan(page);
  });

  test('V. the page deleting our <style> element gets the adaptation put back', async () => {
    const { page, diag } = await load();
    const before = await computedColors(page, ['static']);
    await page.evaluate(() => document.getElementById('coloradapt-stylesheet')!.remove());

    await expect.poll(() => hasStylesheet(page)).toBe(true);
    await settle(page);
    expect(await computedColors(page, ['static'])).toEqual(before);
    expect((await diag()).stylesheetRepairs).toBe(1);
  });

  test('W. a theme switch on <html> is a full rescan', async () => {
    const { page, step } = await load();
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent =
        'html[data-theme="dark"] .good { color: #c0392b; background-color: #27ae60; }';
      document.head.append(style);
      document
        .getElementById('app')!
        .insertAdjacentHTML('beforeend', '<p id="tg" class="good">Themed</p>');
    });
    await step();
    expect(await rule(page, 'tg')).toBe(false);

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    const delta = await step();
    expect(delta.fullRescansByReason['document-root']).toBe(1);
    expect(await rule(page, 'tg')).toBe(true);
  });
});
