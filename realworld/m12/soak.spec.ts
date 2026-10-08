/**
 * M12 (docs/m12/protocol.md) P24 resource baseline / leak test and P25 long soak, Chrome (production build).
 *
 * A long-lived single-page app tab (`L`, never reloaded, so a leak shows) and a tab that is navigated all the time
 * (`N`, a fresh document each time) are driven for `M12_SOAK_MINUTES` (default 120) with the workload of
 * soak-kit.ts, interleaved with every lifecycle event the extension has: adaptation off/on, settings changes, audit
 * runs, AI-assisted review cycles (against a loopback mock), opening and closing tabs, killing the service worker.
 * Every `M12_SOAK_SAMPLE_SECONDS` (default 60) the run records post-GC heap, DOM nodes, listeners, the dynamic
 * pipeline's queues, the extension's counters and the whole browser's process tree. The verdict rules are the
 * BUDGETS below, frozen in docs/m12/protocol.md before the formal run. No retries, no restarts, no skipped sample.
 *
 * A run shorter than SOAK_MIN_MINUTES_FOR_TRENDS checks the hard conditions only (errors, crashes, queues,
 * orphans); its trends are reported but are not a verdict.
 */
import { expect, test } from '@playwright/test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChromeTab } from '../lib/driver';
import { ROOT, startChrome } from '../lib/driver';
import { startFixtureServer } from '../lib/server';
import { SETTINGS_ON, hasStylesheet, record, sleep, until } from '../lib/scenario';
import { startMock } from './ai-mock';
import {
  fatalLogs,
  gauges,
  quiesce,
  residue,
  runningWorkers,
  stopServiceWorker,
  tabIdOf,
  toBackground,
} from './kit';
import { SOAK_PAGE, hostBrowserInventory, sampleProcessTree, sum } from './soak-kit';
import { trendOf } from './stats';

const MINUTES = Number(process.env['M12_SOAK_MINUTES'] ?? 120);
const SAMPLE_MS = Number(process.env['M12_SOAK_SAMPLE_SECONDS'] ?? 60) * 1000;
const LABEL = process.env['M12_SOAK_LABEL'] ?? 'soak';
const OUT = path.join(ROOT, 'realworld', '.artifacts');

/** The frozen verdict rules (docs/m12/protocol.md "Resource and soak budgets"). */
export const BUDGETS = {
  /** Below this a run is a smoke run: hard conditions only. */
  SOAK_MIN_MINUTES_FOR_TRENDS: 90,
  /** The first fraction of samples is warm-up and is not used in trends. */
  WARMUP_FRACTION: 0.15,
  heapAfterGc: { maxRatio: 1.15, maxSlopePerHour: 0.1 },
  domNodes: { maxRatio: 1.1, maxAbsoluteGrowth: 200 },
  listeners: { maxRatio: 1.1, maxAbsoluteGrowth: 50 },
  browserWorkingSet: { maxRatio: 1.25, maxSlopePerHour: 0.15 },
  extensionProcessWorkingSet: { maxRatio: 1.25 },
} as const;

interface Sample {
  readonly t: number;
  readonly cycle: number;
  readonly heapAfterGc: number;
  readonly domNodes: number;
  readonly listeners: number;
  readonly documents: number;
  readonly layoutObjects: number;
  readonly gauges: {
    readonly queuedRecords: number;
    readonly deferredRoots: number;
    readonly pendingLinks: number;
    readonly pendingRescan: string | null;
    readonly throttleTimerActive: boolean;
    readonly trackedElements: number;
    readonly rules: number;
    readonly observerStarts: number;
    readonly selfMutationsIgnored: number;
    readonly queueOverflows: number;
  };
  readonly sheets: number;
  readonly duplicateIds: number;
  readonly os: {
    readonly processes: number;
    readonly total: number;
    readonly renderer: number;
    readonly extension: number;
    readonly browser: number;
    readonly privateTotal: number;
  };
  readonly workers: number;
  readonly idleCpuPercent: number | null;
}

test.describe('M12 resource and soak (chrome)', () => {
  test.describe.configure({ mode: 'serial' });

  test(`P24/P25 ${MINUTES}-minute soak`, async () => {
    test.setTimeout((MINUTES + 25) * 60_000);
    mkdirSync(OUT, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const samplesFile = path.join(OUT, `m12-${LABEL}-${stamp}.jsonl`);
    const summaryFile = path.join(OUT, `m12-${LABEL}-${stamp}.summary.json`);

    const inventoryBefore = hostBrowserInventory();
    const server = await startFixtureServer();
    server.serve('soak/*', SOAK_PAGE);
    server.serve('soakn/*', SOAK_PAGE);
    server.serve('basic', '<!doctype html><title>b</title><p style="color:#aaa">basic</p>');
    const mock = await startMock('ok');
    const driver = await startChrome();
    const profile = driver.profileDir;
    const errors: string[] = [];
    let browserGone = false;
    driver.browserContext.browser()?.on('disconnected', () => (browserGone = true));

    try {
      await driver.setSettings({
        ...SETTINGS_ON,
        visionProfile: 'deuteranopia',
        adaptationStrength: 0.8,
        semanticAIEnabled: true,
        semanticAIProvider: 'local-http',
        semanticAIEndpoint: mock.endpoint,
        semanticAIModel: 'rw-mock',
      });
      const tabL = (await driver.newTab()) as ChromeTab;
      await tabL.open(`${server.origin}/soak/r0`);
      await until(() => hasStylesheet(tabL), 'the long-lived tab adapts');
      const tabN = (await driver.newTab()) as ChromeTab;
      await tabN.open(`${server.origin}/soakn/0`);
      await until(() => hasStylesheet(tabN), 'the navigated tab adapts');
      const cdp = await tabL.session();
      await cdp.send('Performance.enable');
      const idL = await tabIdOf(driver, '/soak/');

      const samples: Sample[] = [];
      const started = Date.now();
      const deadline = started + MINUTES * 60_000;
      let nextSample = started + SAMPLE_MS;
      let cycle = 0;
      const PROFILES = ['deuteranopia', 'protanopia', 'tritanopia', 'deuteranopia'] as const;

      const collectErrors = (label: string): void => {
        for (const tab of [tabL, tabN]) {
          for (const l of tab.drainLogs()) {
            if (l.level === 'pageerror' || fatalLogs([l]).length > 0)
              errors.push(`${label} ${l.level}: ${l.text}`.slice(0, 300));
          }
        }
      };

      async function takeSample(idleWindow: boolean): Promise<void> {
        await quiesce(tabL);
        await cdp.send('HeapProfiler.collectGarbage');
        await cdp.send('HeapProfiler.collectGarbage');
        const metrics = Object.fromEntries(
          (await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]),
        );
        const g = await gauges(tabL);
        const r = await residue(tabL);
        let idleCpuPercent: number | null = null;
        let tree = sampleProcessTree(profile);
        if (idleWindow) {
          const before = sum(tree, (p) => p.cpuSeconds);
          const t0 = Date.now();
          await sleep(10_000);
          tree = sampleProcessTree(profile);
          idleCpuPercent =
            ((sum(tree, (p) => p.cpuSeconds) - before) / ((Date.now() - t0) / 1000)) * 100;
        }
        const sample: Sample = {
          t: Date.now() - started,
          cycle,
          heapAfterGc: metrics['JSHeapUsedSize'] ?? 0,
          domNodes: metrics['Nodes'] ?? 0,
          listeners: metrics['JSEventListeners'] ?? 0,
          documents: metrics['Documents'] ?? 0,
          layoutObjects: metrics['LayoutObjects'] ?? 0,
          gauges: {
            queuedRecords: g.queuedRecords,
            deferredRoots: g.deferredRoots,
            pendingLinks: g.pendingLinks,
            pendingRescan: g.pendingRescan,
            throttleTimerActive: g.throttleTimerActive,
            trackedElements: g.trackedElements,
            rules: g.rules,
            observerStarts: g.observerStarts,
            selfMutationsIgnored: g.selfMutationsIgnored,
            queueOverflows: g.queueOverflows,
          },
          sheets: r.sheets,
          duplicateIds: r.duplicateIds,
          os: {
            processes: tree.length,
            total: sum(tree, (p) => p.workingSet),
            renderer: sum(tree, (p) => p.workingSet, 'renderer'),
            extension: sum(tree, (p) => p.workingSet, 'extension'),
            browser: sum(tree, (p) => p.workingSet, 'browser'),
            privateTotal: sum(tree, (p) => p.privateBytes),
          },
          workers: await runningWorkers(driver).catch(() => -1),
          idleCpuPercent,
        };
        samples.push(sample);
        appendFileSync(samplesFile, `${JSON.stringify(sample)}\n`);
      }

      await takeSample(false); // the baseline
      while (Date.now() < deadline && !browserGone) {
        cycle += 1;
        // --- the page workload (long-lived tab) ---------------------------------------------------------------
        await tabL.evaluate(`window.workload(${cycle})`);
        // --- the navigated tab: a fresh document every other cycle, with the same workload ----------------------
        if (cycle % 2 === 0) {
          await tabN.open(`${server.origin}/soakn/${cycle}`);
          await until(
            async () => (await gauges(tabN)).state === 'IDLE',
            `tab N content script ready (cycle ${cycle})`,
          );
          await tabN.evaluate(`window.workload(${cycle})`);
        }
        // --- lifecycle events -------------------------------------------------------------------------------
        if (cycle % 3 === 0) {
          await tabL.ext('DISABLE_ADAPTATION');
          expect((await residue(tabL)).sheets, 'stylesheet removed on disable').toBe(0);
          await tabL.ext('ENABLE_ADAPTATION');
        }
        if (cycle % 4 === 0) {
          await toBackground(driver, 'UPDATE_SETTINGS', {
            visionProfile: PROFILES[(cycle / 4) % PROFILES.length],
            adaptationStrength: 0.5 + 0.1 * ((cycle / 4) % 5),
          });
          await tabL.ext('REFRESH_ADAPTATION');
        }
        if (cycle % 5 === 0) {
          await tabL.ext('AUDIT_RUN', { scope: 'auto' });
          await tabL.ext('AUDIT_CLOSE');
        }
        if (cycle % 6 === 0) {
          const extra = await driver.newTab();
          await extra.open(`${server.origin}/basic?c=${cycle}`);
          await extra.close();
        }
        if (cycle % 8 === 0) {
          const audit = (await driver.extensionTab(`audit.html?tabId=${idL}`)) as ChromeTab;
          await until(
            () =>
              audit.evaluate<boolean>(`!!document.querySelector('[data-testid="summary-line"]')`),
            'audit summary',
            60_000,
          );
          if (
            await audit.evaluate<boolean>(`!!document.querySelector('[data-testid="assist-run"]')`)
          ) {
            await audit.clickButton('Run AI-assisted review');
            await until(
              () =>
                audit.evaluate<boolean>(
                  `(() => { const c = document.querySelector('[data-testid="assist-coverage"]'); const v = c && c.getAttribute('data-coverage'); return !!v && v !== 'not-run' && v !== 'running'; })()`,
                ),
              'the AI review to finish',
              90_000,
            );
          }
          await audit.close();
        }
        if (cycle % 10 === 0) {
          await stopServiceWorker(driver);
          expect((await toBackground<{ enabled: boolean }>(driver, 'GET_SETTINGS')).enabled).toBe(
            true,
          );
        }
        collectErrors(`cycle ${cycle}`);
        if (Date.now() >= nextSample) {
          nextSample += SAMPLE_MS;
          await takeSample(samples.length % 10 === 0);
          console.log(
            `[soak] ${Math.round((Date.now() - started) / 60000)} min, cycle ${cycle}, heap ${(samples.at(-1)!.heapAfterGc / 1e6).toFixed(1)} MB, nodes ${samples.at(-1)!.domNodes}, listeners ${samples.at(-1)!.listeners}, browser ${(samples.at(-1)!.os.total / 1e6).toFixed(0)} MB, errors ${errors.length}`,
          );
        }
        await sleep(1500);
      }
      await takeSample(true); // the end state

      // what the extension has persisted after all of it: one key, no page content
      const storage = await driver.extensionEval<Record<string, unknown>>(
        `(globalThis.browser ?? globalThis.chrome).storage.local.get(null)`,
      );
      const storageKeys = Object.keys(storage);
      const storageText = JSON.stringify(storage);

      // ----- verdict ----------------------------------------------------------------------------------------
      const series = (pick: (s: Sample) => number) => samples.map((s) => [s.t, pick(s)] as const);
      const trends = {
        heapAfterGc: trendOf(
          series((s) => s.heapAfterGc),
          BUDGETS.WARMUP_FRACTION,
        ),
        domNodes: trendOf(
          series((s) => s.domNodes),
          BUDGETS.WARMUP_FRACTION,
        ),
        listeners: trendOf(
          series((s) => s.listeners),
          BUDGETS.WARMUP_FRACTION,
        ),
        browserWorkingSet: trendOf(
          series((s) => s.os.total),
          BUDGETS.WARMUP_FRACTION,
        ),
        extensionProcessWorkingSet: trendOf(
          series((s) => s.os.extension),
          BUDGETS.WARMUP_FRACTION,
        ),
        privateBytes: trendOf(
          series((s) => s.os.privateTotal),
          BUDGETS.WARMUP_FRACTION,
        ),
      };
      const idle = samples.map((s) => s.idleCpuPercent).filter((v): v is number => v !== null);
      const idleMedian = idle.length
        ? [...idle].sort((a, b) => a - b)[Math.floor(idle.length / 2)]!
        : Number.NaN;
      const dirtyQueues = samples.filter(
        (s) =>
          s.gauges.queuedRecords !== 0 ||
          s.gauges.deferredRoots !== 0 ||
          s.gauges.pendingRescan !== null ||
          s.gauges.throttleTimerActive ||
          s.gauges.pendingLinks !== 0,
      );
      const bad = samples.filter(
        (s) => s.sheets > 1 || s.duplicateIds > 0 || s.gauges.queueOverflows > 0,
      );
      const overTracked = samples.filter((s) => s.gauges.trackedElements > s.domNodes);
      const workerLost = samples.filter((s) => s.workers < 0);

      const trendFailures: string[] = [];
      const fullRun = MINUTES >= BUDGETS.SOAK_MIN_MINUTES_FOR_TRENDS;
      if (
        trends.heapAfterGc.ratio > BUDGETS.heapAfterGc.maxRatio ||
        trends.heapAfterGc.slopePerHour > BUDGETS.heapAfterGc.maxSlopePerHour
      )
        trendFailures.push(`post-GC JS heap ${JSON.stringify(trends.heapAfterGc)}`);
      if (
        trends.domNodes.ratio > BUDGETS.domNodes.maxRatio &&
        trends.domNodes.late - trends.domNodes.early > BUDGETS.domNodes.maxAbsoluteGrowth
      )
        trendFailures.push(`DOM nodes ${JSON.stringify(trends.domNodes)}`);
      if (
        trends.listeners.ratio > BUDGETS.listeners.maxRatio &&
        trends.listeners.late - trends.listeners.early > BUDGETS.listeners.maxAbsoluteGrowth
      )
        trendFailures.push(`listeners ${JSON.stringify(trends.listeners)}`);
      if (
        trends.browserWorkingSet.ratio > BUDGETS.browserWorkingSet.maxRatio ||
        trends.browserWorkingSet.slopePerHour > BUDGETS.browserWorkingSet.maxSlopePerHour
      )
        trendFailures.push(`browser working set ${JSON.stringify(trends.browserWorkingSet)}`);
      if (trends.extensionProcessWorkingSet.ratio > BUDGETS.extensionProcessWorkingSet.maxRatio)
        trendFailures.push(
          `extension process working set ${JSON.stringify(trends.extensionProcessWorkingSet)}`,
        );
      // idle CPU is reported only: its criterion is the relative OFF/ON control (idle-cpu.spec.ts, M12.R1)

      const summary = {
        label: LABEL,
        minutes: MINUTES,
        formalTrendVerdict: fullRun,
        cycles: cycle,
        samples: samples.length,
        browserDisconnected: browserGone,
        errors: errors.length,
        storageKeys,
        storageBytes: storageText.length,
        errorSamples: errors.slice(0, 20),
        dirtyQueueSamples: dirtyQueues.length,
        duplicateOrOverflowSamples: bad.length,
        trackedAboveNodes: overTracked.length,
        workerProbeFailures: workerLost.length,
        trends,
        idleCpuPercentMedian: idleMedian,
        trendFailures,
        budgets: BUDGETS,
        hostBrowsersBefore: inventoryBefore,
      };
      writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
      console.log(`[soak] summary: ${summaryFile}`);

      // hard conditions: always
      expect(browserGone, 'the browser stayed up').toBe(false);
      expect(storageKeys, 'the only persisted key').toEqual(['coloradapt:settings']);
      expect(storageText.length, 'size of what is persisted').toBeLessThan(4096);
      for (const pageText of ['route ', 'paragraph', 'Dialog text', 'body text', 'Soak']) {
        expect(storageText, `page text "${pageText}" in storage`).not.toContain(pageText);
      }
      expect(errors, 'errors from ColorAdapt or from the page during the run').toEqual([]);
      expect(dirtyQueues.length, 'samples with a non-empty queue after quiescence').toBe(0);
      expect(bad.length, 'samples with a duplicate stylesheet/id or a queue overflow').toBe(0);
      expect(overTracked.length, 'samples tracking more elements than exist').toBe(0);
      // trends: a verdict only for a run long enough to have one
      if (fullRun) expect(trendFailures, 'growth beyond the frozen budgets').toEqual([]);
      record(
        driver,
        'm12-soak',
        `P25 ${MINUTES}-minute soak (${LABEL})`,
        trendFailures.length === 0 || !fullRun ? 'PASS' : 'FAIL',
        `${cycle} cycles, ${samples.length} samples, heap x${trends.heapAfterGc.ratio.toFixed(3)}, nodes x${trends.domNodes.ratio.toFixed(3)}, browser x${trends.browserWorkingSet.ratio.toFixed(3)}, idle CPU ${idleMedian.toFixed(2)}%`,
      );
    } finally {
      await driver.close();
      await server.close();
      await mock.close();
      await sleep(3000);
    }
    // nothing of ours is left running
    expect(sampleProcessTree(profile), 'processes of the closed browser').toEqual([]);
  });
});
