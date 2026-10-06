/**
 * SPA behavior on a controlled single-page app (the page's own `history.pushState`, never patched by
 * ColorAdapt): route A -> B -> C -> back -> forward, with the developer audit open. Checks the current URL in
 * the audit, stale findings, stale highlight, duplicate observers, the export URL, focus, adaptation, and (Chrome)
 * leaks over 500 route changes.
 */
import { expect, test } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAuditReport } from '../src/core/audit';
import type { DynamicDiagnostics } from '../src/domain/models';
import { BUDGETS } from './budgets';
import { startChrome, startFirefox, type ChromeDriver, type Driver } from './lib/driver';
import { counters, isChrome } from './lib/metrics';
import { startFixtureServer, type FixtureServer } from './lib/server';
import {
  BROWSERS,
  SETTINGS_ON,
  affected,
  auditRun,
  hasStylesheet,
  html,
  record,
  settled,
  until,
} from './lib/scenario';

const AREA = 'spa';

const SPA = html(
  `
  <nav><a id="to-a" href="/spa/a" data-link>A</a> <a id="to-b" href="/spa/b" data-link>B</a> <a id="to-c" href="/spa/c" data-link>C</a></nav>
  <main id="view"></main>
  <script>
    const views = {
      a: '<p id="a-low" class="low">Route A low contrast text</p>',
      b: '<p id="b-cvd" class="cvd">Route B red on green text</p>',
      c: '<ul id="c-list"><li class="low">c one</li><li class="low">c two</li></ul>',
    };
    const render = () => { document.getElementById('view').innerHTML = views[location.pathname.split('/')[2]] || views.a; };
    document.addEventListener('click', (e) => {
      const a = e.target.closest('[data-link]');
      if (!a) return;
      e.preventDefault();
      history.pushState({}, '', a.getAttribute('href'));
      render();
    });
    addEventListener('popstate', render);
    window.go = (name) => { history.pushState({}, '', '/spa/' + name); render(); };
    window.__marker = 'alive';
    render();
  </script>`,
);

for (const browser of BROWSERS) {
  test.describe(`spa ${browser}`, () => {
    test.describe.configure({ mode: 'serial' });
    let driver: Driver;
    let server: FixtureServer;
    let downloads: string;

    test.beforeAll(async () => {
      server = await startFixtureServer();
      server.serve('spa/*', SPA);
      downloads = mkdtempSync(path.join(tmpdir(), 'coloradapt-spa-'));
      if (browser === 'chrome') {
        driver = await startChrome();
        const session = await (driver as ChromeDriver).newBrowserSession();
        await session.send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: downloads,
        });
      } else {
        driver = await startFirefox({
          prefs: {
            'browser.download.folderList': 2,
            'browser.download.dir': downloads,
            'browser.download.useDownloadDir': true,
            'browser.helperApps.neverAsk.saveToDisk': 'application/json,text/html',
          },
        });
      }
      await driver.setSettings(SETTINGS_ON);
    });
    test.afterAll(async () => {
      await driver?.close();
      await server?.close();
      rmSync(downloads, { recursive: true, force: true });
    });

    test('route A -> B -> C -> back -> forward with the audit open', async () => {
      const page = await driver.newTab();
      await page.open(`${server.origin}/spa/a`);
      await until(() => page.ext('GET_DYNAMIC_DIAGNOSTICS'), 'content script on route A');
      const tabId = await driver.extensionEval<number>(
        `(async () => { const api = globalThis.browser ?? globalThis.chrome; const t = (await api.tabs.query({})).filter((x) => x.url === ${JSON.stringify(await page.url())}); return t[0].id; })()`,
      );
      const audit = await driver.extensionTab(`audit.html?tabId=${tabId}`);
      const pageLine = () =>
        audit.evaluate<string>(
          `document.querySelector('[data-testid="page-line"]')?.textContent ?? ''`,
        );
      await until(
        async () => (await pageLine()).includes('/spa/a'),
        'audit page line shows /spa/a',
      );

      const startStarts = (await page.ext<DynamicDiagnostics>('GET_DYNAMIC_DIAGNOSTICS'))
        .observerStarts;
      const visit = async (selector: string, route: string) => {
        await page.click(selector);
        await until(async () => (await page.url()).endsWith(route), `url ${route}`);
        await until(
          async () => (await pageLine()).includes(route),
          `audit page line shows ${route}`,
        );
        await until(
          () => audit.evaluate<boolean>(`!document.querySelector('[data-testid="route-pending"]')`),
          `route-pending cleared on ${route}`,
        );
        await settled(page);
        expect(await page.evaluate<string>('window.__marker')).toBe('alive'); // client-side navigation, no reload
      };

      // A
      let snap = await auditRun(page);
      expect(snap.page.pathname).toBe('/spa/a');
      expect(affected(snap, 'CA-COLOR-001')).toEqual(['#a-low']);

      // highlight an element of route A, then leave the route: the highlight must not stay behind
      const finding = snap.findings.find((f) => f.ruleId === 'CA-COLOR-001')!;
      const shown = await page.ext<{ ok: boolean }>('AUDIT_HIGHLIGHT', {
        findingId: finding.id,
        index: 0,
        scroll: false,
      });
      expect(shown.ok).toBe(true);
      expect(
        await page.evaluate<boolean>(
          `document.querySelector('[data-coloradapt-audit-overlay]') !== null`,
        ),
      ).toBe(true);

      await visit('#to-b', '/spa/b');
      // adaptation follows the route: the color-vision pair that just appeared is recolored (its source color is #d62728)
      await until(
        async () =>
          (await page.evaluate<string>(
            `getComputedStyle(document.getElementById('b-cvd')).color`,
          )) !== 'rgb(214, 39, 40)',
        'route B adapted',
      );
      expect(await hasStylesheet(page)).toBe(true);
      snap = await auditRun(page);
      expect(snap.page.pathname).toBe('/spa/b');
      expect(affected(snap, 'CA-COLOR-001')).not.toContain('#a-low'); // no stale finding of route A
      expect(affected(snap, 'CA-COLOR-002')).toEqual(['#b-cvd']);
      await until(
        () =>
          page.evaluate<boolean>(
            `document.querySelector('[data-coloradapt-audit-overlay]') === null`,
          ),
        'no stale highlight after leaving route A',
      );

      await visit('#to-c', '/spa/c');
      snap = await auditRun(page);
      expect(snap.page.pathname).toBe('/spa/c');
      expect(affected(snap, 'CA-COLOR-002')).toEqual([]);
      expect(snap.findings.every((f) => f.affected.every((a) => a.locator.id !== 'b-cvd'))).toBe(
        true,
      );

      // browser back -> B, forward -> C
      await page.back();
      await until(async () => (await page.url()).endsWith('/spa/b'), 'back to /spa/b');
      await until(async () => (await pageLine()).includes('/spa/b'), 'audit follows back');
      await settled(page);
      snap = await auditRun(page);
      expect(affected(snap, 'CA-COLOR-002')).toEqual(['#b-cvd']);
      await page.forward();
      await until(async () => (await page.url()).endsWith('/spa/c'), 'forward to /spa/c');
      await until(async () => (await pageLine()).includes('/spa/c'), 'audit follows forward');
      await settled(page);

      // the export carries the current route and nothing else
      // export stays paused while the route is pending, then becomes available for the new route
      await until(
        () => audit.evaluate<boolean>(`!document.querySelector('[data-testid="route-pending"]')`),
        'route-pending cleared after forward',
      );
      await audit.evaluate(
        `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Export JSON').click()`,
      );
      // a download can be visible before it is complete: wait until the file is a complete, valid report
      const exported = await until(() => {
        const name = readdirSync(downloads).find((f) => f.endsWith('.json'));
        if (!name) return null;
        const parsed = parseAuditReport(readFileSync(path.join(downloads, name), 'utf8'));
        return parsed.ok ? parsed : null;
      }, 'a complete JSON export');
      expect(exported.report.page.pathname).toBe('/spa/c');

      // no duplicate observers: the pipeline connected its observer once for this page
      const diag = await page.ext<DynamicDiagnostics>('GET_DYNAMIC_DIAGNOSTICS');
      expect(diag.observerStarts).toBe(startStarts);
      // focus: keyboard focus on the page is not stolen by route changes or audit refreshes
      expect(
        await page.evaluate<string>(
          `document.activeElement ? document.activeElement.localName : ''`,
        ),
      ).not.toBe('input');

      record(
        driver,
        AREA,
        'fixture SPA: A->B->C->back->forward, audit URL, no stale finding/highlight, one observer, export URL',
        'PASS',
        `observerStarts ${diag.observerStarts}`,
      );
      await audit.close();
      await page.close();
    });

    test('500 route changes leave nothing behind', async () => {
      const page = await driver.newTab();
      await page.open(`${server.origin}/spa/a`);
      await until(() => page.ext('GET_DYNAMIC_DIAGNOSTICS'), 'content script');
      const names = ['a', 'b', 'c'];
      const burst = async (from: number, to: number) => {
        await page.evaluate(
          `(async () => { const names = ['a','b','c']; for (let i = ${from}; i < ${to}; i++) { window.go(names[i % 3]); await new Promise((r) => requestAnimationFrame(r)); } })()`,
        );
        await settled(page);
      };
      await burst(0, 50);
      const at50 = await page.ext<DynamicDiagnostics>('GET_DYNAMIC_DIAGNOSTICS');
      const c50 = isChrome(page) ? await counters(page) : null;
      // structural proxies that need no heap or listener counters (Firefox, through geckodriver, has none):
      // what ColorAdapt owns in the page's DOM, and the page's own node count
      const structural = () =>
        page.evaluate<{ owned: number; styles: number; nodes: number }>(
          `({ owned: document.querySelectorAll('[data-coloradapt-id],[data-coloradapt-chart-node],[data-coloradapt-audit-overlay]').length, styles: document.querySelectorAll('style[id^="coloradapt-"]').length, nodes: document.getElementsByTagName('*').length })`,
        );
      const s50 = await structural();
      await burst(50, 500);
      const s500 = await structural();
      const at500 = await page.ext<DynamicDiagnostics>('GET_DYNAMIC_DIAGNOSTICS');
      const c500 = isChrome(page) ? await counters(page) : null;
      // M10.R1: warm-up versus leak. The 50 -> 500 ratio mixes the two; a steady state does not grow between
      // 500 and 1500 route changes, a leak does.
      const c500b = c500;
      await burst(500, 1500);
      const c1500 = isChrome(page) ? await counters(page) : null;
      if (c500b && c1500) {
        record(
          driver,
          'memory',
          'SPA route changes: heap 500 -> 1500 (steady state, not warm-up)',
          'INFO',
          `heap ${(c500b.heapBytes / 1e6).toFixed(3)} -> ${(c1500.heapBytes / 1e6).toFixed(3)} MB, nodes ${c500b.nodes}->${c1500.nodes}, listeners ${c500b.listeners}->${c1500.listeners}`,
        );
      }

      expect(at500.observerStarts).toBe(at50.observerStarts);
      expect(at500.queuedRecords).toBe(0);
      expect(at500.deferredRoots).toBe(0);
      expect(at500.trackedElements).toBeLessThanOrEqual(at50.trackedElements + 5);
      expect(at500.rules).toBeLessThanOrEqual(at50.rules + 5);
      expect(names.length).toBe(3);
      const audit = await auditRun(page);
      expect(audit.page.pathname).toMatch(/^\/spa\/[abc]$/);
      let detail = `tracked ${at50.trackedElements}->${at500.trackedElements}, rules ${at50.rules}->${at500.rules}, observerStarts ${at500.observerStarts}`;
      if (c50 && c500) {
        expect(
          c500.heapBytes / c50.heapBytes,
          `heap ${c50.heapBytes} -> ${c500.heapBytes} bytes after a forced GC`,
        ).toBeLessThanOrEqual(BUDGETS.heapGrowthRatio);
        expect(c500.nodes / c50.nodes).toBeLessThanOrEqual(BUDGETS.domGrowthRatio);
        expect(c500.listeners / Math.max(1, c50.listeners)).toBeLessThanOrEqual(
          BUDGETS.domGrowthRatio,
        );
        detail += `; heap ${(c50.heapBytes / 1e6).toFixed(3)}->${(c500.heapBytes / 1e6).toFixed(3)} MB, nodes ${c50.nodes}->${c500.nodes}, listeners ${c50.listeners}->${c500.listeners}`;
        record(driver, 'memory', 'SPA route changes x500: heap/DOM/listeners flat', 'PASS', detail);
      } else {
        // structural proxies instead: the elements ColorAdapt marked and the style nodes it owns do not grow
        // with 450 more route changes, nor does the page's own node count
        expect(s500.styles).toBeLessThanOrEqual(1);
        expect(s500.owned).toBeLessThanOrEqual(s50.owned + 5);
        expect(s500.nodes).toBeLessThanOrEqual(s50.nodes + 5);
        record(
          driver,
          'memory',
          'SPA route changes x500: structural proxies flat (owned DOM artifacts, style nodes, node count)',
          'PASS',
          `owned ${s50.owned}->${s500.owned}, style nodes ${s50.styles}->${s500.styles}, nodes ${s50.nodes}->${s500.nodes}; ${detail}`,
        );
        record(
          driver,
          'memory',
          'SPA route changes x500: heap/DOM/listeners flat',
          'NOT_VERIFIED',
          `NOT_MEASURABLE_WITH_CURRENT_HARNESS: geckodriver exposes no heap or listener counters; covered by the structural proxies and the pipeline counters (${detail})`,
        );
      }
      record(
        driver,
        AREA,
        '500 route changes: observers, tracked elements, rules flat',
        'PASS',
        detail,
      );

      await page.close();
    });
  });
}
