import { expect, test, type Page } from '@playwright/test';
import {
  computedColors,
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
  type Loaded,
} from './r1-kit';

/**
 * M4.R1 sections F, G and 10, real Chromium: stylesheet invalidation (inline
 * `<style>` and `<link>` in every way they can change), the documented CSSOM
 * limitation, and the full-rescan throttle. Link loads are driven by the test
 * server (`/slow-<name>.css` answers only when released), so no assertion
 * depends on network timing.
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

const CONFLICT = 'color: #c0392b; background-color: #27ae60;';
const FINE = 'color: #000000; background-color: #ffffff;';

/** Adds `<p id class>` elements to `#app` (and settles). */
async function addPills(loaded: Loaded, ids: Record<string, string>): Promise<void> {
  await loaded.page.evaluate((entries) => {
    for (const [id, cls] of Object.entries(entries)) {
      document
        .getElementById('app')!
        .insertAdjacentHTML('beforeend', `<p id="${id}" class="${cls}">${id}</p>`);
    }
  }, ids);
  await loaded.step();
}

const addStyle = (page: Page, css: string, id = ''): Promise<void> =>
  page.evaluate(
    ([text, styleId]) => {
      const style = document.createElement('style');
      if (styleId) style.id = styleId;
      style.textContent = text!;
      document.head.append(style);
    },
    [css, id],
  );

const addLink = (page: Page, name: string, id: string): Promise<void> =>
  page.evaluate(
    ([href, linkId]) => {
      const link = document.createElement('link');
      link.id = linkId!;
      link.rel = 'stylesheet';
      link.href = href!;
      document.head.append(link);
    },
    [`/slow-${name}.css`, id],
  );

/** The link has a sheet and the pipeline has seen its `load` (it is no longer waited on). */
async function awaitLoad(loaded: Loaded, id: string): Promise<void> {
  await expect.poll(() => linkLoaded(loaded.page, id)).toBe(true);
  await expect.poll(async () => (await loaded.diag()).pendingLinks).toBe(0);
}

const linkLoaded = (page: Page, id: string): Promise<boolean> =>
  page.evaluate(
    (linkId) => (document.getElementById(linkId) as HTMLLinkElement).sheet !== null,
    id,
  );

test.describe('R1-F. stylesheet invalidation', () => {
  test('<style> insertion, text replacement (three ways) and removal are one rescan each', async () => {
    const loaded = await load(ext, server);
    const { page, step } = loaded;
    await addPills(loaded, { late: 'late' });
    expect(await rule(page, 'late')).toBe(false);

    await addStyle(page, `.late { ${CONFLICT} }`, 'pagecss');
    const inserted = await step();
    expect(inserted.fullRescans).toBe(1);
    expect(inserted.fullRescansByReason).toEqual({ stylesheet: 1 });
    expect(inserted.incrementalPasses).toBe(0);
    expect(await rule(page, 'late')).toBe(true);

    // textContent replacement: childList on <style>
    await page.evaluate(
      (css) => (document.getElementById('pagecss')!.textContent = css),
      `.late { ${FINE} }`,
    );
    const replaced = await step();
    expect(replaced.fullRescansByReason).toEqual({ stylesheet: 1 });
    expect(await rule(page, 'late')).toBe(false);

    // in-place data change of the style's text node: characterData
    await page.evaluate(
      (css) => ((document.getElementById('pagecss')!.firstChild as Text).data = css),
      `.late { ${CONFLICT} }`,
    );
    const edited = await step();
    expect(edited.fullRescansByReason).toEqual({ stylesheet: 1 });
    expect(await rule(page, 'late')).toBe(true);

    // appending a second text node (CSS-in-JS style)
    await page.evaluate(() =>
      document.getElementById('pagecss')!.append(document.createTextNode('.late { opacity: 1 }')),
    );
    expect((await step()).fullRescansByReason).toEqual({ stylesheet: 1 });

    await page.evaluate(() => document.getElementById('pagecss')!.remove());
    const removed = await step();
    expect(removed.fullRescansByReason).toEqual({ stylesheet: 1 });
    expect(await rule(page, 'late')).toBe(false);
    expect((await computedColors(page, ['late']))['late']).toBe('rgb(0, 0, 0)');
    await expectConsistent(page);
    await expectEquivalentToFullRescan(ext, page);
  });

  test('a <style> inside an inserted subtree is found and rescanned once', async () => {
    const loaded = await load(ext, server);
    const { page, step } = loaded;
    await page.evaluate(() =>
      document
        .getElementById('app')!
        .insertAdjacentHTML(
          'beforeend',
          '<div><style>.nested { color: #c0392b; background-color: #27ae60; }</style><p id="nested" class="nested">n</p></div>',
        ),
    );
    const delta = await step();
    expect(delta.fullRescansByReason).toEqual({ stylesheet: 1 });
    expect(delta.incrementalPasses).toBe(0);
    expect(await rule(page, 'nested')).toBe(true);
  });

  test('<link> inserted before it loads: no premature analysis, one rescan after load, listener released', async () => {
    const loaded = await load(ext, server);
    const { page, step, diag, natural } = loaded;
    await addPills(loaded, { themed1: 'themed' });
    expect(await rule(page, 'themed1')).toBe(false);

    await addLink(page, 'a', 'lnk');
    await expect.poll(() => server.waiting('a')).toBe(1);
    const pending = await step();
    expect(pending.fullRescans).toBe(0);
    expectNoWork(pending);
    expect((await diag()).pendingLinks).toBe(1);
    expect(await linkLoaded(page, 'lnk')).toBe(false);
    expect(await rule(page, 'themed1')).toBe(false); // nothing was decided on an unloaded sheet

    server.release('a');
    await awaitLoad(loaded, 'lnk');
    const done = await natural();
    expect(done.fullRescansByReason).toEqual({ stylesheet: 1 });
    expect((await diag()).pendingLinks).toBe(0);
    expect(await rule(page, 'themed1')).toBe(true);
    await expectConsistent(page);
    await expectEquivalentToFullRescan(ext, page);
  });

  test('a loaded <link> removed from the document is a stylesheet change (one rescan, rules follow)', async () => {
    const loaded = await load(ext, server);
    const { page, step, diag, natural } = loaded;
    await addPills(loaded, { themed1: 'themed' });
    await addLink(page, 'b', 'lnk');
    await expect.poll(() => server.waiting('b')).toBe(1);
    await step(); // the pipeline is now waiting for it
    server.release('b');
    await awaitLoad(loaded, 'lnk');
    await natural();
    expect(await rule(page, 'themed1')).toBe(true);

    await page.evaluate(() => document.getElementById('lnk')!.remove());
    const delta = await step();
    expect(delta.fullRescansByReason).toEqual({ stylesheet: 1 });
    expect(await rule(page, 'themed1')).toBe(false);
    expect((await computedColors(page, ['themed1']))['themed1']).toBe('rgb(0, 0, 0)');
    expect((await diag()).pendingLinks).toBe(0);
    await expectConsistent(page);
  });

  test('a pending <link> removed before it loads: listener released at once, a late response does nothing', async () => {
    const loaded = await load(ext, server);
    const { page, step, diag } = loaded;
    await addPills(loaded, { themed1: 'themed' });
    await addLink(page, 'c', 'lnk');
    await expect.poll(() => server.waiting('c')).toBe(1);
    await step();
    expect((await diag()).pendingLinks).toBe(1);

    await page.evaluate(() => document.getElementById('lnk')!.remove());
    const removed = await step();
    // A removed link is always a stylesheet change (it cannot be told from a loaded one):
    // one harmless rescan, and the wait is over.
    expect(removed.fullRescansByReason).toEqual({ stylesheet: 1 });
    expect((await diag()).pendingLinks).toBe(0);

    server.release('c'); // the response arrives for a link nobody is waiting for
    await settle(page);
    await settle(page);
    const after = await step();
    expectNoWork(after);
    expect((await diag()).pendingLinks).toBe(0);
    expect(await rule(page, 'themed1')).toBe(false);
  });

  test('many pending links come and go: the pending set returns to zero', async () => {
    const loaded = await load(ext, server);
    const { page, step, diag, natural } = loaded;
    for (let i = 0; i < 6; i += 1) await addLink(page, `bulk${i}`, `bulk${i}`);
    await expect.poll(() => server.waiting('bulk5')).toBe(1);
    await step();
    expect((await diag()).pendingLinks).toBe(6);

    await page.evaluate(() => {
      document.getElementById('bulk0')!.remove();
      document.getElementById('bulk1')!.remove();
    });
    await step();
    expect((await diag()).pendingLinks).toBe(4);

    for (let i = 2; i < 6; i += 1) server.release(`bulk${i}`, '.nothing { color: #000 }');
    await awaitLoad(loaded, 'bulk5');
    await natural();
    expect((await diag()).pendingLinks).toBe(0);
    server.release('bulk0');
    server.release('bulk1');
  });

  test('a link that errors (404) also ends the wait, with one rescan', async () => {
    const loaded = await load(ext, server);
    const { page, step, diag, natural } = loaded;
    await addLink(page, 'bad', 'lnk');
    await expect.poll(() => server.waiting('bad')).toBe(1);
    await step();
    server.fail('bad');
    await expect
      .poll(() => diag().then((d) => d.fullRescans + d.pendingLinks), { timeout: 10_000 })
      .toBeGreaterThan(0);
    const done = await natural();
    expect((await diag()).pendingLinks).toBe(0);
    expect(done.fullRescansByReason).toEqual({ stylesheet: 1 });
  });

  test('media changes on <style> and <link> are rescans', async () => {
    const loaded = await load(ext, server);
    const { page, step } = loaded;
    await addPills(loaded, { m1: 'm1' });
    await page.evaluate((css) => {
      const style = document.createElement('style');
      style.id = 'ms';
      style.media = 'print';
      style.textContent = css;
      document.head.append(style);
    }, `.m1 { ${CONFLICT} }`);
    await step(); // inserted (media does not match: no effect on screen)
    expect(await rule(page, 'm1')).toBe(false);

    await page.evaluate(() => document.getElementById('ms')!.setAttribute('media', 'all'));
    const delta = await step();
    expect(delta.fullRescansByReason).toEqual({ stylesheet: 1 });
    expect(await rule(page, 'm1')).toBe(true);

    await page.evaluate(() => document.getElementById('ms')!.setAttribute('media', 'print'));
    expect((await step()).fullRescansByReason).toEqual({ stylesheet: 1 });
    expect(await rule(page, 'm1')).toBe(false);
  });

  test('<link disabled> toggled is a rescan and the rules follow', async () => {
    const loaded = await load(ext, server);
    const { page, step, natural, diag } = loaded;
    await addPills(loaded, { d1: 'themed' });
    await addLink(page, 'dis', 'dl');
    await expect.poll(() => server.waiting('dis')).toBe(1);
    await step();
    server.release('dis');
    await awaitLoad(loaded, 'dl');
    await natural();
    expect(await rule(page, 'd1')).toBe(true);

    await page.evaluate(() => document.getElementById('dl')!.setAttribute('disabled', ''));
    expect((await step()).fullRescansByReason).toEqual({ stylesheet: 1 });
    expect(await rule(page, 'd1')).toBe(false);
    expect((await computedColors(page, ['d1']))['d1']).toBe('rgb(0, 0, 0)');

    await page.evaluate(() => document.getElementById('dl')!.removeAttribute('disabled'));
    await step(); // a re-enabled link has no sheet until it has loaded again
    expect((await diag()).pendingLinks).toBe(1);
    await expect.poll(() => server.waiting('dis')).toBe(1); // re-enabling fetches it again
    server.release('dis');
    await expect.poll(async () => (await diag()).pendingLinks).toBe(0);
    await natural();
    expect(await rule(page, 'd1')).toBe(true);
    await expectConsistent(page);
  });

  test('rel changes: preload -> stylesheet loads and rescans once; stylesheet -> preload rescans', async () => {
    const loaded = await load(ext, server);
    const { page, step, diag, natural } = loaded;
    await addPills(loaded, { themed1: 'themed' });

    await page.evaluate(() => {
      const link = document.createElement('link');
      link.id = 'rl';
      link.rel = 'preload';
      link.setAttribute('as', 'style');
      link.href = '/slow-rel.css';
      document.head.append(link);
    });
    const inserted = await step();
    expectNoWork(inserted);
    expect(inserted.fullRescans).toBe(0);

    await page.evaluate(
      () => ((document.getElementById('rl') as HTMLLinkElement).rel = 'stylesheet'),
    );
    await expect.poll(() => server.waiting('rel')).toBeGreaterThan(0);
    const switched = await step();
    expect(switched.fullRescans).toBe(0); // not loaded yet: nothing to decide
    expect((await diag()).pendingLinks).toBe(1);

    server.release('rel');
    await awaitLoad(loaded, 'rl');
    const done = await natural();
    expect(done.fullRescansByReason).toEqual({ stylesheet: 1 });
    expect(await rule(page, 'themed1')).toBe(true);
    expect((await diag()).pendingLinks).toBe(0);

    await page.evaluate(() => ((document.getElementById('rl') as HTMLLinkElement).rel = 'preload'));
    const off = await step();
    expect(off.fullRescansByReason).toEqual({ stylesheet: 1 });
    expect(await rule(page, 'themed1')).toBe(false);
  });

  test('href change on a loaded <link>: the new stylesheet is awaited and the final state follows it', async () => {
    const loaded = await load(ext, server);
    const { page, step, diag, natural } = loaded;
    await addPills(loaded, { themed1: 'themed' });
    await page.evaluate((href) => {
      const link = document.createElement('link');
      link.id = 'lk';
      link.rel = 'stylesheet';
      link.href = href;
      document.head.append(link);
    }, `${server.origin}/dynamic-theme.css`);
    await awaitLoad(loaded, 'lk');
    await natural();
    expect(await rule(page, 'themed1')).toBe(true);

    // Swap to a stylesheet that makes .themed accessible, delivered only when released.
    await page.evaluate(
      () => ((document.getElementById('lk') as HTMLLinkElement).href = '/slow-swap.css'),
    );
    await expect.poll(() => server.waiting('swap')).toBe(1);
    // The old sheet still applies: nothing may be decided (or rescanned) until the new one is in.
    const swapping = await step();
    expect(swapping.fullRescans).toBe(0);
    expect((await diag()).pendingLinks).toBe(1);
    expect(await rule(page, 'themed1')).toBe(true);
    server.release('swap', `.themed { ${FINE} }`);
    await expect
      .poll(
        () => page.evaluate(() => getComputedStyle(document.getElementById('themed1')!).color),
        {
          message: 'the swapped stylesheet has been applied by the browser',
        },
      )
      .not.toBe('rgb(192, 57, 43)');
    await expect.poll(async () => (await diag()).pendingLinks).toBe(0); // load event seen
    const swapped = await natural();
    expect(swapped.fullRescansByReason).toEqual({ stylesheet: 1 });
    expect(await rule(page, 'themed1')).toBe(false);
    expect((await computedColors(page, ['themed1']))['themed1']).toBe('rgb(0, 0, 0)');
    expect((await diag()).pendingLinks).toBe(0);
    await expectConsistent(page);
    await expectEquivalentToFullRescan(ext, page);
  });

  test('a subtree holding a pending <link> adapts its own content now, and rescans once the link loads', async () => {
    const loaded = await load(ext, server);
    const { page, step, diag, natural } = loaded;
    await page.evaluate(() =>
      document
        .getElementById('app')!
        .insertAdjacentHTML(
          'beforeend',
          '<div id="widget"><link id="wl" rel="stylesheet" href="/slow-widget.css"><p id="wp" class="bad">content</p><p id="wt" class="themed">themed</p></div>',
        ),
    );
    await expect.poll(() => server.waiting('widget')).toBe(1);
    const first = await step();
    expect(first.fullRescans).toBe(0); // the link is still loading
    expect(await rule(page, 'wp')).toBe(true); // ...but the content did not wait for it
    expect(await rule(page, 'wt')).toBe(false);
    expect((await diag()).pendingLinks).toBe(1);

    server.release('widget');
    await awaitLoad(loaded, 'wl');
    const done = await natural();
    expect(done.fullRescansByReason).toEqual({ stylesheet: 1 });
    expect(await rule(page, 'wt')).toBe(true);
    expect((await diag()).pendingLinks).toBe(0);
    await expectConsistent(page);
  });

  test('a link that is already loaded when inserted (cached/inline data URL) needs no wait', async () => {
    const loaded = await load(ext, server);
    const { page, step, diag } = loaded;
    await addPills(loaded, { themed1: 'themed' });
    await page.evaluate(() => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `data:text/css,${encodeURIComponent('.themed { color: #c0392b; background-color: #27ae60; }')}`;
      document.head.append(link);
    });
    await expect
      .poll(() => diag().then((d) => d.fullRescans + d.pendingLinks), {
        message: 'rescan or pending',
      })
      .toBeGreaterThan(0);
    const delta = await loaded.natural();
    void step;
    expect(delta.fullRescansByReason).toEqual({ stylesheet: 1 });
    expect(await rule(page, 'themed1')).toBe(true);
    expect((await diag()).pendingLinks).toBe(0);
  });

  test('turning ColorAdapt OFF while links are pending releases every listener', async () => {
    const loaded = await load(ext, server);
    const { page, step, diag } = loaded;
    await addLink(page, 'offa', 'o1');
    await addLink(page, 'offb', 'o2');
    await expect.poll(() => server.waiting('offb')).toBe(1);
    await step();
    expect((await diag()).pendingLinks).toBe(2);

    const { disable } = await import('./harness');
    await disable(ext.worker, page);
    const off = await diag();
    expect(off.pendingLinks).toBe(0);
    expect(off.state).toBe('STOPPED');
    server.release('offa');
    server.release('offb');
    await settle(page);
    expect((await diag()).fullRescans).toBe(off.fullRescans);
  });
});

test.describe('R1-G. documented CSSOM limitation', () => {
  async function cssomPage() {
    const loaded = await load(ext, server);
    await addPills(loaded, { late: 'late', late2: 'late2' });
    await addStyle(loaded.page, '.unrelated { opacity: 1 }', 'pagecss');
    await loaded.step();
    return loaded;
  }

  test('insertRule / deleteRule are not detected; refresh() makes the state correct', async () => {
    const { page, step } = await cssomPage();
    expect(await rule(page, 'late')).toBe(false);

    await page.evaluate((css) => {
      const sheet = (document.getElementById('pagecss') as HTMLStyleElement).sheet!;
      sheet.insertRule(css, sheet.cssRules.length);
    }, `.late { ${CONFLICT} }`);
    const inserted = await step();
    // Not detected: no mutation was delivered and no work was done...
    expect(inserted.mutationRecords).toBe(0);
    expectNoWork(inserted);
    expect(await rule(page, 'late')).toBe(false);
    // ...so the conflicting colors are on screen, unadapted (the documented limitation).
    expect((await computedColors(page, ['late']))['late']).toBe(ORIGINAL_BAD);

    await refresh(ext.worker, page);
    await settle(page);
    await step(); // re-baseline: the refresh's own writes are not part of what follows
    expect(await rule(page, 'late')).toBe(true);
    expect((await computedColors(page, ['late']))['late']).not.toBe(ORIGINAL_BAD);

    // deleteRule: the conflict is gone, our now-stale rule stays until the next refresh.
    await page.evaluate(() => {
      const sheet = (document.getElementById('pagecss') as HTMLStyleElement).sheet!;
      sheet.deleteRule(sheet.cssRules.length - 1);
    });
    const deleted = await step();
    expect(deleted.mutationRecords).toBe(0);
    expectNoWork(deleted);
    expect(await rule(page, 'late')).toBe(true); // stale, as documented

    await refresh(ext.worker, page);
    await settle(page);
    expect(await rule(page, 'late')).toBe(false);
    expect((await computedColors(page, ['late']))['late']).toBe('rgb(0, 0, 0)');
    await expectConsistent(page);
  });

  test('adoptedStyleSheets changes are not detected; refresh() makes the state correct', async () => {
    const { page, step } = await cssomPage();
    const supported = await page.evaluate(
      () =>
        'adoptedStyleSheets' in Document.prototype &&
        typeof CSSStyleSheet.prototype.replaceSync === 'function',
    );
    test.skip(!supported, 'adoptedStyleSheets not supported here');

    await page.evaluate((css) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [sheet];
      (window as unknown as { adopted: CSSStyleSheet }).adopted = sheet;
    }, `.late2 { ${CONFLICT} }`);
    const adopted = await step();
    expect(adopted.mutationRecords).toBe(0);
    expectNoWork(adopted);
    expect(await rule(page, 'late2')).toBe(false);
    expect((await computedColors(page, ['late2']))['late2']).toBe(ORIGINAL_BAD);

    await refresh(ext.worker, page);
    await settle(page);
    await step();
    expect(await rule(page, 'late2')).toBe(true);

    // replaceSync on the adopted sheet: again invisible; refresh reconciles.
    await page.evaluate(
      (css) => (window as unknown as { adopted: CSSStyleSheet }).adopted.replaceSync(css),
      `.late2 { ${FINE} }`,
    );
    expectNoWork(await step());
    expect(await rule(page, 'late2')).toBe(true); // stale
    await refresh(ext.worker, page);
    await settle(page);
    expect(await rule(page, 'late2')).toBe(false);
  });
});

/**
 * Throttle semantics (docs/DYNAMIC_ANALYSIS.md, "Full rescan policy"): rescans
 * may coalesce, none is lost, and the final state reflects every cause. The
 * unforced scheduler is used so the throttle is real; no assertion measures
 * time. Where a throttled path is needed deterministically, the second cause
 * is issued from a `requestAnimationFrame` callback registered after the
 * pipeline's own, i.e. in the very frame that ran the first rescan.
 */
test.describe('R1-10. full-rescan throttle', () => {
  const PILLS = { pa: 'pa', pb: 'pb', pc: 'pc', pd: 'pd', pe: 'pe' };

  async function throttlePage() {
    const loaded = await load(ext, server);
    await addPills(loaded, PILLS);
    // Pre-existing rules that the "theme" and "document-root" causes switch on.
    await addStyle(
      loaded.page,
      `html[data-theme="dark"] .pc { ${CONFLICT} } html.ex .pe { ${CONFLICT} }`,
    );
    await loaded.step();
    for (const id of Object.keys(PILLS)) expect(await rule(loaded.page, id)).toBe(false);
    return loaded;
  }

  const css = (selector: string) => `${selector} { ${CONFLICT} }`;

  test('a burst of causes in one task is one rescan; every cause is reflected', async () => {
    const { page, step } = await throttlePage();
    await page.evaluate(
      ([a, b, d]) => {
        const style = (text: string) => {
          const s = document.createElement('style');
          s.textContent = text;
          document.head.append(s);
        };
        style(a!);
        style(b!);
        document.documentElement.setAttribute('data-theme', 'dark');
        style(d!);
        document.documentElement.classList.add('ex');
      },
      [css('.pa'), css('.pb'), css('.pd')],
    );
    const delta = await step();
    expect(delta.fullRescans).toBe(1);
    for (const id of Object.keys(PILLS)) expect(await rule(page, id), id).toBe(true);
    await expectConsistent(page);
  });

  test('causes in consecutive frames: rescans may coalesce, none is lost, the end is stable', async () => {
    const { page, natural, diag } = await throttlePage();
    // One cause per frame, unforced: stylesheet, stylesheet, theme, stylesheet, document-root.
    await page.evaluate(
      async ([a, b, d]) => {
        const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
        const style = (text: string) => {
          const s = document.createElement('style');
          s.textContent = text;
          document.head.append(s);
        };
        style(a!);
        await frame();
        style(b!);
        await frame();
        document.documentElement.setAttribute('data-theme', 'dark');
        await frame();
        style(d!);
        await frame();
        document.documentElement.classList.add('ex');
      },
      [css('.pa'), css('.pb'), css('.pd')],
    );
    const delta = await natural();
    expect(delta.fullRescans).toBeGreaterThanOrEqual(1);
    expect(delta.fullRescans).toBeLessThanOrEqual(5);
    for (const id of Object.keys(PILLS)) expect(await rule(page, id), id).toBe(true);
    const end = await diag();
    expect(end.pendingRescan).toBeNull();
    expect(end.throttleTimerActive).toBe(false);
    expect(end.state).toBe('IDLE');
    await expectConsistent(page);
    await expectEquivalentToFullRescan(ext, page);
  });

  test('a cause right after a rescan is throttled, then runs: nothing is lost', async () => {
    const { page, natural, diag } = await throttlePage(); // ends with a (forced) rescan
    const before = await diag();
    await addStyle(page, css('.pa'));
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    await addStyle(page, css('.pb'));
    const delta = await natural();
    expect(delta.fullRescans).toBeGreaterThanOrEqual(1);
    expect(delta.fullRescans).toBeLessThanOrEqual(2);
    // The rescans were requested within the 500 ms window of the setup rescan (milliseconds apart).
    expect((await diag()).fullRescansThrottled).toBeGreaterThan(before.fullRescansThrottled);
    expect(await rule(page, 'pa')).toBe(true);
    expect(await rule(page, 'pb')).toBe(true);
    const end = await diag();
    expect(end.pendingRescan).toBeNull();
    expect(end.throttleTimerActive).toBe(false);
    expect(end.state).toBe('IDLE');
  });

  test('incremental work arriving while a rescan is owed is not lost, and does not leave stale state', async () => {
    const { page, natural } = await throttlePage();
    await page.evaluate(
      async ([a, b]) => {
        const style = (text: string) => {
          const s = document.createElement('style');
          s.textContent = text;
          document.head.append(s);
        };
        style(a!);
        await Promise.resolve();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => {
            style(b!); // throttled: a rescan is now owed
            // ...and ordinary mutations arrive during the wait
            document.getElementById('app')!.append(window.rows('inc', 3));
            document.getElementById('pc')!.className = 'pc dark-ish';
            resolve();
          }),
        );
      },
      [css('.pa'), css('.pb')],
    );
    await natural();
    for (const id of ['pa', 'pb', 'inc0', 'inc2']) expect(await rule(page, id), id).toBe(true);
    await expectConsistent(page);
    await expectEquivalentToFullRescan(ext, page);
  });

  test('a mutation arriving immediately before a rescan is covered by it', async () => {
    const { page, step } = await throttlePage();
    await page.evaluate(
      ([a]) => {
        document.getElementById('app')!.append(window.rows('before', 4)); // incremental
        const s = document.createElement('style'); // rescan cause, same batch
        s.textContent = a!;
        document.head.append(s);
      },
      [css('.pa')],
    );
    const delta = await step();
    expect(delta.fullRescans).toBe(1);
    expect(delta.incrementalPasses).toBe(0);
    expect(await rule(page, 'before3')).toBe(true);
    expect(await rule(page, 'pa')).toBe(true);
    await expectConsistent(page);
  });

  test('a mutation made by the page during a rescan is processed right after it', async () => {
    const { page, natural, diag } = await throttlePage();
    // A custom element whose attributeChangedCallback fires synchronously inside the
    // pipeline's own analysis (when ColorAdapt tags it) and appends content: a real
    // mutation *during* the pass.
    await page.evaluate(() => {
      customElements.define(
        'x-spy',
        class extends HTMLElement {
          static observedAttributes = ['data-coloradapt-id'];
          spawned = false;
          attributeChangedCallback(): void {
            if (this.spawned) return;
            this.spawned = true;
            document.getElementById('app')!.append(window.rows('mid', 2));
          }
        },
      );
      document
        .getElementById('app')!
        .insertAdjacentHTML('beforeend', '<x-spy id="spy" class="bad badge">spy</x-spy>');
    });
    await natural();
    const before = await diag();
    expect(await rule(page, 'mid0')).toBe(true); // spawned during the pass that tagged the spy, handled after it

    // Same thing inside a full rescan: make the spy a fresh element and cause a rescan.
    await page.evaluate((a) => {
      document
        .getElementById('app')!
        .insertAdjacentHTML('beforeend', '<x-spy id="spy2" class="bad badge">spy2</x-spy>');
      const s = document.createElement('style');
      s.textContent = a;
      document.head.append(s);
    }, css('.pa'));
    const delta = await natural();
    expect(await rule(page, 'pa')).toBe(true);
    expect(await rule(page, 'mid0')).toBe(true);
    expect(delta.fullRescans).toBe(1);
    const after = await diag();
    expect(after.state).toBe('IDLE');
    expect(after.incrementalPasses - before.incrementalPasses).toBeLessThanOrEqual(2);
    await expectConsistent(page);
    await expectEquivalentToFullRescan(ext, page);
  });
});
