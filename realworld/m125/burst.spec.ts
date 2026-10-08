/**
 * M12.5 (docs/m125/protocol.md): burst scalability in the real browsers, production builds.
 *
 * The gates are the numbers frozen in `budgets.ts` before the formal run. What is measured, and by what:
 *  - the slice: ColorAdapt's own time per scheduled flush (`maxSliceMs`, the pipeline's counter on the page's clock),
 *    in both browsers;
 *  - long tasks (Chromium only): tasks of the page that started after the page's own insertion task ended. They
 *    include the browser's rendering of what was inserted, so they are read against the extension-off control;
 *  - time until the pipeline is idle again, throughput, queue sizes, rules, memory.
 */
import { expect, test } from '@playwright/test';
import { startChrome, startFirefox, type Driver } from '../lib/driver';
import { startFixtureServer, type FixtureServer } from '../lib/server';
import { BROWSERS, SETTINGS_ON, record, sleep, until } from '../lib/scenario';
import { gauges, quiesce, residue } from '../m12/kit';
import { counters, isChrome } from '../lib/metrics';
import { BUDGETS, GATE, REPEAT } from './budgets';
import {
  FINAL_DIGEST,
  FIXTURE,
  burstPage,
  clickProbe,
  openBurstTab,
  percentile,
  runBurst,
  sliceGauges,
  type Burst,
} from './kit';

const SIZES = (process.env['M125_SIZES'] ?? '1000,5000,10000').split(',').map(Number);
const ONLY = process.env['M125_ONLY'] ?? '';
const EXTENSION_DIR = process.env['M125_EXTENSION_DIR'];
/** The unchanged M12 build (`<root>/dist/chrome-mv3`, `<root>/dist/firefox-mv2`) the candidate is compared with. */
const BASELINE_ROOT = process.env['M125_BASELINE_DIR'];

const wanted = (name: string) =>
  ONLY === '' || ONLY.split(',').some((part) => name.startsWith(part));

for (const BROWSER of BROWSERS) {
  test.describe(`M12.5 burst scalability (${BROWSER})`, () => {
    const B = BUDGETS[BROWSER];
    let server: FixtureServer;
    const launch = (extension = true): Promise<Driver> =>
      BROWSER === 'chrome'
        ? startChrome({ extension, ...(EXTENSION_DIR ? { extensionDir: EXTENSION_DIR } : {}) })
        : startFirefox(EXTENSION_DIR ? { extensionDir: EXTENSION_DIR } : {});
    const launchBaseline = (): Promise<Driver> => {
      const extensionDir = `${BASELINE_ROOT}/dist/${BROWSER === 'chrome' ? 'chrome-mv3' : 'firefox-mv2'}`;
      return BROWSER === 'chrome' ? startChrome({ extensionDir }) : startFirefox({ extensionDir });
    };

    const note = (
      driver: Driver,
      check: string,
      verdict: 'PASS' | 'FAIL' | 'INFO',
      detail: string,
    ) => {
      console.log(`M125 ${driver.name} ${check}: ${detail}`);
      record(driver, 'm125-burst', check, verdict, detail);
    };

    test.beforeAll(async () => {
      server = await startFixtureServer();
      server.serve(FIXTURE, burstPage());
    });
    test.afterAll(async () => {
      await server.close();
    });

    const median = (values: readonly number[]) => percentile(values, 50);

    /** The same burst `runs` times, one fresh page each (a single reading is at the mercy of the host). */
    async function repeated(driver: Driver, burst: Burst, runs: number) {
      const readings = [];
      for (let run = 0; run < runs; run++)
        readings.push(await runBurst(driver, server.origin, burst));
      return readings;
    }

    /**
     * The slice gate: the median over the runs of the longest ColorAdapt slice is within the budget, and no run is
     * beyond `worstFactor` times it (a host hiccup is tolerated once, a slice that is really long is not).
     */
    function expectSliceGate(
      readings: ReadonlyArray<{ gauges: { maxSliceMs: number } }>,
      budgetMs: number,
      label: string,
    ) {
      const slices = readings.map((r) => r.gauges.maxSliceMs);
      expect(
        median(slices),
        `longest ColorAdapt slice (median of ${slices.length} runs), ${label}`,
      ).toBeLessThanOrEqual(budgetMs);
      expect(
        Math.max(...slices),
        `longest ColorAdapt slice (worst run), ${label}`,
      ).toBeLessThanOrEqual(budgetMs * GATE.worstFactor);
    }

    /** A driver with the extension configured (settings on) and the fixture reachable. */
    async function onDriver(extension = true): Promise<Driver> {
      const driver = await launch(extension);
      if (extension) await driver.setSettings(SETTINGS_ON);
      return driver;
    }

    // ---------------------------------------------------------------------------------------------------------
    // P6-P8: the canonical burst (corpus A) at 1k, 5k and 10k; the control without the extension
    // ---------------------------------------------------------------------------------------------------------

    test.describe('canonical bursts (corpus A: hosts of 100 text elements)', () => {
      for (const n of SIZES) {
        test(`${n} elements added at once: bounded slices, idle quickly, nothing left queued`, async () => {
          test.skip(!wanted('canonical'), 'filtered');
          const on = await onDriver();
          const off = BROWSER === 'chrome' ? await onDriver(false) : null;
          try {
            const control = off
              ? await runBurst(off, server.origin, { kind: 'text', n }, false)
              : null;
            const readings = await repeated(on, { kind: 'text', n }, GATE.canonicalRuns);
            const last = readings.at(-1)!;
            note(
              on,
              `canonical ${n}`,
              'INFO',
              JSON.stringify({
                runs: readings.length,
                maxSliceMs: readings.map((r) => Math.round(r.gauges.maxSliceMs)),
                medianMaxSliceMs: Math.round(median(readings.map((r) => r.gauges.maxSliceMs))),
                toIdleMs: readings.map((r) => r.toIdleMs),
                throughput: last.throughput,
                slices: last.gauges.slices,
                totalSliceMs: Math.round(last.gauges.totalSliceMs),
                ownedLongestMs: readings.map((r) => r.ownedLongestMs),
                controlLongestMs: control?.ownedLongestMs ?? null,
                rules: last.rules,
                digest: last.digest,
                passes: last.gauges.incrementalPasses,
                rescans: last.gauges.fullRescans,
                truncated: last.gauges.truncatedPasses,
                peakDeferredRoots: last.gauges.peakDeferredRoots,
                peakQueuedRecords: last.gauges.peakQueuedRecords,
              }),
            );
            for (const reading of readings) {
              expect(reading.gauges.fullRescans, 'no full rescan').toBe(0);
              expect(reading.gauges.truncatedPasses, 'no truncated pass').toBe(0);
              if (n >= 5000)
                expect(reading.gauges.slices, 'the burst was sliced').toBeGreaterThan(1);
            }
            expectSliceGate(readings, B.sliceMs, `canonical ${n}`);
            if (B.longTaskMs !== null) {
              // supporting evidence (Chromium only): the browser's own report of tasks longer than 50 ms after the insertion
              const longest = readings.map((r) => r.ownedLongestMs ?? 0);
              expect(
                median(longest),
                `longest page task after the insertion (median of ${longest.length} runs), ${n}`,
              ).toBeLessThanOrEqual(B.longTaskMs);
              expect(
                Math.max(...longest),
                'longest page task after the insertion (worst run)',
              ).toBeLessThanOrEqual(B.longTaskMs * GATE.worstFactor);
            }
            // determinism: the same page, the same burst, the same final state every time
            expect(new Set(readings.map((r) => r.digest.hash)).size, 'one final state').toBe(1);
            // a burst is deterministic work: no network request (no AI call, no telemetry) besides the page itself
            expect(
              server
                .requests()
                .filter((r) => !r.startsWith('GET /burst') && !r.includes('favicon')),
              'requests other than the page',
            ).toEqual([]);
            if (n === 10_000) {
              expect(
                median(readings.map((r) => r.toIdleMs)),
                'time until idle (median), 10k',
              ).toBeLessThanOrEqual(B.settle10kMs);
              expect(
                Math.max(...readings.map((r) => r.toIdleMs)),
                'time until idle (worst), 10k',
              ).toBeLessThanOrEqual(B.settle10kMs * GATE.worstFactor);
            }
          } finally {
            await on.close();
            await off?.close();
          }
        });
      }
    });

    // ---------------------------------------------------------------------------------------------------------
    // P6-P8 continued: the rest of the corpus
    // ---------------------------------------------------------------------------------------------------------

    const CORPUS: Array<{
      name: string;
      burst: Burst;
      budgetKey: keyof typeof B.corpus;
      /** A full analysis capped by its own wall-clock budget: its result depends on the machine (Firefox). */
      clockDependent?: boolean;
    }> = [
      { name: 'B mixed elements 10k', burst: { kind: 'mixed', n: 10_000 }, budgetKey: 'mixed10k' },
      {
        name: 'C nested backgrounds 5k',
        burst: { kind: 'nested', n: 5000 },
        budgetKey: 'nested5k',
      },
      { name: 'D svg icons 2k', burst: { kind: 'svg', n: 2000 }, budgetKey: 'svg2k' },
      {
        name: 'E semantic state rows 1.6k (about 4.8k elements)',
        burst: { kind: 'semantic', n: 1600 },
        budgetKey: 'semantic5k',
      },
      { name: 'F chart-like 500', burst: { kind: 'chart', n: 500 }, budgetKey: 'chart500' },
      {
        name: 'H oversized single region 5k',
        burst: { kind: 'text', n: 5000, shape: 'one' },
        budgetKey: 'oneRegion5k',
      },
      {
        name: 'I flat siblings 10k (full rescan)',
        burst: { kind: 'text', n: 10_000, shape: 'flat' },
        budgetKey: 'flat10k',
        clockDependent: true,
      },
    ];

    test.describe('corpus', () => {
      for (const entry of CORPUS) {
        test(entry.name, async () => {
          test.skip(!wanted('corpus'), 'filtered');
          const on = await onDriver();
          try {
            const readings = await repeated(on, entry.burst, GATE.corpusRuns);
            const last = readings.at(-1)!;
            note(
              on,
              `corpus ${entry.name}`,
              'INFO',
              JSON.stringify({
                runs: readings.length,
                maxSliceMs: readings.map((r) => Math.round(r.gauges.maxSliceMs)),
                medianMaxSliceMs: Math.round(median(readings.map((r) => r.gauges.maxSliceMs))),
                toIdleMs: readings.map((r) => r.toIdleMs),
                slices: last.gauges.slices,
                ownedLongestMs: readings.map((r) => r.ownedLongestMs),
                rules: last.rules,
                digest: last.digest,
                rescans: last.gauges.fullRescans,
                truncated: last.gauges.truncatedPasses,
              }),
            );
            const budget = B.corpus[entry.budgetKey];
            expectSliceGate(readings, budget.sliceMs, entry.name);
            expect(
              median(readings.map((r) => r.toIdleMs)),
              `time until idle (median), ${entry.name}`,
            ).toBeLessThanOrEqual(budget.settleMs);
            // the final state does not depend on the run (a wall-clock-limited full analysis in Firefox does)
            if (!entry.clockDependent || BROWSER === 'chrome') {
              expect(new Set(readings.map((r) => r.digest.hash)).size, 'one final state').toBe(1);
            }
          } finally {
            await on.close();
          }
        });
      }
    });

    // ---------------------------------------------------------------------------------------------------------
    // P9: input stays responsive while a 10k burst is worked off
    // ---------------------------------------------------------------------------------------------------------

    test('input responsiveness: real clicks during a 10k burst are answered inside the frozen delay', async () => {
      test.skip(!wanted('input'), 'filtered');
      const on = await onDriver();
      try {
        const tab = await openBurstTab(on, server.origin, true);
        await tab.evaluate(`window.__b.trackFrames()`);
        await tab.evaluate(`window.__b.insert('text', 10000)`);
        const delays = await clickProbe(tab, 30, 10);
        await until(async () => (await gauges(tab)).state === 'IDLE', 'idle', 120_000);
        await quiesce(tab);
        const frames = await tab.evaluate<{ max: number; count: number }>(
          `window.__b.stopFrames()`,
        );
        const g = await sliceGauges(tab);
        const p95 = percentile(delays, 95);
        const max = Math.max(0, ...delays);
        note(
          on,
          'input delay during a 10k burst',
          'INFO',
          JSON.stringify({
            clicks: delays.length,
            p95: Math.round(p95),
            max: Math.round(max),
            maxSliceMs: Math.round(g.maxSliceMs),
            slices: g.slices,
            frames,
          }),
        );
        expect(delays.length, 'every click was delivered to the page').toBe(30);
        expect(max, 'worst input delay').toBeLessThanOrEqual(B.inputDelayMaxMs);
        expect(frames.max, 'worst gap between two frames of the page').toBeLessThanOrEqual(
          B.frameGapMaxMs,
        );
        expect(frames.count, 'the page rendered between the slices').toBeGreaterThan(g.slices);
        await tab.close();
      } finally {
        await on.close();
      }
    });

    // ---------------------------------------------------------------------------------------------------------
    // P10: a continuous mutation stream
    // ---------------------------------------------------------------------------------------------------------

    test('continuous mutation stream: input stays responsive, queues stay bounded, it converges after the stream stops', async () => {
      test.skip(!wanted('stream'), 'filtered');
      const on = await onDriver();
      try {
        const tab = await openBurstTab(on, server.origin, true);
        const streaming = tab.evaluate<number>(
          `window.__b.stream('text', 100, ${B.stream.durationMs})`,
        );
        await sleep(500);
        const delays = await clickProbe(tab, 10, 150);
        const duringQueue = await sliceGauges(tab);
        const added = await streaming;
        const stopped = Date.now();
        await until(
          async () => (await gauges(tab)).state === 'IDLE',
          'idle after the stream',
          60_000,
        );
        const q = await quiesce(tab);
        const settleMs = Date.now() - stopped;
        const g = await sliceGauges(tab);
        const digest = await tab.evaluate<{ elements: number }>(
          `({ elements: document.querySelectorAll('#burst *').length })`,
        );
        note(
          on,
          'continuous stream',
          'INFO',
          JSON.stringify({
            added,
            settleMs,
            maxDelay: Math.round(Math.max(0, ...delays)),
            maxSliceMs: Math.round(g.maxSliceMs),
            slices: g.slices,
            peakDeferredRoots: g.peakDeferredRoots,
            peakQueuedRecords: g.peakQueuedRecords,
            overflows: q.queueOverflows,
            rescans: g.fullRescans,
            duringDeferred: duringQueue.peakDeferredRoots,
          }),
        );
        expect(digest.elements).toBeGreaterThan(added);
        expect(Math.max(0, ...delays), 'worst input delay during the stream').toBeLessThanOrEqual(
          B.inputDelayMaxMs,
        );
        // one run of about 300 slices: the budget with the worst-run allowance (a hiccup once, never a long slice)
        expect(g.maxSliceMs, 'longest slice during the stream').toBeLessThanOrEqual(
          B.stream.sliceMs * GATE.worstFactor,
        );
        expect(settleMs, 'time to converge after the stream').toBeLessThanOrEqual(
          B.stream.settleMs,
        );
        expect(q.queueOverflows).toBe(0);
        expect(q.queuedRecords).toBe(0);
        expect(q.deferredRoots).toBe(0);
        await tab.close();
      } finally {
        await on.close();
      }
    });

    // ---------------------------------------------------------------------------------------------------------
    // P5: cancellation in a real browser: OFF, profile change, navigation, route replacement mid-burst
    // ---------------------------------------------------------------------------------------------------------

    test.describe('cancellation mid-burst', () => {
      test('turning the extension OFF mid-burst leaves no rule, no attribute, no work', async () => {
        test.skip(!wanted('cancel'), 'filtered');
        const on = await onDriver();
        try {
          const tab = await openBurstTab(on, server.origin, true);
          await tab.evaluate(`window.__b.insert('text', 10000)`);
          await until(async () => (await sliceGauges(tab)).slices >= 1, 'first slice');
          await on.setSettings({ ...SETTINGS_ON, enabled: false });
          const offAt = Date.now();
          await tab.ext('DISABLE_ADAPTATION');
          const offMs = Date.now() - offAt;
          await until(
            async () =>
              !(await tab.evaluate<boolean>(`!!document.getElementById('coloradapt-stylesheet')`)),
            'sheet removed',
            30_000,
          );
          await sleep(600); // anything still scheduled would show up by now
          const r = await residue(tab);
          expect(r.sheets).toBe(0);
          expect(r.attributes['data-coloradapt-s'] ?? 0).toBe(0);
          expect(r.attributes['data-coloradapt-t'] ?? 0).toBe(0);
          expect(
            await tab.evaluate<number>(
              `document.querySelectorAll('style#coloradapt-suppress').length`,
            ),
          ).toBe(0);
          const after = await sliceGauges(tab);
          note(
            on,
            'OFF mid-burst',
            'PASS',
            JSON.stringify({ offMs, cancelledRoots: after.cancelledRoots, ...r }),
          );
          expect(offMs, 'the OFF message is answered between slices').toBeLessThanOrEqual(
            B.offMessageMs,
          );
          await tab.close();
        } finally {
          await on.close();
        }
      });

      /** A burst through a fresh browser that has had `settings` from the start: what that profile alone produces. */
      async function aloneDigest(settings: Record<string, unknown>, burst: Burst) {
        const alone = await launch();
        try {
          await alone.setSettings(settings);
          return (await runBurst(alone, server.origin, burst)).digest;
        } finally {
          await alone.close();
        }
      }

      const DEUTERANOMALY = { ...SETTINGS_ON, visionProfile: 'deuteranomaly' } as const;

      test('a profile change mid-burst ends exactly where the new profile alone ends', async () => {
        test.skip(!wanted('cancel'), 'filtered');
        // Rows with semantic cues and a color the profiles adapt differently: heavy enough to take several slices from
        // few elements, so the full analysis the change triggers (capped by its own wall-clock budget, a few dozen ms
        // in Firefox) always covers the page.
        const burst: Burst = { kind: 'rows', n: 100 };
        const expected = await aloneDigest(DEUTERANOMALY, burst);
        const on = await onDriver();
        try {
          const tab = await openBurstTab(on, server.origin, true);
          await tab.evaluate(`window.__b.insert('rows', 100)`);
          await until(async () => (await sliceGauges(tab)).slices >= 1, 'first slice');
          const pending = (await sliceGauges(tab)).peakDeferredRoots;
          await on.setSettings(DEUTERANOMALY);
          await tab.ext('REFRESH_ADAPTATION');
          await until(async () => (await gauges(tab)).state === 'IDLE', 'idle', 120_000);
          await quiesce(tab);
          const digest = await tab.evaluate<typeof expected>(FINAL_DIGEST);
          note(
            on,
            'profile change mid-burst',
            'INFO',
            JSON.stringify({ pending, digest, expected }),
          );
          expect(expected.tokens.length, 'the profile adapts this page').toBeGreaterThan(0);
          expect(digest).toEqual(expected);
          await tab.close();
        } finally {
          await on.close();
        }
      });

      test('10k queued, the profile switched halfway: nothing of the old profile is left, no work is left', async () => {
        test.skip(!wanted('cancel'), 'filtered');
        const burst: Burst = { kind: 'text', n: 10_000 };
        const fresh = await aloneDigest(DEUTERANOMALY, burst);
        const old = await aloneDigest(SETTINGS_ON, burst);
        const staleTokens = old.tokens.filter((token) => !fresh.tokens.includes(token));
        const on = await onDriver();
        try {
          const tab = await openBurstTab(on, server.origin, true);
          await tab.evaluate(`window.__b.insert('text', 10000)`);
          await until(async () => (await sliceGauges(tab)).slices >= 1, 'first slice');
          await on.setSettings(DEUTERANOMALY);
          await tab.ext('REFRESH_ADAPTATION');
          await until(async () => (await gauges(tab)).state === 'IDLE', 'idle', 120_000);
          const q = await quiesce(tab);
          const digest = await tab.evaluate<typeof fresh>(FINAL_DIGEST);
          note(
            on,
            'profile change at 10k',
            'INFO',
            JSON.stringify({ adapted: digest.adapted, tokens: digest.tokens, staleTokens }),
          );
          expect(staleTokens.length, 'the two profiles differ on this page').toBeGreaterThan(0);
          for (const token of digest.tokens) {
            expect(fresh.tokens, 'a declaration the new profile produces').toContain(token);
            expect(staleTokens, 'a declaration only the old profile produces').not.toContain(token);
          }
          expect(q.deferredRoots).toBe(0);
          expect(q.queuedRecords).toBe(0);
          await tab.close();
        } finally {
          await on.close();
        }
      });

      test('a route replacement mid-burst: the old route leaves nothing, the new one is adapted', async () => {
        test.skip(!wanted('cancel'), 'filtered');
        const on = await onDriver();
        try {
          const tab = await openBurstTab(on, server.origin, true);
          await tab.evaluate(`window.__b.insert('text', 10000)`);
          await until(async () => (await sliceGauges(tab)).slices >= 1, 'first slice');
          await tab.evaluate(
            `(() => { window.__b.clear(); const root = document.getElementById('burst'); const p = document.createElement('p'); p.className = 'cvd'; p.id = 'route-b'; p.textContent = 'new route'; root.append(p); return 1; })()`,
          );
          await until(async () => (await gauges(tab)).state === 'IDLE', 'idle', 60_000);
          const q = await quiesce(tab);
          const adapted = await tab.evaluate<boolean>(
            `document.getElementById('route-b').hasAttribute('data-coloradapt-s')`,
          );
          const tracked = q.trackedElements;
          note(
            on,
            'route replacement mid-burst',
            'INFO',
            JSON.stringify({ adapted, tracked, deferred: q.deferredRoots }),
          );
          expect(adapted).toBe(true);
          expect(q.deferredRoots).toBe(0);
          expect(q.queuedRecords).toBe(0);
          expect(tracked, 'what is tracked is the new page only').toBeLessThan(400);
          await tab.close();
        } finally {
          await on.close();
        }
      });

      test('a full navigation mid-burst: the next page is clean and adapted', async () => {
        test.skip(!wanted('cancel'), 'filtered');
        const on = await onDriver();
        try {
          const tab = await openBurstTab(on, server.origin, true);
          await tab.evaluate(`window.__b.insert('text', 10000)`);
          await until(async () => (await sliceGauges(tab)).slices >= 1, 'first slice');
          await tab.open(`${server.origin}/${FIXTURE}`);
          await until(
            () => tab.evaluate<boolean>(`!!document.getElementById('coloradapt-stylesheet')`),
            'adapted',
          );
          const q = await quiesce(tab);
          expect(q.observerStarts).toBe(1);
          expect(q.trackedElements).toBeLessThan(400);
          const logs = tab.drainLogs().filter((l) => /coloradapt/i.test(l.text));
          expect(logs).toEqual([]);
          await tab.close();
        } finally {
          await on.close();
        }
      });
    });

    // ---------------------------------------------------------------------------------------------------------
    // P11: rapid replace/remove; repeated bursts; retention
    // ---------------------------------------------------------------------------------------------------------

    test('virtualized list: rapid insert/remove in the same place does not grow the queue or the rules', async () => {
      test.skip(!wanted('churn'), 'filtered');
      const on = await onDriver();
      try {
        const tab = await openBurstTab(on, server.origin, true);
        await tab.evaluate(`window.__b.churn('text', 200, 300)`);
        await until(async () => (await gauges(tab)).state === 'IDLE', 'idle', 60_000);
        const q = await quiesce(tab);
        const g = await sliceGauges(tab);
        note(
          on,
          'virtualized churn',
          'INFO',
          JSON.stringify({
            tracked: q.trackedElements,
            rules: q.rules,
            peakDeferred: g.peakDeferredRoots,
            peakQueued: g.peakQueuedRecords,
            slices: g.slices,
            maxSliceMs: Math.round(g.maxSliceMs),
          }),
        );
        expect(
          q.trackedElements,
          'what is tracked is the current window plus the page',
        ).toBeLessThan(900);
        expect(q.queuedRecords).toBe(0);
        expect(q.deferredRoots).toBe(0);
        expect(g.maxSliceMs).toBeLessThanOrEqual(B.sliceMs);
        await tab.close();
      } finally {
        await on.close();
      }
    });

    test('repeated bursts: the queue, the rules and the heap do not grow with the number of bursts', async () => {
      test.skip(!wanted('repeat'), 'filtered');
      const on = await onDriver();
      try {
        const tab = await openBurstTab(on, server.origin, true);
        const rounds = REPEAT.rounds;
        const samples: Array<{
          round: number;
          heap: number;
          nodes: number;
          rules: number;
          tracked: number;
        }> = [];
        for (let round = 1; round <= rounds; round++) {
          await tab.evaluate(`window.__b.insert('text', 1000)`);
          await until(async () => (await gauges(tab)).state === 'IDLE', 'idle', 60_000);
          const q = await quiesce(tab);
          await tab.evaluate(`window.__b.clear()`);
          await until(async () => (await gauges(tab)).state === 'IDLE', 'idle after clear', 60_000);
          const q2 = await quiesce(tab);
          expect(q2.queuedRecords).toBe(0);
          expect(q2.deferredRoots).toBe(0);
          if (round % REPEAT.every === 0 && isChrome(tab)) {
            const c = await counters(tab);
            samples.push({
              round,
              heap: c.heapBytes,
              nodes: c.nodes,
              rules: q2.rules,
              tracked: q2.trackedElements,
            });
          }
          void q;
        }
        note(on, 'repeated bursts', 'INFO', JSON.stringify(samples));
        if (samples.length >= 3) {
          const first = samples[1]!;
          const last = samples.at(-1)!;
          expect(last.rules, 'rules after the page is emptied').toBe(first.rules);
          expect(last.tracked).toBe(first.tracked);
          expect(last.nodes - first.nodes, 'DOM nodes').toBeLessThanOrEqual(5);
          expect(last.heap / first.heap, 'heap after GC').toBeLessThanOrEqual(REPEAT.heapRatio);
        }
        await tab.close();
      } finally {
        await on.close();
      }
    });

    // ---------------------------------------------------------------------------------------------------------
    // P15/P16: background tab
    // ---------------------------------------------------------------------------------------------------------

    test('a burst in a background tab converges to the same state as in a foreground tab', async () => {
      test.skip(!wanted('hidden'), 'filtered');
      const on = await onDriver();
      try {
        const front = await openBurstTab(on, server.origin, true, '?front');
        await front.evaluate(`window.__b.insert('text', 2000)`);
        await until(
          async () => (await gauges(front)).state === 'IDLE',
          'idle (foreground)',
          60_000,
        );
        await quiesce(front);
        const expected = await front.evaluate<{ adapted: number; hash: string; elements: number }>(
          FINAL_DIGEST,
        );

        const back = await openBurstTab(on, server.origin, true, '?back');
        const other = await on.newTab();
        await other.open(`${server.origin}/${FIXTURE}?other`);
        await other.focus();
        const hiddenAtInsert = await back.evaluate<string>(`document.visibilityState`);
        await back.evaluate(`window.__b.insert('text', 2000)`);
        await sleep(1500);
        await back.focus();
        await until(async () => (await gauges(back)).state === 'IDLE', 'idle (restored)', 120_000);
        await quiesce(back);
        const actual = await back.evaluate<typeof expected>(FINAL_DIGEST);
        note(on, 'background tab', 'INFO', JSON.stringify({ hiddenAtInsert, expected, actual }));
        expect(actual).toEqual(expected);
        await front.close();
        await back.close();
        await other.close();
      } finally {
        await on.close();
      }
    });

    // ------------------------------------------------------------------------------------------------------
    // Host variance: the same canonical burst repeated, one fresh tab each, reported as a distribution. This is what
    // the slice gate is set against (docs/m125/protocol.md, section 5); it asserts nothing but that each run ended.
    // ------------------------------------------------------------------------------------------------------

    test('variance: the canonical bursts repeated', async () => {
      test.skip(!wanted('variance'), 'filtered');
      const repeats = Number(process.env['M125_REPEATS'] ?? '10');
      const on = await onDriver();
      try {
        for (const n of SIZES) {
          const runs: Array<{ idle: number; slice: number; slices: number; long: number | null }> =
            [];
          for (let r = 0; r < repeats; r++) {
            const reading = await runBurst(on, server.origin, { kind: 'text', n });
            runs.push({
              idle: reading.toIdleMs,
              slice: Math.round(reading.gauges.maxSliceMs),
              slices: reading.gauges.slices,
              long: reading.ownedLongestMs,
            });
          }
          const slice = runs.map((x) => x.slice);
          const idle = runs.map((x) => x.idle);
          note(
            on,
            `variance ${n}`,
            'INFO',
            JSON.stringify({
              maxSliceMs: slice,
              slicesPerRun: runs.map((x) => x.slices),
              idleMs: idle,
              ownedLongestMs: runs.map((x) => x.long),
              sliceP50: percentile(slice, 50),
              sliceP95: percentile(slice, 95),
              sliceMax: Math.max(...slice),
              idleMax: Math.max(...idle),
            }),
          );
        }
      } finally {
        await on.close();
      }
    });

    // ------------------------------------------------------------------------------------------------------
    // P3: the same answer. Every corpus burst through the unchanged M12 build and through the candidate: every
    // element of the burst ends with the same computed color, background and semantic cue. The same runs give the
    // "before" numbers (time until idle, longest task) of the report.
    // ------------------------------------------------------------------------------------------------------

    const PARITY: Array<{
      name: string;
      burst: Burst;
      informational?: boolean;
      /** A full analysis capped by its own wall-clock budget: its result depends on the machine (Firefox). */
      clockDependent?: boolean;
    }> = [
      { name: 'A text 1k', burst: { kind: 'text', n: 1000 } },
      { name: 'A text 5k', burst: { kind: 'text', n: 5000 } },
      { name: 'A text 10k', burst: { kind: 'text', n: 10_000 } },
      { name: 'B mixed 10k', burst: { kind: 'mixed', n: 10_000 } },
      { name: 'C nested 5k', burst: { kind: 'nested', n: 5000 } },
      { name: 'D svg 2k', burst: { kind: 'svg', n: 2000 } },
      { name: 'E semantic rows 1.6k', burst: { kind: 'semantic', n: 1600 } },
      {
        // The cue check measures layout ("the dot did not move"), and in an inline flow which cues are added together
        // decides who reflows: the verdict depends on the batch, in the unchanged build as well. Reported, not gated.
        name: 'E2 semantic inline flow 5k (layout-sensitive, informational)',
        burst: { kind: 'inline', n: 5000 },
        informational: true,
      },
      { name: 'F chart 500', burst: { kind: 'chart', n: 500 } },
      { name: 'H one region 5k', burst: { kind: 'text', n: 5000, shape: 'one' } },
      {
        name: 'I flat 10k',
        burst: { kind: 'text', n: 10_000, shape: 'flat' },
        clockDependent: true,
      },
    ];

    test.describe('parity with the unchanged M12 build', () => {
      for (const entry of PARITY) {
        test(entry.name, async () => {
          test.skip(!wanted('parity') || !BASELINE_ROOT, 'needs M125_BASELINE_DIR');
          const before = await launchBaseline();
          const after = await launch();
          try {
            await before.setSettings(SETTINGS_ON);
            await after.setSettings(SETTINGS_ON);
            const old = await runBurst(before, server.origin, entry.burst);
            const now = await runBurst(after, server.origin, entry.burst);
            note(
              after,
              `parity ${entry.name}`,
              'INFO',
              JSON.stringify({
                before: {
                  toIdleMs: old.toIdleMs,
                  longestMs: old.ownedLongestMs,
                  digest: old.digest,
                },
                after: {
                  toIdleMs: now.toIdleMs,
                  longestMs: now.ownedLongestMs,
                  maxSliceMs: Math.round(now.gauges.maxSliceMs),
                  slices: now.gauges.slices,
                  digest: now.digest,
                },
              }),
            );
            expect(now.digest.elements).toBe(old.digest.elements);
            if (!entry.informational && !(entry.clockDependent && BROWSER === 'firefox')) {
              expect(now.digest.hash, 'every element ends in the same computed state').toBe(
                old.digest.hash,
              );
            }
          } finally {
            await before.close();
            await after.close();
          }
        });
      }
    });
  });
}
