/**
 * M12 (docs/m12/protocol.md) P04 and P10: browser restart with an adapted page (persistent state kept, runtime
 * state rebuilt, nothing multiplied across restarts) and malformed persistent state in the real browsers.
 */
import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChromeDriver, Driver } from '../lib/driver';
import { startChrome, startFirefox } from '../lib/driver';
import { startFixtureServer, type FixtureServer } from '../lib/server';
import {
  BASIC,
  BROWSERS,
  SETTINGS_ON,
  colorOf,
  hasStylesheet,
  launch,
  record,
  sleep,
  until,
} from '../lib/scenario';
import { FirefoxDriver } from '../lib/driver';
import { fatalLogs, quiesce, residue, runningWorkers, toBackground } from './kit';
import { captureFailure, newP04Recorder } from './p04-evidence';
import { profileState, type EvidenceRecorder } from '../lib/evidence';

const AREA = 'm12-state';
/** Restarts per P04 run: 4 (the protocol), raised only by the stress runs of section 13. */
const ROUNDS = Number(process.env['M12_P04_ROUNDS'] ?? 4);
const KEY = 'coloradapt:settings';

const REPRESENTATIVE = {
  ...SETTINGS_ON,
  visionProfile: 'deuteranopia',
  adaptationStrength: 0.8,
  semanticCuesEnabled: true,
  showWarnings: false,
  siteOverrides: {
    'example.test': {
      hostname: 'example.test',
      enabled: true,
      visionProfile: 'protanopia',
      intensity: 0.5,
      adaptUI: true,
      adaptCharts: false,
      adaptImages: false,
    },
  },
};

const rawSet = (driver: Driver, value: unknown) =>
  driver.extensionEval(
    `(async () => { const api = globalThis.browser ?? globalThis.chrome; await api.storage.local.set({ ${JSON.stringify(KEY)}: ${JSON.stringify(value)} }); })()`,
  );

const rawRemoveAll = (driver: Driver) =>
  driver.extensionEval(
    `(async () => { const api = globalThis.browser ?? globalThis.chrome; await api.storage.local.clear(); })()`,
  );

const session = (
  browser: 'chrome' | 'firefox',
  profile: string,
  evidence?: EvidenceRecorder,
): Promise<Driver> =>
  browser === 'chrome'
    ? startChrome({ profileDir: profile })
    : startFirefox({ profileDir: profile, ...(evidence ? { evidence } : {}) });

for (const browser of BROWSERS) {
  test.describe(`M12 restart ${browser}`, () => {
    test.describe.configure({ mode: 'serial' });
    let server: FixtureServer;
    test.beforeAll(async () => {
      server = await startFixtureServer();
      server.serve('basic', BASIC);
    });
    test.afterAll(async () => {
      await server?.close();
    });

    test('P04 three browser restarts with an adapted page: settings kept, runtime state rebuilt, nothing multiplied', async () => {
      const profile = mkdtempSync(path.join(tmpdir(), `coloradapt-m12-${browser}-`));
      const seen: Array<{ rules: number; observerStarts: number; sheets: number; color: string }> =
        [];
      // Firefox only: the formal run once failed in round >= 1 with a masked extension-side error and left nothing to
      // diagnose. The evidence is recorded for every run (success or not) and only observes; see p04-evidence.ts.
      const evidence = browser === 'firefox' ? newP04Recorder(browser) : undefined;
      const readiness: number[] = [];
      let captured = false;
      let failed = false;
      try {
        for (let round = 0; round < ROUNDS; round++) {
          evidence?.beginRound(round, profile);
          let driver: Driver | undefined;
          try {
            driver = await session(browser, profile, evidence);
            if (driver instanceof FirefoxDriver) {
              // Firefox may refuse the first storage access after a start (protocol section 13): an explicit, bounded
              // readiness precondition. Attempts are reported, not hidden; the assertions below are unchanged.
              const attempts = await driver.awaitStorageReady();
              readiness.push(attempts.length);
              if (attempts.length > 1)
                test.info().annotations.push({
                  type: 'storage-readiness',
                  description: `round ${round}: ${attempts.length} attempts: ${JSON.stringify(attempts.map((a) => a.error?.message ?? a.outcome))}`,
                });
            }
            if (round === 0) await driver.setSettings(REPRESENTATIVE);
            else {
              const stored = (await driver.getSettings()) as Record<string, unknown>;
              expect(stored['visionProfile']).toBe('deuteranopia');
              expect(stored['adaptationStrength']).toBe(0.8);
              expect(stored['showWarnings']).toBe(false);
              expect(Object.keys(stored['siteOverrides'] as object)).toEqual(['example.test']);
            }
            const tab = await driver.newTab();
            await tab.open(`${server.origin}/basic`);
            await until(() => hasStylesheet(tab), `adapted page after restart ${round}`);
            const g = await quiesce(tab);
            const r = await residue(tab);
            expect(r.sheets).toBe(1);
            expect(r.duplicateIds).toBe(0);
            expect(g.observerStarts).toBe(1); // a fresh document, one observer
            seen.push({
              rules: g.rules,
              observerStarts: g.observerStarts,
              sheets: r.sheets,
              color: await colorOf(tab, '#cvd'),
            });
            const popup = await driver.extensionTab('popup.html');
            await until(
              () =>
                popup.evaluate<boolean>(
                  `document.querySelector('main')?.getAttribute('aria-busy') !== 'true'`,
                ),
              'popup',
            );
            expect(fatalLogs(popup.drainLogs())).toEqual([]);
            await popup.close();
            await tab.close();
          } catch (e) {
            if (evidence) {
              failed = true;
              captured = true;
              await captureFailure({
                recorder: evidence,
                driver: driver as Parameters<typeof captureFailure>[0]['driver'],
                profileDir: profile,
                error: e,
              });
            }
            throw e;
          } finally {
            await driver?.close();
            evidence?.endRound({ profileAfter: profileState(profile) });
          }
          await sleep(browser === 'firefox' ? 2000 : 500);
        }
        // identical every time: a restart does not accumulate anything
        for (const s of seen) expect(s).toEqual(seen[0]);
        record(
          { name: browser, version: '' },
          AREA,
          'P04 four sessions on one profile',
          'PASS',
          JSON.stringify(seen[0]),
        );
      } catch (e) {
        if (evidence && !captured) {
          failed = true;
          await captureFailure({
            recorder: evidence,
            driver: undefined,
            profileDir: profile,
            error: e,
          });
        }
        throw e;
      } finally {
        evidence?.finish(failed ? 'FAIL' : 'PASS', { readinessAttemptsPerRound: readiness });
        await sleep(1000);
        rmSync(profile, { recursive: true, force: true });
      }
    });
  });

  test.describe(`M12 storage corruption ${browser}`, () => {
    test.describe.configure({ mode: 'serial' });
    let driver: Driver;
    let server: FixtureServer;
    test.beforeAll(async () => {
      server = await startFixtureServer();
      server.serve('basic', BASIC);
      driver = await launch(browser);
    });
    test.afterAll(async () => {
      await driver?.close();
      await server?.close();
    });

    const MALFORMED: Array<[string, unknown, (s: Record<string, unknown>) => void]> = [
      [
        'a string instead of an object',
        '{"enabled": tru',
        (s) => expect(s['visionProfile']).toBe('normal'),
      ],
      ['a number', 42, (s) => expect(s['enabled']).toBe(true)],
      ['null', null, (s) => expect(s['enabled']).toBe(true)],
      ['an array', [1, 2], (s) => expect(s['enabled']).toBe(true)],
      ['an empty object (partial write)', {}, (s) => expect(s['visionProfile']).toBe('normal')],
      [
        'wrong types',
        { enabled: 'yes', visionProfile: 7, adaptationStrength: 'high', siteOverrides: 5 },
        (s) => expect(s['adaptationStrength']).toBe(0.7),
      ],
      [
        'unknown enum values',
        { visionProfile: 'superhuman', semanticAIProvider: 'cloud' },
        (s) => expect(s['semanticAIProvider']).toBe('local-ollama'),
      ],
      [
        'numbers out of bounds',
        { adaptationStrength: 12345 },
        (s) => expect(s['adaptationStrength']).toBe(1),
      ],
      [
        'a remote AI endpoint',
        { semanticAIEndpoint: 'https://evil.example/' },
        (s) =>
          expect(String(s['semanticAIEndpoint'])).toMatch(/^http:\/\/(127\.0\.0\.1|localhost)/),
      ],
      [
        'a schema version from the future plus a recoverable field',
        { schemaVersion: 99, visionProfile: 'tritanopia', unknownFutureThing: { a: 1 } },
        (s) => expect(s['visionProfile']).toBe('tritanopia'),
      ],
    ];

    for (const [name, blob, check] of MALFORMED) {
      test(`P10 ${name}: valid settings, UI works, the page adapts per the recovered settings, no crash loop`, async () => {
        await rawSet(driver, blob);
        const settings = await toBackground<Record<string, unknown>>(driver, 'GET_SETTINGS');
        expect(settings).toBeTruthy();
        expect(typeof settings['enabled']).toBe('boolean');
        expect(settings['adaptImages']).toBe(false);
        expect(settings['semanticAIEnabled']).toBe(false);
        check(settings);

        const popup = await driver.extensionTab('popup.html');
        await until(
          () => popup.evaluate<boolean>(`!!document.querySelector('button[aria-pressed]')`),
          'the popup to render its controls from recovered settings',
        );
        expect(fatalLogs(popup.drainLogs())).toEqual([]);
        await popup.close();

        const tab = await driver.newTab();
        await tab.open(`${server.origin}/basic?corrupt=${encodeURIComponent(name)}`);
        await until(
          async () =>
            (await tab.ext<{ state: string }>('GET_DYNAMIC_DIAGNOSTICS')).state !== undefined,
          'content script',
        );
        expect(fatalLogs(tab.drainLogs())).toEqual([]);
        expect((await residue(tab)).sheets).toBeLessThanOrEqual(1);
        await tab.close();
        if (browser === 'chrome')
          expect(await runningWorkers(driver as ChromeDriver)).toBeLessThanOrEqual(1);
        record(driver, AREA, `P10 ${name}`, 'PASS');
      });
    }

    test('P10 a settings write after corruption stores a valid, sanitized object', async () => {
      await rawSet(driver, {
        enabled: false,
        visionProfile: 'protanopia',
        adaptationStrength: 'x',
        junk: '<script>',
      });
      const next = await toBackground<Record<string, unknown>>(driver, 'UPDATE_SETTINGS', {
        showWarnings: false,
      });
      expect(next['enabled']).toBe(false);
      expect(next['visionProfile']).toBe('protanopia'); // the recoverable part survived
      const stored = (await driver.getSettings()) as Record<string, unknown>;
      expect(stored).not.toHaveProperty('junk');
      expect(stored['adaptationStrength']).toBe(0.7);
      record(driver, AREA, 'P10 write after corruption is sanitized', 'PASS');
    });

    test('P10 cleared storage (no settings) behaves as a fresh install; foreign junk keys are ignored', async () => {
      await rawRemoveAll(driver);
      await driver.extensionEval(
        `(async () => { const api = globalThis.browser ?? globalThis.chrome; await api.storage.local.set({ 'coloradapt:cache': { junk: true }, other: 'x'.repeat(1000) }); })()`,
      );
      const settings = await toBackground<Record<string, unknown>>(driver, 'GET_SETTINGS');
      expect(settings['visionProfile']).toBe('normal');
      expect(settings['enabled']).toBe(true);
      record(driver, AREA, 'P10 cleared storage + junk keys', 'PASS');
    });
  });
}
