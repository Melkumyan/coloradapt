/**
 * Regression check across builds: the same mutation burst against several unpacked Chrome builds (the current
 * one and older tags built in a worktree), so "is this slow because of M10-era code or was it always so?" has an
 * answer. `RW_COMPARE='label=dir,label=dir'` lists the builds (the current `dist/chrome-mv3` is always first).
 */
import { test } from '@playwright/test';
import path from 'node:path';
import { median } from './budgets';
import { ROOT, startChrome } from './lib/driver';
import { FRAME_RECORDER, READ_FRAMES, type FrameReading } from './lib/metrics';
import { startFixtureServer } from './lib/server';
import { SETTINGS_ON, html, record, until } from './lib/scenario';

const builds = [
  ['current', path.join(ROOT, 'dist', 'chrome-mv3')],
  ...(process.env['RW_COMPARE'] ?? '')
    .split(',')
    .filter(Boolean)
    .map((entry) => entry.split('=') as [string, string]),
] as Array<[string, string]>;
const N = Number(process.env['RW_COMPARE_N'] ?? '10000');
const REPEATS = Number(process.env['RW_COMPARE_REPEATS'] ?? '3');

const PAGE = html(`<ul id="list"></ul><script>
  window.burst = async (n) => {
    const list = document.getElementById('list');
    let i = 0;
    while (i < n) {
      for (let k = 0; k < 100 && i < n; k++, i++) {
        const li = document.createElement('li');
        li.id = 'r' + i;
        li.className = i % 10 === 0 ? 'low' : i % 7 === 0 ? 'cvd' : 'fine';
        li.textContent = 'row ' + i;
        list.appendChild(li);
      }
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
</script>`);

test(`compare builds: ${N} mutations`, async () => {
  const server = await startFixtureServer();
  server.serve('dyn', PAGE);
  try {
    for (const [label, dir] of builds) {
      const gaps: number[] = [];
      const tasks: number[] = [];
      const idles: number[] = [];
      let version = '';
      for (let r = 0; r < REPEATS; r++) {
        const driver = await startChrome({ extensionDir: dir });
        version = driver.version;
        try {
          await driver.setSettings(SETTINGS_ON);
          const tab = await driver.newTab();
          await tab.open(`${server.origin}/dyn`);
          await until(() => tab.ext('GET_DYNAMIC_DIAGNOSTICS'), 'content script');
          await tab.ext('ENABLE_ADAPTATION');
          await tab.evaluate(FRAME_RECORDER);
          await tab.evaluate(`window.burst(${N})`);
          const t = Date.now();
          await until(
            async () =>
              (await tab.ext<{ state: string }>('GET_DYNAMIC_DIAGNOSTICS')).state === 'IDLE',
            'idle',
            120_000,
          );
          idles.push(Date.now() - t);
          const frames = await tab.evaluate<FrameReading>(READ_FRAMES);
          gaps.push(frames.maxGap);
          tasks.push(Math.max(0, ...frames.longTasks));
        } finally {
          await driver.close();
        }
      }
      const detail = `${N} mutations x${REPEATS}: worst frame gap median ${median(gaps).toFixed(0)} ms (${gaps.map((g) => g.toFixed(0)).join('/')}), longest task median ${median(tasks).toFixed(0)} ms, idle after burst median ${median(idles).toFixed(0)} ms`;
      console.log(`COMPARE ${label}: ${detail}`);
      record({ name: 'chrome', version }, 'compare-builds', `build ${label}`, 'INFO', detail);
    }
  } finally {
    await server.close();
  }
});
