/**
 * M12 (docs/m12/protocol.md) P20: crash recovery in the real browsers (production builds). The browser is killed
 * the way a crash or a power loss does (no shutdown), with settings writes in flight and a page waiting on a
 * stylesheet; a tab is crashed; the service worker is stopped while messages are in flight; the extension is
 * reloaded with work pending. Afterwards the settings are valid, the extension works, nothing of the dead
 * documents is left, and nothing hangs.
 */
import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChromeTab, Driver } from '../lib/driver';
import { startChrome, startFirefox } from '../lib/driver';
import { startFixtureServer, type FixtureServer } from '../lib/server';
import {
  BASIC,
  BROWSERS,
  SETTINGS_ON,
  hasStylesheet,
  html,
  record,
  sleep,
  until,
} from '../lib/scenario';
import { fatalLogs, gauges, quiesce, residue, stopServiceWorker, toBackground } from './kit';

const AREA = 'm12-crash';

/** Kills the browser started with `profileDir` and everything below it, without any shutdown. */
function killBrowser(kind: 'chrome' | 'firefox', profileDir: string): number {
  const exe = kind === 'chrome' ? 'chrome.exe' : 'firefox.exe';
  const escaped = profileDir.replace(/'/g, "''");
  const script = `
    $all = Get-CimInstance Win32_Process -Filter "Name='${exe}'"
    $roots = $all | Where-Object { $_.CommandLine -like '*${escaped}*' -and $_.CommandLine -notlike '*--type=*' -and $_.CommandLine -notlike '*-contentproc*' }
    $n = 0
    foreach ($r in $roots) { & taskkill /pid $r.ProcessId /T /F | Out-Null; $n++ }
    $n`;
  const run = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  });
  return Number(run.stdout.trim().split(/\s+/).pop() ?? 0);
}

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

const open = (browser: 'chrome' | 'firefox', profile: string): Promise<Driver> =>
  browser === 'chrome'
    ? startChrome({ profileDir: profile })
    : startFirefox({ profileDir: profile });

for (const browser of BROWSERS) {
  test.describe(`M12 crash recovery ${browser}`, () => {
    test.describe.configure({ mode: 'serial' });
    let server: FixtureServer;
    let hang: Awaited<ReturnType<typeof startHangingServer>>;

    test.beforeAll(async () => {
      server = await startFixtureServer();
      hang = await startHangingServer();
      server.serve('basic', BASIC);
      server.serve(
        'pending',
        html(
          `<p class="cvd">pending page</p><script>setTimeout(() => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '${hang.origin}/never.css'; document.head.append(l); }, 150);</script>`,
        ),
      );
    });
    test.afterAll(async () => {
      await server?.close();
      await hang?.close();
    });

    test('P20 the browser is killed with settings writes in flight and a page waiting: restart is clean', async () => {
      const profile = mkdtempSync(path.join(tmpdir(), `coloradapt-m12-crash-${browser}-`));
      try {
        const first = await open(browser, profile);
        let killed = 0;
        try {
          await first.setSettings({
            ...SETTINGS_ON,
            visionProfile: 'deuteranopia',
            adaptationStrength: 0.4,
          });
          const tab = await first.newTab();
          await tab.open(`${server.origin}/pending?kill=1`);
          await until(async () => (await gauges(tab)).pendingLinks > 0, 'a pending link');
          // writes in flight: do not wait for them
          void first
            .extensionEval(
              `(async () => { const api = globalThis.browser ?? globalThis.chrome; for (let i = 0; i < 300; i++) { await api.runtime.sendMessage({ channel: 'coloradapt', type: 'UPDATE_SETTINGS', payload: { adaptationStrength: (i % 10) / 10 } }); } })()`,
            )
            .catch(() => null);
          await sleep(400);
          killed = killBrowser(browser, profile);
        } finally {
          await first.close().catch(() => null);
        }
        expect(killed, 'a browser process tree was killed').toBeGreaterThan(0);
        await sleep(browser === 'firefox' ? 3000 : 1000);

        const second = await open(browser, profile);
        try {
          const settings = await toBackground<Record<string, unknown>>(second, 'GET_SETTINGS');
          expect(typeof settings['enabled']).toBe('boolean');
          expect(settings['visionProfile']).toBe('deuteranopia'); // written before the crash, intact
          const strength = settings['adaptationStrength'] as number;
          expect(strength).toBeGreaterThanOrEqual(0);
          expect(strength).toBeLessThanOrEqual(1); // one of the values written (or the prior one), never garbage
          const tab = await second.newTab();
          await tab.open(`${server.origin}/basic?after=1`);
          await until(() => hasStylesheet(tab), 'adaptation after the crash');
          const g = await quiesce(tab);
          expect(g.observerStarts).toBe(1);
          expect((await residue(tab)).sheets).toBe(1);
          expect(fatalLogs(tab.drainLogs())).toEqual([]);
          await tab.close();
        } finally {
          await second.close();
        }
        record(
          { name: browser, version: '' },
          AREA,
          'P20 browser killed with writes in flight',
          'PASS',
        );
      } finally {
        await sleep(1500);
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
      }
    });

    test('P20 extension reload while a page waits on a stylesheet', async () => {
      const driver = await (browser === 'chrome' ? startChrome() : startFirefox());
      try {
        await driver.setSettings({ ...SETTINGS_ON, visionProfile: 'deuteranopia' });
        const waiting = await driver.newTab();
        await waiting.open(`${server.origin}/pending?reload=1`);
        await until(async () => (await gauges(waiting)).pendingLinks > 0, 'a pending link');
        await driver.reloadExtension();
        if (browser === 'chrome') {
          await until(
            async () => !(await hasStylesheet(waiting)),
            'the orphan to settle',
            15_000,
          ).catch(() => null);
        }
        const fresh = await driver.newTab();
        await fresh.open(`${server.origin}/basic?fresh=1`);
        await until(() => hasStylesheet(fresh), 'a new page adapts after the reload');
        const g = await quiesce(fresh);
        expect(g.observerStarts).toBe(1);
        expect((await residue(fresh)).sheets).toBe(1);
        await waiting.close();
        await fresh.close();
        record(driver, AREA, 'P20 extension reload with pending work', 'PASS');
      } finally {
        await driver.close();
      }
    });

    test('P20 service worker stopped while messages are in flight; a tab crash leaves the rest alone', async () => {
      test.skip(browser !== 'chrome', 'MV3 worker and CDP tab crash: Chrome only');
      const driver = await startChrome();
      try {
        await driver.setSettings({ ...SETTINGS_ON, visionProfile: 'deuteranopia' });
        const tab = await driver.newTab();
        await tab.open(`${server.origin}/basic?inflight=1`);
        await until(() => hasStylesheet(tab), 'adapted');
        // messages in flight while the worker is stopped
        const outcomes = await Promise.all([
          stopServiceWorker(driver).then(() => 'stopped'),
          ...Array.from({ length: 20 }, () =>
            driver
              .extensionEval<string>(
                `(async () => { const api = globalThis.browser ?? globalThis.chrome; const timeout = new Promise((r) => setTimeout(() => r('timeout'), 10000)); const send = api.runtime.sendMessage({ channel: 'coloradapt', type: 'GET_SETTINGS', payload: undefined }).then((v) => (v ? 'answered' : 'empty'), () => 'rejected'); return await Promise.race([send, timeout]); })()`,
              )
              .catch(() => 'evalerror'),
          ),
        ]);
        expect(
          outcomes.filter((o) => o === 'timeout'),
          'no message hangs',
        ).toEqual([]);
        expect((await toBackground<{ enabled: boolean }>(driver, 'GET_SETTINGS')).enabled).toBe(
          true,
        );

        // a tab crash: only that tab goes
        const victim = (await driver.newTab()) as ChromeTab;
        await victim.open(`${server.origin}/basic?victim=1`);
        await until(() => hasStylesheet(victim), 'victim adapted');
        const cdp = await victim.session();
        void cdp.send('Page.crash').catch(() => null); // the renderer dies: the call never answers
        await sleep(1000);
        expect(await hasStylesheet(tab)).toBe(true);
        expect((await toBackground<{ enabled: boolean }>(driver, 'GET_SETTINGS')).enabled).toBe(
          true,
        );
        const again = await driver.newTab();
        await again.open(`${server.origin}/basic?again=1`);
        await until(() => hasStylesheet(again), 'a new tab adapts after another crashed');
        expect((await residue(again)).sheets).toBe(1);
        await again.close();
        await tab.close();
        record(
          driver,
          AREA,
          'P20 worker stop with messages in flight; tab crash',
          'PASS',
          outcomes.join(','),
        );
      } finally {
        await driver.close();
      }
    });
  });
}
