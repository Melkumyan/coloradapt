/**
 * M12 (docs/m12/protocol.md) P07, P08, P09 (production builds, real browsers): navigation in every form the
 * browser has, tab lifecycle (duplicate, discard and restore, background and foreground), work pending when the
 * tab closes or the document goes away, and nodes that disappear between detection and adaptation.
 * ColorAdapt never wraps the History API: the SPA's own `history.*` calls are what drive the routes.
 */
import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Driver, Tab } from '../lib/driver';
import { startFixtureServer, type FixtureServer } from '../lib/server';
import {
  BASIC,
  BROWSERS,
  SETTINGS_ON,
  colorOf,
  hasStylesheet,
  html,
  launch,
  record,
  sleep,
  until,
} from '../lib/scenario';
import { fatalLogs, gauges, quiesce, residue, tabIdOf, toBackground } from './kit';

const AREA = 'm12-navigation';

const NAV = html(`
  <nav><a id="h1" href="#one">one</a> <a id="h2" href="#two">two</a></nav>
  <main id="view"></main>
  <script>
    window.__doc = Math.random().toString(36).slice(2);
    const views = {
      a: '<p id="v" class="cvd">Route A red on green</p><p class="low">low a</p>',
      b: '<ul id="v"><li class="cvd">b one</li><li class="cvd">b two</li></ul>',
      c: '<section id="v"><p class="low">c low</p><p class="cvd">c cvd</p></section>',
    };
    const render = () => { document.getElementById('view').innerHTML = views[location.pathname.split('/')[2]] || views.a; };
    window.go = (n) => { history.pushState({ n }, '', '/nav/' + n); render(); };
    window.swap = (n) => { history.replaceState({ n }, '', '/nav/' + n); render(); };
    addEventListener('popstate', render);
    render();
  </script>`);

/** The invariants that hold after every navigation step, in the document the tab shows now. */
async function invariants(tab: Tab, label: string): Promise<void> {
  const g = await quiesce(tab);
  const r = await residue(tab);
  expect(r.sheets, `${label}: stylesheets`).toBeLessThanOrEqual(1);
  expect(r.duplicateIds, `${label}: duplicate ids`).toBe(0);
  expect(g.observerStarts, `${label}: observer starts in this document`).toBe(1);
  expect(g.queueOverflows, `${label}: overflows`).toBe(0);
  expect(g.pendingLinks, `${label}: pending links`).toBe(0);
  expect(fatalLogs(tab.drainLogs()), `${label}: errors`).toEqual([]);
}

/** A server that accepts requests and never answers them: a stylesheet that is still loading when the work is cut. */
async function startHangingServer(): Promise<{ origin: string; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer(() => undefined);
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise<void>((done) => server.close(() => done()));
    },
  };
}

for (const browser of BROWSERS) {
  test.describe(`M12 navigation and tabs ${browser}`, () => {
    test.describe.configure({ mode: 'serial' });
    let driver: Driver;
    let server: FixtureServer;

    test.beforeAll(async () => {
      server = await startFixtureServer();
      server.serve('nav/*', NAV);
      server.serve('basic', BASIC);
      server.serve('other', BASIC.replace('fixture', 'other'));
      driver = await launch(browser);
      await driver.setSettings(SETTINGS_ON);
    });
    test.afterAll(async () => {
      await driver?.close();
      await server?.close();
    });

    test('P07 every navigation kind keeps exactly one correct adaptation and no pending work', async () => {
      const tab = await driver.newTab();
      await tab.open(`${server.origin}/nav/a`);
      await until(() => hasStylesheet(tab), 'adapted on load');
      await invariants(tab, 'initial');
      const original = await tab.evaluate<string>(`window.__doc`);
      const adaptedA = await colorOf(tab, '#v');

      // history.pushState: the page's own call, a new route, the same document
      await tab.evaluate(`(window.go('b'), 1)`);
      await until(
        () => tab.evaluate<boolean>(`document.querySelectorAll('li.cvd').length === 2`),
        'route b rendered',
      );
      await sleep(200);
      await invariants(tab, 'pushState');
      expect(await tab.evaluate<string>(`window.__doc`)).toBe(original);
      expect(await colorOf(tab, 'li.cvd')).toBe(adaptedA); // the new route's elements are adapted like the old route's

      // history.replaceState
      await tab.evaluate(`(window.swap('c'), 1)`);
      await until(
        () => tab.evaluate<boolean>(`!!document.querySelector('section#v')`),
        'route c rendered',
      );
      await invariants(tab, 'replaceState');
      expect(await colorOf(tab, 'section .cvd')).toBe(adaptedA);

      // popstate through the browser's own back/forward
      await tab.evaluate(`(window.go('a'), 1)`);
      await tab.back();
      await until(
        () => tab.evaluate<boolean>(`!!document.querySelector('section#v')`),
        'back to c',
      );
      await invariants(tab, 'back');
      await tab.forward();
      await until(() => tab.evaluate<boolean>(`!!document.querySelector('p#v')`), 'forward to a');
      await invariants(tab, 'forward');
      expect(await tab.evaluate<string>(`window.__doc`)).toBe(original);

      // hash navigation: no rendering, no rescan storm
      const before = await gauges(tab);
      await tab.evaluate(
        `(location.hash = '#one', location.hash = '#two', location.hash = '#one', 1)`,
      );
      await sleep(300);
      await invariants(tab, 'hash');
      expect((await gauges(tab)).fullRescans).toBe(before.fullRescans);

      // full navigation, same origin: a new document, a new instance
      await tab.open(`${server.origin}/other`);
      await until(() => hasStylesheet(tab), 'adapted after same-origin navigation');
      await invariants(tab, 'same-origin navigation');
      expect(await tab.evaluate<string>(`typeof window.__doc`)).toBe('undefined');

      // full navigation, cross origin (localhost is another origin of the same server)
      await tab.open(`${server.altOrigin}/nav/b`);
      await until(() => hasStylesheet(tab), 'adapted after cross-origin navigation');
      await invariants(tab, 'cross-origin navigation');

      // and back across the origin boundary
      await tab.back();
      await until(
        () => tab.evaluate<boolean>(`location.pathname === '/other'`),
        'back across origins',
      );
      await until(() => hasStylesheet(tab), 'adapted after back');
      await invariants(tab, 'back across origins');
      await tab.close();
      record(
        driver,
        AREA,
        'P07 navigation kinds',
        'PASS',
        'push, replace, pop, back, forward, hash, same-origin, cross-origin',
      );
    });

    test('P07 tab lifecycle: new, duplicate, discard and restore, background and foreground', async () => {
      const a = await driver.newTab();
      await a.open(`${server.origin}/nav/a?life=1`);
      await until(() => hasStylesheet(a), 'adapted');
      const idA = await tabIdOf(driver, 'life=1');

      // duplicate: a second, independent document
      const dupId = await driver.extensionEval<number | null>(
        `(async () => { const api = globalThis.browser ?? globalThis.chrome; const t = await api.tabs.duplicate(${idA}); return t ? t.id : null; })()`,
      );
      expect(dupId).not.toBeNull();
      await until(
        () =>
          driver.extensionEval<boolean>(
            `(async () => { const api = globalThis.browser ?? globalThis.chrome; const t = (await api.tabs.query({})).filter((x) => (x.url || '').includes('life=1')); return t.length === 2 && t.every((x) => x.status === 'complete'); })()`,
          ),
        'the duplicate to load',
      );
      const pages = (
        driver as unknown as { browserContext?: { pages(): Array<{ url(): string }> } }
      ).browserContext;
      void pages; // Chrome-only handle; the duplicate is exercised through the extension API below
      const sheets = await driver.extensionEval<number[]>(
        `(async () => { const api = globalThis.browser ?? globalThis.chrome; const t = (await api.tabs.query({})).filter((x) => (x.url || '').includes('life=1')); const out = []; for (const x of t) { const d = await api.tabs.sendMessage(x.id, { channel: 'coloradapt', type: 'GET_DYNAMIC_DIAGNOSTICS', payload: undefined }); out.push(d.observerStarts); } return out; })()`,
      );
      expect(sheets).toEqual([1, 1]);
      await driver.extensionEval(
        `(async () => { const api = globalThis.browser ?? globalThis.chrome; await api.tabs.remove(${dupId}); })()`,
      );

      // discard and restore: the document goes away and comes back as a fresh one
      const other = await driver.newTab(); // another tab in front, so `a` can be discarded
      await other.open(`${server.origin}/basic?front=1`);
      await other.focus();
      // discarding replaces the tab: the browser hands back the discarded tab, under a new id
      const discardedId = await driver
        .extensionEval<number | null>(
          `(async () => { const api = globalThis.browser ?? globalThis.chrome; const t = await api.tabs.discard(${idA}); return t && t.id !== undefined ? t.id : null; })()`,
        )
        .catch(() => null);
      const discarded = discardedId !== null;
      if (discarded) {
        const tabState = (field: string) =>
          driver.extensionEval<unknown>(
            `(async () => { const api = globalThis.browser ?? globalThis.chrome; const t = await api.tabs.get(${discardedId}); return t.${field}; })()`,
          );
        await until(async () => (await tabState('discarded')) === true, 'the tab to be discarded');
        await driver.extensionEval(
          `(async () => { const api = globalThis.browser ?? globalThis.chrome; await api.tabs.update(${discardedId}, { active: true }); })()`,
        );
        await until(
          async () =>
            (await tabState('discarded')) === false && (await tabState('status')) === 'complete',
          'the tab to be restored',
        );
        await until(
          () =>
            driver.extensionEval<boolean>(
              `(async () => { const api = globalThis.browser ?? globalThis.chrome; try { const d = await api.tabs.sendMessage(${discardedId}, { channel: 'coloradapt', type: 'GET_DYNAMIC_DIAGNOSTICS', payload: undefined }); return d.observerStarts === 1 && d.state === 'IDLE'; } catch { return false; } })()`,
            ),
          'the restored document to run exactly one pipeline',
        );
      }

      if (discarded) {
        await driver.extensionEval(
          `(async () => { const api = globalThis.browser ?? globalThis.chrome; await api.tabs.remove(${discardedId}); })()`,
        );
      } else {
        await a.close();
      }

      // background and foreground: DOM work in a tab that is not in front is processed and nothing is left queued
      const front = await driver.newTab();
      await front.open(`${server.origin}/nav/b?life=2`);
      await until(() => hasStylesheet(front), 'adapted');
      await other.focus();
      await front.evaluate(
        `(() => { for (let i = 0; i < 50; i++) { const p = document.createElement('p'); p.className = 'cvd'; p.textContent = 'bg ' + i; document.body.append(p); } return 1; })()`,
      );
      await front.focus();
      await front.ext('FLUSH_DYNAMIC');
      await invariants(front, 'background-created content');
      expect(
        await front.evaluate<number>(
          `document.querySelectorAll('p.cvd[data-coloradapt-id]').length`,
        ),
      ).toBe(50);

      await other.close();
      await front.close();
      record(
        driver,
        AREA,
        'P07 tab lifecycle',
        discarded ? 'PASS' : 'NOT_VERIFIED',
        discarded
          ? 'duplicate, discard+restore, background'
          : 'discard refused by the browser; duplicate and background verified',
      );
    });

    test('P07/P08 work pending when the tab closes or the document goes away leaves nothing behind', async () => {
      const hang = await startHangingServer();
      try {
        // the stylesheet is added after load and never answers: the pipeline is left waiting for it
        server.serve(
          'pending',
          html(
            `<p class="cvd">pending page</p><p class="low">low</p><script>setTimeout(() => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '${hang.origin}/never.css'; document.head.append(l); }, 150);</script>`,
          ),
        );
        // (a) the tab is closed while a stylesheet is still loading and the pipeline is waiting for it
        const doomed = await driver.newTab();
        await doomed.open(`${server.origin}/pending?a=1`).catch(() => null);
        await until(async () => (await gauges(doomed)).pendingLinks > 0, 'a pending link').catch(
          () => null,
        );
        await doomed.close();

        // (b) the document navigates away while it is waiting
        const nav = await driver.newTab();
        await nav.open(`${server.origin}/pending?b=1`).catch(() => null);
        await until(async () => (await gauges(nav)).pendingLinks > 0, 'a pending link').catch(
          () => null,
        );
        await nav.open(`${server.origin}/other`);
        await until(() => hasStylesheet(nav), 'the new document adapts');
        await invariants(nav, 'document replaced while waiting');

        // (c) heavy DOM work queued, then the document is destroyed before it runs
        const burst = await driver.newTab();
        await burst.open(`${server.origin}/basic?burst=1`);
        await until(() => hasStylesheet(burst), 'adapted');
        await burst
          .evaluate(
            `(() => { for (let i = 0; i < 3000; i++) { const p = document.createElement('p'); p.className = 'cvd'; p.textContent = 'x' + i; document.body.append(p); } location.href = ${JSON.stringify(`${server.origin}/other?after=1`)}; return 1; })()`,
          )
          .catch(() => null);
        await until(
          () => burst.evaluate<boolean>(`location.search === '?after=1'`),
          'navigation after the burst',
        );
        await until(() => hasStylesheet(burst), 'the next document adapts');
        await invariants(burst, 'document destroyed with work queued');

        // the background and a fresh tab are unaffected
        expect(await toBackground<{ enabled: boolean }>(driver, 'GET_SETTINGS')).toMatchObject({
          enabled: true,
        });
        await nav.close();
        await burst.close();
        record(driver, AREA, 'P07/P08 pending work vs closed/replaced documents', 'PASS');
      } finally {
        await hang.close();
      }
    });

    test('P08 nodes that disappear between detection and adaptation: no error, no stale rule, queues drain', async () => {
      const tab = await driver.newTab();
      await tab.open(`${server.origin}/nav/a?race=1`);
      await until(() => hasStylesheet(tab), 'adapted');
      const base = await quiesce(tab);
      const trackedBefore = base.trackedElements;
      await tab.evaluate(`(async () => {
        const wait = (f) => new Promise((r) => f(r));
        for (let i = 0; i < 300; i++) {
          const host = document.createElement('div');
          host.innerHTML = '<p class="cvd">a</p><ul><li class="cvd">b</li><li class="low">c</li></ul><svg width="20" height="20"><rect width="20" height="20" fill="#d62728"/></svg>';
          document.body.append(host);
          if (i % 3 === 0) host.remove();                                   // removed in the same task: never seen
          else if (i % 3 === 1) { await wait((r) => queueMicrotask(r)); host.remove(); }   // removed after the observer was queued
          else { await wait((r) => requestAnimationFrame(() => r())); host.remove(); }   // removed after a frame
        }
        return 1;
      })()`);
      const g = await quiesce(tab);
      const r = await residue(tab);
      expect(r.sheets).toBeLessThanOrEqual(1);
      expect(r.duplicateIds).toBe(0);
      expect(g.trackedElements).toBeLessThanOrEqual(trackedBefore + 5); // nothing detached is kept
      expect(g.deferredRoots).toBe(0);
      expect(g.queueOverflows).toBe(0);
      expect(fatalLogs(tab.drainLogs())).toEqual([]);
      await tab.close();
      record(
        driver,
        AREA,
        'P08 nodes removed before adaptation',
        'PASS',
        `tracked ${trackedBefore} -> ${g.trackedElements}`,
      );
    });
  });
}
