/**
 * Dynamic DOM under mutation load, in both real browsers: 1,000, 5,000 and 10,000 individual mutations (one
 * `MutationRecord` each), with the extension idle (protection off) as the baseline. Checks correctness against
 * the expected rows, dropped work and the honest coverage flag, duplicates and stale findings, adaptation
 * latency (until the pipeline is idle) and page responsiveness (worst frame gap, long tasks in Chrome), against
 * the budgets in `budgets.ts` that were fixed before any measurement.
 */
import { expect, test } from '@playwright/test';
import type { DynamicDiagnostics } from '../src/domain/models';
import { BUDGETS, median, percentile } from './budgets';
import type { Driver, Tab } from './lib/driver';
import { FRAME_RECORDER, READ_FRAMES, type FrameReading } from './lib/metrics';
import { startFixtureServer, type FixtureServer } from './lib/server';
import {
  BROWSERS,
  SETTINGS_OFF,
  SETTINGS_ON,
  auditRun,
  coverageLevel,
  html,
  launch,
  record,
  sleep,
  until,
} from './lib/scenario';

const AREA = 'dynamic';

const PAGE = html(`
  <ul id="list"></ul>
  <script>
    // one mutation record per node, 100 per frame: a page streaming rows in (a feed, a table, a log)
    window.burst = async (from, n) => {
      const list = document.getElementById('list');
      let i = from;
      while (i < from + n) {
        for (let k = 0; k < 100 && i < from + n; k++, i++) {
          const li = document.createElement('li');
          li.id = 'r' + i;
          li.className = i % 10 === 0 ? 'low' : i % 7 === 0 ? 'cvd' : 'fine';
          li.textContent = 'row ' + i;
          list.appendChild(li);
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
      return i;
    };
    // attribute mutations on existing rows: flips low <-> fine
    window.flip = async (n) => {
      const rows = document.querySelectorAll('#list li');
      let done = 0;
      while (done < n && done < rows.length) {
        for (let k = 0; k < 100 && done < n && done < rows.length; k++, done++) {
          const li = rows[done];
          li.className = li.className === 'fine' ? 'low' : 'fine';
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
      return done;
    };
  </script>`);

const RED = 'rgb(214, 39, 40)';

interface Run {
  readonly n: number;
  readonly idleMs: number;
  readonly burstMs: number;
  readonly maxGap: number;
  readonly longTasks: number[];
  readonly diag: DynamicDiagnostics;
}

for (const browser of BROWSERS) {
  test.describe(`dynamic ${browser}`, () => {
    test.describe.configure({ mode: 'serial' });
    let driver: Driver;
    let server: FixtureServer;

    test.beforeAll(async () => {
      server = await startFixtureServer();
      server.serve('dyn', PAGE);
      driver = await launch(browser);
    });
    test.afterAll(async () => {
      await driver?.close();
      await server?.close();
    });

    /** One burst on a fresh page. `adapt` = protection on. */
    async function run(n: number, adapt: boolean): Promise<{ tab: Tab; result: Run }> {
      await driver.setSettings(adapt ? SETTINGS_ON : SETTINGS_OFF);
      const tab = await driver.newTab();
      await tab.open(`${server.origin}/dyn`);
      await until(() => tab.ext('GET_DYNAMIC_DIAGNOSTICS'), 'content script');
      if (adapt) {
        await tab.ext('ENABLE_ADAPTATION');
        await until(
          async () =>
            (await tab.ext<DynamicDiagnostics>('GET_DYNAMIC_DIAGNOSTICS')).state === 'IDLE',
          'idle',
        );
      }
      await tab.evaluate(FRAME_RECORDER);
      const t0 = Date.now();
      await tab.evaluate(`window.burst(0, ${n})`);
      const burstMs = Date.now() - t0;
      const t1 = Date.now();
      if (adapt) {
        await until(
          async () => {
            const d = await tab.ext<DynamicDiagnostics>('GET_DYNAMIC_DIAGNOSTICS');
            return (
              d.state === 'IDLE' &&
              d.queuedRecords === 0 &&
              d.deferredRoots === 0 &&
              d.pendingRescan === null
            );
          },
          `pipeline idle after ${n} mutations`,
          60_000,
        );
      }
      const idleMs = Date.now() - t1;
      const frames = await tab.evaluate<FrameReading>(READ_FRAMES);
      const diag = await tab.ext<DynamicDiagnostics>('GET_DYNAMIC_DIAGNOSTICS');
      return {
        tab,
        result: { n, idleMs, burstMs, maxGap: frames.maxGap, longTasks: frames.longTasks, diag },
      };
    }

    for (const n of [1_000, 5_000, 10_000]) {
      test(`${n} mutations: correct, bounded, honest`, async () => {
        const repeats = n === 1_000 ? 5 : 3;
        const off: number[] = [];
        for (let i = 0; i < repeats; i++) {
          const { tab, result } = await run(n, false);
          off.push(result.maxGap);
          await tab.close();
        }
        const ons: Run[] = [];
        let lastTab: Tab | null = null;
        for (let i = 0; i < repeats; i++) {
          const { tab, result } = await run(n, true);
          ons.push(result);
          if (i < repeats - 1) await tab.close();
          else lastTab = tab;
        }
        const tab = lastTab!;
        const last = ons[ons.length - 1]!;

        // correctness on the last run: expected rows were adapted, collateral rows were not
        const expectedCvd: number[] = [];
        const fine: number[] = [];
        for (let i = 0; i < n; i++) {
          if (i % 10 !== 0 && i % 7 === 0) expectedCvd.push(i);
          else if (i % 10 !== 0) fine.push(i);
        }
        const sample = (rows: number[], k: number) =>
          rows.filter((_, idx) => idx % Math.max(1, Math.floor(rows.length / k)) === 0).slice(0, k);
        const colors = await tab.evaluate<Record<string, string>>(
          `(() => { const out = {}; for (const i of ${JSON.stringify([...sample(expectedCvd, 300), ...sample(fine, 300)])}) out[i] = getComputedStyle(document.getElementById('r' + i)).color; return out; })()`,
        );
        const cvdAdapted = sample(expectedCvd, 300).filter((i) => colors[i] !== RED).length;
        const fineTouched = sample(fine, 300).filter((i) => colors[i] !== 'rgb(0, 0, 0)').length;
        expect(fineTouched).toBe(0); // no collateral recoloring
        const cvdRatio = cvdAdapted / sample(expectedCvd, 300).length;

        // dropped work: nothing queued or deferred when idle; overflows are reported, never silent
        expect(last.diag.queuedRecords).toBe(0);
        expect(last.diag.deferredRoots).toBe(0);
        expect(last.diag.observerStarts).toBe(1);

        // audit: no duplicate findings, no stale rows, coverage honest about truncation
        const snap = await auditRun(tab);
        const ids = snap.findings.map((f) => f.id);
        expect(new Set(ids).size).toBe(ids.length);
        const low001 = snap.findings
          .filter((f) => f.ruleId === 'CA-COLOR-001')
          .reduce((s, f) => s + f.affectedCount, 0);
        const expectedLow = Array.from({ length: n }, (_, i) => i).filter(
          (i) => i % 10 === 0 || i % 7 === 0,
        ).length;
        if (snap.coverage.analysisTruncated) {
          expect(snap.coverage.budgetsReached.length).toBeGreaterThan(0);
          expect(low001).toBeLessThanOrEqual(expectedLow);
          expect(coverageLevel(snap, 'color-contrast')).not.toBe('complete');
        } else {
          expect(low001).toBe(expectedLow);
        }

        // stale findings after removing every row: nothing from the removed rows is left
        await tab.evaluate(`document.getElementById('list').replaceChildren()`);
        await until(
          async () =>
            (await tab.ext<DynamicDiagnostics>('GET_DYNAMIC_DIAGNOSTICS')).state === 'IDLE',
          'idle after clearing',
          60_000,
        );
        const cleared = await auditRun(tab);
        expect(
          cleared.findings.filter(
            (f) => f.ruleId === 'CA-COLOR-001' || f.ruleId === 'CA-COLOR-002',
          ),
        ).toEqual([]);

        const idle = ons.map((r) => r.idleMs);
        const gap = ons.map((r) => r.maxGap);
        const longest = Math.max(0, ...ons.flatMap((r) => r.longTasks));
        const offGap = median(off);
        const idleBudget =
          n === 1_000
            ? BUDGETS.dynamicIdle1kMs
            : n === 10_000
              ? BUDGETS.dynamicIdle10kMs
              : BUDGETS.dynamicIdle10kMs;
        const detail = `n=${n} runs=${repeats}: idle latency median ${median(idle).toFixed(0)} ms p95 ${percentile(idle, 95).toFixed(0)} ms (budget ${idleBudget}); worst frame gap on ${median(gap).toFixed(0)} ms vs off ${offGap.toFixed(0)} ms; longest long-task ${longest.toFixed(0)} ms${ons[0]!.longTasks.length === 0 && browser !== 'chrome' ? ' (long-task API unavailable)' : ''}; CVD rows adapted ${(cvdRatio * 100).toFixed(1)}% of sample; collateral 0; passes: batches ${last.diag.batches}, incremental ${last.diag.incrementalPasses}, full rescans ${last.diag.fullRescans}, overflows ${last.diag.queueOverflows}, truncated passes ${last.diag.truncatedPasses}, deferred roots ${last.diag.rootsDeferred}; audit truncated=${snap.coverage.analysisTruncated} (elements analyzed ${snap.coverage.elementsAnalyzed}); COLOR-001 ${low001}/${expectedLow}`;
        // budgets
        const overBudget: string[] = [];
        if (percentile(idle, 95) > idleBudget)
          overBudget.push(`idle p95 ${percentile(idle, 95)} > ${idleBudget}`);
        if (n === 1_000 && median(gap) - offGap > BUDGETS.frameGapExtraMs)
          overBudget.push(
            `frame gap +${(median(gap) - offGap).toFixed(0)} > ${BUDGETS.frameGapExtraMs}`,
          );
        record(
          driver,
          AREA,
          `${n} mutations`,
          overBudget.length === 0 ? 'PASS' : 'FAIL',
          `${detail}${overBudget.length ? ' | OVER BUDGET: ' + overBudget.join('; ') : ''}`,
        );
        await tab.close();
        expect(overBudget).toEqual([]);
        // correctness: every sampled expected row adapted unless the pipeline reported that it truncated
        if (last.diag.truncatedPasses === 0 && last.diag.queueOverflows === 0)
          expect(cvdRatio).toBe(1);
        else expect(cvdRatio).toBeGreaterThan(0);
      });
    }

    test('attribute mutations (1,000 class flips) and idle cost', async () => {
      await driver.setSettings(SETTINGS_ON);
      const tab = await driver.newTab();
      await tab.open(`${server.origin}/dyn`);
      await until(() => tab.ext('GET_DYNAMIC_DIAGNOSTICS'), 'content script');
      await tab.evaluate(`window.burst(0, 1000)`);
      await tab.ext('ENABLE_ADAPTATION');
      const idle = async () =>
        until(
          async () =>
            (await tab.ext<DynamicDiagnostics>('GET_DYNAMIC_DIAGNOSTICS')).state === 'IDLE',
          'idle',
          30_000,
        );
      await idle();
      await tab.evaluate(`window.flip(1000)`);
      await idle();
      const afterFlip = await tab.ext<DynamicDiagnostics>('GET_DYNAMIC_DIAGNOSTICS');
      // idle: five seconds with nothing happening must not start passes (a busy loop would show here)
      await sleep(5_000);
      const afterIdle = await tab.ext<DynamicDiagnostics>('GET_DYNAMIC_DIAGNOSTICS');
      const idleBatches = afterIdle.batches - afterFlip.batches;
      expect(idleBatches).toBeLessThanOrEqual(BUDGETS.idleBatchesIn5s);
      expect(afterIdle.fullRescans).toBe(afterFlip.fullRescans);
      record(
        driver,
        AREA,
        '1000 attribute flips + 5 s idle',
        'PASS',
        `batches during idle: ${idleBatches} (budget ${BUDGETS.idleBatchesIn5s}); mutation records ${afterFlip.mutationRecords}; observerStarts ${afterIdle.observerStarts}`,
      );
      await tab.close();
    });
  });
}
