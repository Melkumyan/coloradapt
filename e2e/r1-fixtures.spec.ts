import { expect, test, type Page } from '@playwright/test';
import {
  allIds,
  computedColors,
  hasStylesheet,
  launchExtension,
  refresh,
  settle,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';
import {
  expectConsistent,
  expectEquivalentToFullRescan,
  expectNoWork,
  load,
  ORIGINAL_BAD,
  rule,
  ruleSelectors,
  ruleTotal,
  staleRules,
} from './r1-kit';

/**
 * M4.R1 sections 4, 5 and 12, real Chromium: SPA route transitions, infinite
 * scroll, and local deterministic fixtures standing in for real-world sites
 * (React-style SPA, infinite feed, dashboard with a theme switch, CSS-in-JS,
 * hostile high-specificity CSS, rapid DOM churn). No public website is
 * involved in any PASS/FAIL decision.
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

const SHELL = ['nav-home', 'nav-about', 'nav-settings', 'counter', 'footer-text'];

const coloradaptIds = (
  page: Page,
  ids: readonly string[],
): Promise<Record<string, string | null>> =>
  page.evaluate(
    (list) =>
      Object.fromEntries(
        list.map((id) => [
          id,
          document.getElementById(id)?.getAttribute('data-coloradapt-id') ?? null,
        ]),
      ),
    ids,
  );

const viewIs = (page: Page) => () =>
  page.evaluate(() => document.getElementById('view')?.getAttribute('data-view'));

test.describe('R1-4. SPA transitions (driven by DOM mutations, not history)', () => {
  test('view A -> pushState -> view B -> view C -> back/forward: rules follow, the shell is untouched', async () => {
    const { page, step, natural, diag } = await load(ext, server, 'r1-react.html');
    expect(await ruleTotal(page)).toBe(18); // 3 nav + counter + footer + h2 + 12 items
    const shellIds = await coloradaptIds(page, SHELL);
    const shellColors = await computedColors(page, SHELL);
    expect(Object.values(shellIds).every(Boolean)).toBe(true);

    // home -> about: <main> replaced by <section>
    await page.evaluate(() => window.spa.go('about'));
    let delta = await step();
    expect(delta).toMatchObject({
      incrementalPasses: 1,
      fullRescans: 0,
      affectedRoots: 1,
      rulesRemoved: 13,
      rulesAdded: 2,
      rulesUpdated: 0,
    });
    expect(await rule(page, 'home-0')).toBe(false);
    expect(await page.evaluate(() => document.getElementById('home-0'))).toBeNull();
    expect(await rule(page, 'about-title')).toBe(true);
    expect(await rule(page, 'about-fine')).toBe(false);

    // about -> settings
    await page.evaluate(() => window.spa.go('settings'));
    delta = await step();
    expect(delta).toMatchObject({
      incrementalPasses: 1,
      fullRescans: 0,
      rulesRemoved: 2,
      rulesAdded: 7,
      rulesUpdated: 0,
    });
    expect(await rule(page, 'set-5')).toBe(true);
    expect(await rule(page, 'about-title')).toBe(false);

    // browser back: popstate -> about; back again -> home (state-less initial entry)
    for (const expected of ['about', 'home']) {
      await page.evaluate(() => window.spa.back());
      await expect.poll(viewIs(page)).toBe(expected);
      const natural1 = await natural();
      expect(natural1.fullRescans).toBe(0);
      expect(natural1.incrementalPasses).toBe(1);
    }
    // forward
    await page.evaluate(() => history.forward());
    await expect.poll(viewIs(page)).toBe('about');
    await natural();

    // back to home for the final comparison
    await page.evaluate(() => window.spa.show('home'));
    await step();
    expect(await ruleTotal(page)).toBe(18);
    expect(await coloradaptIds(page, SHELL)).toEqual(shellIds); // same elements, same ids
    expect(await computedColors(page, SHELL)).toEqual(shellColors);
    for (const id of SHELL) expect(await rule(page, id), id).toBe(true);
    expect((await diag()).fullRescans).toBe(0); // no full scan at any point
    await expectConsistent(page);
    await expectEquivalentToFullRescan(ext, page);
  });

  test('the same transitions without any history call behave identically', async () => {
    const { page, step } = await load(ext, server, 'r1-react.html');
    await page.evaluate(() => window.spa.show('about'));
    const delta = await step();
    expect(delta).toMatchObject({
      incrementalPasses: 1,
      fullRescans: 0,
      rulesRemoved: 13,
      rulesAdded: 2,
    });
    await expectConsistent(page);
  });

  test('re-renders that only change text (a counter) cost nothing', async () => {
    const { page, step } = await load(ext, server, 'r1-react.html');
    for (let n = 1; n <= 50; n += 1) await page.evaluate((v) => window.spa.tick(v), n);
    const delta = await step();
    expectNoWork(delta);
    expect(await rule(page, 'counter')).toBe(true);
  });

  test('moving rows (keyed reorder) re-analyzes the moved rows but changes no rule', async () => {
    const { page, step } = await load(ext, server, 'r1-react.html');
    const before = await ruleSelectors(page);
    await page.evaluate(() => window.reorderHome());
    const delta = await step();
    expect(delta.fullRescans).toBe(0);
    expect(delta.affectedRoots).toBe(12);
    expect(delta).toMatchObject({ rulesAdded: 0, rulesUpdated: 0, rulesRemoved: 0 });
    expect((await ruleSelectors(page)).sort()).toEqual([...before].sort());
    await expectConsistent(page);
  });

  test('the extension never listens to the History API', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        return e.isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(e.name) ? [full] : [];
      });
    const root = path.resolve(import.meta.dirname, '..', 'src');
    const offenders = walk(root).filter((file) =>
      /popstate|pushState|replaceState|hashchange|navigation\.addEventListener/.test(
        fs.readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});

test.describe('R1-5. infinite scroll', () => {
  test('100 + 20 x 100 + 500: bounded incremental work, old rows untouched, then everything cleaned up', async () => {
    test.setTimeout(300_000);
    const { page, step, diag } = await load(ext, server, 'r1-feed.html');
    const base = await diag();
    expect(base).toMatchObject({ rules: 0 });
    expect(await hasStylesheet(page)).toBe(false);

    await page.evaluate(() => window.feed.load(100));
    let delta = await step();
    expect(delta).toMatchObject({
      incrementalPasses: 1,
      fullRescans: 0,
      elementsProcessed: 100,
      rulesAdded: 100,
    });
    const firstIds = await page.evaluate(() => Array.from({ length: 100 }, (_, i) => `item-${i}`));
    const firstColors = await computedColors(page, firstIds);
    const firstTags = await coloradaptIds(page, firstIds);
    let total = 100;
    let work = delta.elementsProcessed;

    for (let batch = 1; batch <= 20; batch += 1) {
      await page.evaluate(() => window.feed.load(100));
      delta = await step();
      total += 100;
      work += delta.elementsProcessed;
      expect(delta, `batch ${batch}`).toMatchObject({
        incrementalPasses: 1,
        fullRescans: 0,
        affectedRoots: 100,
        elementsProcessed: 100,
        rulesAdded: 100,
        rulesUpdated: 0,
        rulesRemoved: 0,
        truncatedPasses: 0,
        rootsDeferred: 0,
      });
      const d = await diag();
      expect(d.rules).toBe(total);
      expect(d.trackedElements).toBe(base.trackedElements + total);
      expect((await computedColors(page, ['item-0', `item-${total - 1}`]))['item-0']).toBe(
        firstColors['item-0'],
      );
      if (batch % 5 === 0) await expectConsistent(page);
    }
    expect(work).toBe(2100); // 21 batches x 100: the sum of the new rows, never the page

    // one larger append: 500 sibling roots (under the 512-root budget)
    await page.evaluate(() => window.feed.load(500));
    delta = await step();
    total += 500;
    expect(delta).toMatchObject({
      incrementalPasses: 1,
      fullRescans: 0,
      affectedRoots: 500,
      elementsProcessed: 500,
      rulesAdded: 500,
      rulesRemoved: 0,
    });
    expect((await diag()).rules).toBe(total);
    expect(total).toBe(2600);

    // the first 100 rows are exactly as they were: same ids, same colors
    expect(await computedColors(page, firstIds)).toEqual(firstColors);
    expect(await coloradaptIds(page, firstIds)).toEqual(firstTags);
    await expectConsistent(page);

    // virtualisation: the oldest 1000 rows go
    await page.evaluate(() => window.feed.trim(1000));
    delta = await step();
    expect(delta).toMatchObject({
      incrementalPasses: 1,
      fullRescans: 0,
      rulesRemoved: 1000,
      rulesAdded: 0,
    });
    total -= 1000;
    expect((await diag()).rules).toBe(total);
    expect(await staleRules(page)).toBe(0);

    // everything else goes: nothing generated survives
    await page.evaluate(() => window.feed.clear());
    delta = await step();
    expect(delta.rulesRemoved).toBe(total);
    const end = await diag();
    expect(end).toMatchObject({
      rules: 0,
      trackedElements: base.trackedElements,
      state: 'IDLE',
      queuedRecords: 0,
      deferredRoots: 0,
    });
    expect(await hasStylesheet(page)).toBe(false);
    expect(await ruleSelectors(page)).toEqual([]);
    expect(
      await page.evaluate(() => document.querySelectorAll('#feed [data-coloradapt-id]').length),
    ).toBe(0);
    test.info().annotations.push({
      type: 'counters',
      description: `R1-5 feed: 21 batches + 500 appended + 1000 trimmed + cleared; elementsProcessed(batches)=${work}, fullRescans=${end.fullRescans}, incrementalPasses=${end.incrementalPasses - base.incrementalPasses}`,
    });
  });

  test('the unforced scheduler handles the same stream', async () => {
    const { page, natural } = await load(ext, server, 'r1-feed.html');
    for (let batch = 0; batch < 5; batch += 1) {
      await page.evaluate(() => window.feed.load(100));
      const d = await natural();
      expect(d).toMatchObject({ incrementalPasses: 1, fullRescans: 0, rulesAdded: 100 });
    }
    expect(await ruleTotal(page)).toBe(500);
    await expectEquivalentToFullRescan(ext, page);
  });
});

test.describe('R1-12. real-world fixtures', () => {
  test('dashboard with a theme switch: one rescan per switch, live numbers and new rows stay cheap', async () => {
    const { page, step } = await load(ext, server, 'r1-dashboard.html');
    expect(await ruleTotal(page)).toBe(0); // light theme: nothing conflicts

    await page.evaluate(() => window.dash.toggleTheme());
    let delta = await step();
    expect(delta).toMatchObject({ fullRescans: 1, incrementalPasses: 0 });
    expect(delta.fullRescansByReason).toEqual({ 'document-root': 1 });
    expect(await ruleTotal(page)).toBe(7); // 3 cards + 3 values + the button

    for (let n = 1; n <= 100; n += 1) await page.evaluate((v) => window.dash.tick(v), n);
    expectNoWork(await step()); // live KPIs: text only

    await page.evaluate(() => window.dash.addRows(20, true));
    delta = await step();
    expect(delta).toMatchObject({
      incrementalPasses: 1,
      fullRescans: 0,
      affectedRoots: 20,
      elementsProcessed: 40,
      rulesAdded: 40,
    });

    await page.evaluate(() => window.dash.toggleTheme());
    delta = await step();
    expect(delta).toMatchObject({ fullRescans: 1 });
    expect(await ruleTotal(page)).toBe(40); // dark rules gone, alert rows remain
    await page.evaluate(() => window.dash.toggleTheme());
    expect((await step()).fullRescans).toBe(1);
    expect(await ruleTotal(page)).toBe(47);
    await expectConsistent(page);
    await expectEquivalentToFullRescan(ext, page);
  });

  test('CSS-in-JS: a <style> per component is a throttled rescan; every component ends up adapted', async () => {
    const { page, natural, diag } = await load(ext, server, 'r1-cssinjs.html');
    const conflict = 'color: #c0392b; background-color: #27ae60;';
    await page.evaluate(async (css) => {
      const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
      for (let i = 0; i < 6; i += 1) {
        window.styled.component(`cmp${i}`, css);
        await frame();
      }
    }, conflict);
    const delta = await natural();
    expect(delta.fullRescans).toBeGreaterThanOrEqual(1);
    expect(delta.fullRescans).toBeLessThanOrEqual(6);
    expect(delta.incrementalPasses).toBeLessThanOrEqual(6);
    for (let i = 0; i < 6; i += 1) expect(await rule(page, `cmp${i}`), `cmp${i}`).toBe(true);
    expect(await diag()).toMatchObject({
      pendingRescan: null,
      throttleTimerActive: false,
      state: 'IDLE',
    });
    await expectConsistent(page);
    await expectEquivalentToFullRescan(ext, page);
  });

  test('CSS-in-JS speedy mode: new components are adapted, a CSSOM-only restyle of an old one waits for refresh()', async () => {
    const { page, step } = await load(ext, server, 'r1-cssinjs.html');
    const conflict = 'color: #c0392b; background-color: #27ae60;';
    await page.evaluate(() =>
      window.styled.speedyComponent('fine', 'color: #000000; background-color: #ffffff;'),
    );
    await step();
    await page.evaluate((css) => window.styled.speedyComponent('conflicting', css), conflict);
    await step();
    // insertRule adds no mutation, but the new element's own insertion is a mutation and is analyzed afterwards
    expect(await rule(page, 'conflicting')).toBe(true);
    expect(await rule(page, 'fine')).toBe(false);

    const before = await step();
    expectNoWork(before);
    await page.evaluate((css) => {
      const sheet = (document.querySelector('style[data-emotion="speedy"]') as HTMLStyleElement)
        .sheet!;
      sheet.insertRule(`#fine { ${css} }`, sheet.cssRules.length); // restyles an existing element, CSSOM only
    }, conflict);
    const delta = await step();
    expect(delta.mutationRecords).toBe(0);
    expectNoWork(delta);
    expect(await rule(page, 'fine')).toBe(false); // the documented limitation
    expect((await computedColors(page, ['fine']))['fine']).toBe(ORIGINAL_BAD);

    await refresh(ext.worker, page);
    await settle(page);
    expect(await rule(page, 'fine')).toBe(true);
    await expectConsistent(page);
  });

  test('hostile CSS: overrides that cannot be beaten are detected, never stale, never looped', async () => {
    const { page, step, natural, diag } = await load(ext, server, 'r1-hostile.html');
    // an id chain with !important and an inline !important outrank ColorAdapt: not applied (no rule at all)
    for (const id of ['locked', 'locked2', 'inline']) {
      expect(await rule(page, id), id).toBe(false);
      expect((await computedColors(page, [id]))[id]).toBe(ORIGINAL_BAD);
    }
    // everything ColorAdapt can win is adapted
    for (const id of ['soft', 'piled', 'plain']) {
      expect(await rule(page, id), id).toBe(true);
      expect((await computedColors(page, [id]))[id]).not.toBe(ORIGINAL_BAD);
    }

    // more hostile content, dynamically: no rules, one pass, no repeat
    await page.evaluate(() => window.addHostile('hx', 50));
    let delta = await step();
    expect(delta.incrementalPasses).toBe(1);
    expect(delta.rulesAdded).toBe(0);
    expect(await ruleTotal(page)).toBe(3);
    await settle(page);
    await settle(page);
    expectNoWork(await natural()); // not retried by itself, not looping

    await page.evaluate(() => window.addPlain('pl', 50));
    delta = await step();
    expect(delta).toMatchObject({ incrementalPasses: 1, rulesAdded: 50 });

    // the page drops its override: the element becomes adaptable on the next pass of its region
    await page.evaluate(() => {
      const el = document.getElementById('locked')!;
      el.className = 'plain-now bad';
    });
    delta = await step();
    expect(delta.incrementalPasses).toBe(1);
    expect(await rule(page, 'locked')).toBe(true);
    expect(await staleRules(page)).toBe(0);
    await expectConsistent(page);
    expect((await diag()).state).toBe('IDLE');
    await expectEquivalentToFullRescan(ext, page);
  });

  test('rapid DOM churn for 120 frames: at most one pass per frame, no rescans, a consistent end state', async () => {
    const { page, natural } = await load(ext, server, 'r1-churn.html');
    const FRAMES = 120;
    await page.evaluate((n) => window.churn(n), FRAMES);
    const delta = await natural();
    expect(delta.fullRescans).toBe(0);
    expect(delta.incrementalPasses).toBeGreaterThan(0);
    expect(delta.incrementalPasses).toBeLessThanOrEqual(FRAMES + 2);
    expect(delta.elementsProcessed).toBeLessThanOrEqual(8 * FRAMES);
    expect(delta.queueOverflows).toBe(0);
    await expectConsistent(page);
    await expectEquivalentToFullRescan(ext, page);
    expect((await allIds(page)).length).toBeGreaterThan(0);
    test.info().annotations.push({
      type: 'counters',
      description: `R1-12 churn: frames=${FRAMES} passes=${delta.incrementalPasses} elements=${delta.elementsProcessed} records=${delta.mutationRecords} batches=${delta.batches}`,
    });
  });
});
