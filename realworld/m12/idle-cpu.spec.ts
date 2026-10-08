/**
 * M12.R1 (docs/m12/protocol.md, P25 idle CPU): the relative idle-CPU control, Chrome (production build).
 *
 * The idle CPU of a whole browser on this host sits on a noise floor of about 1-2 % of one core that has nothing to
 * do with the extension (M12 formal control: extension off 2.06 %, extension on 1.33 %). An absolute limit cannot
 * attribute load to ColorAdapt, so the criterion is the load ColorAdapt ADDS: median idle CPU with the extension on
 * minus median idle CPU with it off, measured under one frozen method:
 *   - identical measurement window: SETTLE_MS of settling, then WINDOWS windows of WINDOW_MS, one every
 *     WINDOW_MS + REST_MS, in both modes;
 *   - identical browser configuration: the same startChrome() options, same page (1,500 paragraphs, adapted in
 *     the "on" run), one tab, the only difference being whether the extension is loaded;
 *   - identical host state: no other browser process before either run (checked and recorded);
 *   - OFF control first, ON candidate second, once, no retry.
 * The statistic is the median over windows (each window is the CPU time of the whole browser process tree divided by
 * wall time, in percent of one core).
 */
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startChrome, ROOT, type ChromeTab } from '../lib/driver';
import { startFixtureServer } from '../lib/server';
import { SETTINGS_ON, hasStylesheet, html, record, sleep, until } from '../lib/scenario';
import { quiesce } from './kit';
import { hostBrowserInventory, sampleProcessTree, sum } from './soak-kit';

/** Frozen in docs/m12/protocol.md section 6 before the formal run. Percentage points of one core. */
export const ADDED_IDLE_CPU_PP_MAX = 1.0;
const SETTLE_MS = 30_000;
const WINDOWS = 30;
const WINDOW_MS = 10_000;
const REST_MS = 20_000;
const BROWSERS = /^(chrome|brave|msedge|firefox|geckodriver|chromedriver)$/;

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

test.describe('M12.R1 idle CPU relative control (chrome)', () => {
  test.describe.configure({ mode: 'serial' });

  const result: Record<'off' | 'on', { windows: number[]; median: number } | undefined> = {
    off: undefined,
    on: undefined,
  };
  const hostState: Record<string, unknown> = {};

  for (const mode of ['off', 'on'] as const) {
    test(`P25 idle CPU, extension ${mode}`, async () => {
      test.setTimeout(25 * 60_000);
      const others = hostBrowserInventory().filter((p) => BROWSERS.test(p.name));
      hostState[mode] = others;
      expect(others, `no other browser process before the ${mode} run`).toEqual([]);
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
      const driver = await startChrome({ extension: mode === 'on' });
      try {
        if (mode === 'on')
          await driver.setSettings({ ...SETTINGS_ON, visionProfile: 'deuteranopia' });
        const page = (await driver.newTab()) as ChromeTab;
        await page.open(`${server.origin}/big`);
        if (mode === 'on') {
          await until(() => hasStylesheet(page), 'adapted');
          await quiesce(page);
        }
        await sleep(SETTLE_MS);
        const windows: number[] = [];
        for (let i = 0; i < WINDOWS; i += 1) {
          const t0 = sampleProcessTree(driver.profileDir);
          const w0 = Date.now();
          await sleep(WINDOW_MS);
          const t1 = sampleProcessTree(driver.profileDir);
          windows.push(
            ((sum(t1, (p) => p.cpuSeconds) - sum(t0, (p) => p.cpuSeconds)) /
              ((Date.now() - w0) / 1000)) *
              100,
          );
          await sleep(REST_MS);
        }
        result[mode] = {
          windows: windows.map((w) => +w.toFixed(2)),
          median: +median(windows).toFixed(3),
        };
        console.log(
          `idle CPU extension ${mode}: ${WINDOWS} windows, median ${result[mode].median}%, min ${Math.min(...windows).toFixed(2)}%, max ${Math.max(...windows).toFixed(2)}%`,
        );
      } finally {
        await driver.close();
        await server.close();
        await sleep(3000);
      }
    });
  }

  test('P25 verdict: the idle CPU ColorAdapt adds is within the frozen threshold', () => {
    const off = result.off;
    const on = result.on;
    expect(off, 'OFF control completed').toBeDefined();
    expect(on, 'ON candidate completed').toBeDefined();
    const delta = +(on!.median - off!.median).toFixed(3);
    const summary = {
      thresholdPercentagePoints: ADDED_IDLE_CPU_PP_MAX,
      offMedian: off!.median,
      onMedian: on!.median,
      delta,
      off: off!.windows,
      on: on!.windows,
      hostState,
    };
    const out = path.join(ROOT, 'realworld', '.artifacts');
    mkdirSync(out, { recursive: true });
    writeFileSync(
      path.join(out, 'm12-idle-cpu-control.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    console.log(
      `P25 OFF ${off!.median}% ON ${on!.median}% DELTA ${delta} pp (threshold ${ADDED_IDLE_CPU_PP_MAX} pp)`,
    );
    record(
      { name: 'chrome', version: '' },
      'm12-idle-cpu',
      'P25 idle CPU relative control',
      'INFO',
      JSON.stringify(summary),
    );
    expect(
      delta,
      'idle CPU added by the extension, percentage points of one core',
    ).toBeLessThanOrEqual(ADDED_IDLE_CPU_PP_MAX);
  });
});
