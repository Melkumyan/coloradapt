/**
 * M12 (docs/m12/protocol.md) P24: resource baseline and leak test, Chrome (production build).
 *
 * 1. SPA route changes against a control: the same single-page app is driven through 5,000 route changes with the
 *    extension off and on. The M10 gate compares 50 and 500 route changes (a warm-up as much as a leak); this
 *    one asks the leak question: how much does the heap still grow per route change after the warm-up
 *    (route changes 2,000 to 5,000), and is what ColorAdapt owns (tracked elements, rules, observers, queues) flat.
 * 2. A baseline of what the extension costs: heap and nodes with it on versus off, idle CPU after quiescence,
 *    throughput of a 10,000-mutation burst, observer and queue counts. Reported for regression detection; only the
 *    structural facts are conditions; idle CPU is reported only (its criterion is the relative control, idle-cpu.spec.ts).
 */
import { expect, test } from '@playwright/test';
import { startChrome, type ChromeTab } from '../lib/driver';
import { FRAME_RECORDER, READ_FRAMES, counters } from '../lib/metrics';
import { BUDGETS as M10_BUDGETS } from '../budgets';
import { startFixtureServer } from '../lib/server';
import { SETTINGS_ON, hasStylesheet, html, record, sleep, until } from '../lib/scenario';
import { gauges, quiesce } from './kit';
import { hostBrowserInventory, sampleProcessTree, sum } from './soak-kit';

const SPA = html(`
  <nav><a id="to-a" href="/spa/a" data-link>A</a></nav><main id="view"></main>
  <script>
    const views = {
      a: '<p id="a-low" class="low">Route A low contrast text</p>',
      b: '<p id="b-cvd" class="cvd">Route B red on green text</p>',
      c: '<ul id="c-list"><li class="low">c one</li><li class="low">c two</li></ul>',
    };
    const render = () => { document.getElementById('view').innerHTML = views[location.pathname.split('/')[2]] || views.a; };
    window.go = (name) => { history.pushState({}, '', '/spa/' + name); render(); };
    addEventListener('popstate', render);
    render();
  </script>`);

/** Frozen in docs/m12/protocol.md. Bytes of post-GC JS heap that one more route change may leave behind, after warm-up. */
const STEADY_STATE_BYTES_PER_ROUTE_MAX = 128;

const POINTS = [50, 500, 1000, 1500, 2000, 3000, 4000, 5000] as const;

test.describe('M12 resource baseline and leak test (chrome)', () => {
  test.describe.configure({ mode: 'serial' });

  const curves: Record<
    'off' | 'on',
    Array<{ routes: number; heap: number; nodes: number; listeners: number }>
  > = {
    off: [],
    on: [],
  };

  for (const mode of ['off', 'on'] as const) {
    test(`P24 SPA route changes, extension ${mode}: heap after GC at ${POINTS.join(', ')} route changes`, async () => {
      const server = await startFixtureServer();
      server.serve('spa/*', SPA);
      const driver = await startChrome({ extension: mode === 'on' });
      try {
        if (mode === 'on') await driver.setSettings(SETTINGS_ON);
        const page = (await driver.newTab()) as ChromeTab;
        await page.open(`${server.origin}/spa/a`);
        if (mode === 'on') await until(() => page.ext('GET_DYNAMIC_DIAGNOSTICS'), 'content script');
        let done = 0;
        for (const target of POINTS) {
          await page.evaluate(
            `(async () => { const names = ['a','b','c']; for (let i = ${done}; i < ${target}; i++) { window.go(names[i % 3]); await new Promise((r) => requestAnimationFrame(r)); } })()`,
          );
          done = target;
          if (mode === 'on') await quiesce(page);
          else await sleep(300);
          const c = await counters(page);
          curves[mode].push({
            routes: target,
            heap: c.heapBytes,
            nodes: c.nodes,
            listeners: c.listeners,
          });
        }
        if (mode === 'on') {
          const g = await gauges(page);
          expect(g.observerStarts).toBe(1);
          expect(g.queuedRecords).toBe(0);
          expect(g.deferredRoots).toBe(0);
          expect(g.queueOverflows).toBe(0);
          expect(g.trackedElements).toBeLessThan(20); // what ColorAdapt owns does not follow the route count
        }
        const first = curves[mode].find((p) => p.routes === 2000)!;
        const last = curves[mode].at(-1)!;
        expect(last.nodes - first.nodes, 'DOM nodes after warm-up').toBeLessThanOrEqual(3);
        expect(last.listeners - first.listeners, 'listeners after warm-up').toBeLessThanOrEqual(2);
        const perRoute = (last.heap - first.heap) / (last.routes - first.routes);
        record(
          driver,
          'm12-resource',
          `P24 SPA heap, extension ${mode}`,
          'INFO',
          `${curves[mode].map((p) => `${p.routes}:${(p.heap / 1e6).toFixed(3)}MB`).join(' ')}; steady state ${perRoute.toFixed(1)} B/route change`,
        );
      } finally {
        await driver.close();
        await server.close();
      }
    });
  }

  test('P24 verdict: after the warm-up the extension leaves at most the frozen bytes per route change', () => {
    const at = (m: 'off' | 'on', routes: number) => curves[m].find((p) => p.routes === routes)!;
    const slope = (m: 'off' | 'on') => (at(m, 5000).heap - at(m, 2000).heap) / 3000;
    const on = slope('on');
    const off = slope('off');
    console.log(
      `steady state (2000 -> 5000 route changes): extension on ${on.toFixed(1)} B/route, off ${off.toFixed(1)} B/route, attributable ${(on - off).toFixed(1)} B/route; ` +
        `50 -> 500 ratio on ${(at('on', 500).heap / at('on', 50).heap).toFixed(4)}, off ${(at('off', 500).heap / at('off', 50).heap).toFixed(4)}`,
    );
    expect(on, 'bytes per route change with the extension on').toBeLessThanOrEqual(
      STEADY_STATE_BYTES_PER_ROUTE_MAX,
    );
    expect(on - off, 'bytes per route change attributable to the extension').toBeLessThanOrEqual(
      STEADY_STATE_BYTES_PER_ROUTE_MAX,
    );
    // and the curve is a saturation, not a line: after 2,000 the growth per route change is below what it was before
    const early = at('on', 1500).heap - at('on', 500).heap;
    const late = at('on', 5000).heap - at('on', 2000).heap;
    expect(late / 3000, 'growth per route change keeps falling').toBeLessThan(early / 1000);
  });

  test('P24 baseline: cost of the extension on a page, idle CPU after quiescence, mutation throughput', async () => {
    const hostBefore = hostBrowserInventory();
    const server = await startFixtureServer();
    server.serve(
      'big',
      html(
        Array.from(
          { length: 1500 },
          (_v, i) => `<p class="${['cvd', 'low', 'fine'][i % 3]}">paragraph ${i}</p>`,
        ).join(''),
      ),
    );
    server.serve(
      'small',
      html(
        Array.from(
          { length: 300 },
          (_v, i) => `<p class="${['cvd', 'low', 'fine'][i % 3]}">paragraph ${i}</p>`,
        ).join(''),
      ),
    );
    const rows: Record<string, unknown> = {};
    try {
      for (const mode of ['off', 'on'] as const) {
        const driver = await startChrome({ extension: mode === 'on' });
        try {
          if (mode === 'on') {
            await driver.setSettings({ ...SETTINGS_ON, visionProfile: 'deuteranopia' });
          }
          const page = (await driver.newTab()) as ChromeTab;
          await page.open(`${server.origin}/big`);
          if (mode === 'on') {
            await until(() => hasStylesheet(page), 'adapted');
            await quiesce(page);
          } else await sleep(1000);
          const c = await counters(page);
          // idle: let a fresh browser finish starting up (background services, component loading), then 15 s of
          // nothing: the CPU of the whole browser process tree
          await sleep(25_000);
          const t0 = sampleProcessTree(driver.profileDir);
          const w0 = Date.now();
          await sleep(15_000);
          const t1 = sampleProcessTree(driver.profileDir);
          const idleCpu =
            ((sum(t1, (p) => p.cpuSeconds) - sum(t0, (p) => p.cpuSeconds)) /
              ((Date.now() - w0) / 1000)) *
            100;
          // throughput and responsiveness: bursts of new adaptable elements, each in a fresh tab. Up to 1,000 the M10
          // budget applies (docs/PERFORMANCE.md); beyond it the cost of a pass grows with the rules already in the
          // sheet (a known limit, docs/m12/report.md): reported, and every size must still end idle and empty.
          const bursts: Array<Record<string, number>> = [];
          let g: Awaited<ReturnType<typeof gauges>> | null = null;
          if (mode === 'on') {
            for (const n of [1000, 2000, 5000, 10_000]) {
              const tab = (await driver.newTab()) as ChromeTab;
              await tab.open(`${server.origin}/small`);
              await until(() => hasStylesheet(tab), 'adapted');
              await quiesce(tab);
              await tab.evaluate(FRAME_RECORDER);
              const start = Date.now();
              await tab.evaluate(
                `(() => { for (let r = 0; r < ${n / 100}; r++) { const host = document.createElement('div'); for (let i = 0; i < 100; i++) { const p = document.createElement('p'); p.className = ['cvd','low','fine'][i % 3]; p.textContent = 'm' + i; host.append(p); } document.body.append(host); } return 1; })()`,
              );
              await until(
                async () => (await gauges(tab)).state === 'IDLE',
                `idle after ${n} added elements`,
                240_000,
              );
              g = await quiesce(tab);
              const frames = await tab.evaluate<{ maxGap: number; longTasks: number[] }>(
                READ_FRAMES,
              );
              const longest = Math.round(Math.max(0, ...frames.longTasks));
              bursts.push({
                added: n,
                toIdleMs: Date.now() - start,
                longestTaskMs: longest,
                longTasksOver200ms: frames.longTasks.filter((x) => x > 200).length,
                rules: g.rules,
              });
              expect(g.queuedRecords, `queue after ${n}`).toBe(0);
              expect(g.deferredRoots, `deferred roots after ${n}`).toBe(0);
              expect(g.queueOverflows, `overflows after ${n}`).toBe(0);
              if (n <= 1000) {
                expect(longest, `longest main-thread task, ${n} added`).toBeLessThanOrEqual(
                  M10_BUDGETS.longTaskMs,
                );
              }
              await tab.close();
            }
          }
          rows[mode] = {
            heapMB: +(c.heapBytes / 1e6).toFixed(3),
            nodes: c.nodes,
            listeners: c.listeners,
            idleCpuPercent: +idleCpu.toFixed(2),
            processes: t1.length,
            browserWorkingSetMB: +(sum(t1, (p) => p.workingSet) / 1e6).toFixed(0),
            extensionProcessMB: +(sum(t1, (p) => p.workingSet, 'extension') / 1e6).toFixed(0),
            rendererMB: +(sum(t1, (p) => p.workingSet, 'renderer') / 1e6).toFixed(0),
            ...(mode === 'on' ? { bursts } : {}),
          };
          if (mode === 'on') {
            expect(g!.observerStarts).toBe(1);
          }
        } finally {
          await driver.close();
          await sleep(1500);
        }
      }
    } finally {
      await server.close();
    }
    console.log(`baseline ${JSON.stringify(rows)} host-before ${JSON.stringify(hostBefore)}`);
    record(
      { name: 'chrome', version: '' },
      'm12-resource',
      'P24 baseline on/off',
      'INFO',
      JSON.stringify(rows),
    );
  });
});
