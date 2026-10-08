/**
 * M12 (docs/m12/protocol.md) P02-P06: clean install, extension reload and MV3 service-worker restart, in the
 * real browsers, on the production builds, from a fresh profile with no ColorAdapt storage.
 */
import { expect, test } from '@playwright/test';
import type { ChromeDriver, Driver } from '../lib/driver';
import { startFixtureServer, type FixtureServer } from '../lib/server';
import {
  BASIC,
  BROWSERS,
  SETTINGS_OFF,
  SETTINGS_ON,
  colorOf,
  hasStylesheet,
  launch,
  record,
  until,
} from '../lib/scenario';
import {
  SURFACE,
  fatalLogs,
  gauges,
  quiesce,
  residue,
  runningWorkers,
  stopServiceWorker,
  toBackground,
} from './kit';

const AREA = 'm12-lifecycle';
const surfaceKey = (driver: Driver) => (driver.name === 'chrome' ? 'chrome-mv3' : 'firefox-mv2');

for (const browser of BROWSERS) {
  test.describe(`M12 lifecycle ${browser}`, () => {
    test.describe.configure({ mode: 'serial' });
    let driver: Driver;
    let server: FixtureServer;

    test.beforeAll(async () => {
      server = await startFixtureServer();
      server.serve('basic', BASIC);
      driver = await launch(browser); // a fresh profile: no ColorAdapt storage, no earlier extension state
    });
    test.afterAll(async () => {
      await driver?.close();
      await server?.close();
    });

    test('P02/P03 clean install: loads, background answers, defaults are valid, UI opens, first adaptation works', async () => {
      // nothing stored yet
      expect((await driver.getSettings()) ?? undefined).toBeUndefined();

      // the installed manifest is the frozen surface
      const manifest = await driver.extensionEval<Record<string, unknown>>(
        `(globalThis.browser ?? globalThis.chrome).runtime.getManifest()`,
      );
      const golden = SURFACE[surfaceKey(driver)]!;
      expect(manifest['manifest_version']).toBe(golden['manifest_version']);
      const granted = await driver.extensionEval<{ permissions?: string[]; origins?: string[] }>(
        `(globalThis.browser ?? globalThis.chrome).permissions.getAll()`,
      );
      const permissions = [...(granted.permissions ?? [])].sort();
      const origins = [...(granted.origins ?? [])].sort();
      // MV3 grants host permissions as origins; MV2 lists them with the permissions: the union is the surface
      expect([...permissions, ...origins].sort()).toEqual(
        [
          ...(golden['permissions'] as string[]),
          ...(golden['host_permissions'] as string[]),
        ].sort(),
      );

      // the background answers and its default settings are valid and OFF-safe
      const settings = await toBackground<Record<string, unknown>>(driver, 'GET_SETTINGS');
      expect(settings['enabled']).toBe(true); // the product default
      expect(settings['adaptImages']).toBe(false);
      expect(settings['semanticAIEnabled']).toBe(false);
      expect(String(settings['semanticAIEndpoint'])).toMatch(
        /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])/,
      );

      // the UI opens without a fatal error
      for (const pagePath of ['popup.html', 'options.html']) {
        const ui = await driver.extensionTab(pagePath);
        await until(
          () =>
            ui.evaluate<boolean>(
              `document.querySelector('main')?.getAttribute('aria-busy') !== 'true'`,
            ),
          `${pagePath} to render`,
        );
        expect(fatalLogs(ui.drainLogs()), pagePath).toEqual([]);
        await ui.close();
      }

      // the default profile is "normal" (nothing to adapt); the first adaptation is what a user gets after choosing
      // a profile, on a page the extension has never seen
      const chosen = await toBackground<{ visionProfile: string }>(driver, 'UPDATE_SETTINGS', {
        visionProfile: 'deuteranopia',
      });
      expect(chosen.visionProfile).toBe('deuteranopia');
      const tab = await driver.newTab();
      await tab.open(`${server.origin}/basic`);
      await until(() => hasStylesheet(tab), 'first adaptation after choosing a profile');
      const state = await residue(tab);
      expect(state.sheets).toBe(1);
      expect(state.duplicateIds).toBe(0);
      expect(fatalLogs(tab.drainLogs())).toEqual([]);
      // the extension asked the network for nothing: the page itself is the only request
      expect(
        server.requests().filter((r) => !r.endsWith('/basic') && !r.includes('favicon')),
      ).toEqual([]);
      await tab.close();
      record(
        driver,
        AREA,
        'P02/P03 clean install',
        'PASS',
        `permissions=${permissions.join(',')} origins=${origins.join(',')}`,
      );
    });

    test('P05 extension reload with an adapted tab: the orphan is cleaned, nothing is duplicated', async () => {
      await driver.setSettings(SETTINGS_ON);
      const old = await driver.newTab();
      await old.open(`${server.origin}/basic?old=1`);
      await until(() => hasStylesheet(old), 'adapted before reload');
      const before = await colorOf(old, '#cvd');

      await driver.reloadExtension();
      await driver.setSettings(SETTINGS_OFF);

      // the new extension cannot reach the old page; the old page must undo itself
      let orphanDetail = '';
      if (browser === 'chrome') {
        await until(
          async () => !(await hasStylesheet(old)),
          'the orphaned page to remove its stylesheet',
          15_000,
        );
        orphanDetail = 'orphan removed its stylesheet';
      } else {
        // Firefox destroys the old content script with the extension: it cannot clean up and does not reinject
        // into open tabs. Record what is there; the page must remain usable either way.
        orphanDetail = `orphan keeps stylesheet: ${await hasStylesheet(old)} (Firefox cannot run code in a destroyed content script)`;
      }
      expect(await old.evaluate<string>(`document.getElementById('fine').textContent`)).toContain(
        'readable',
      );

      // reloading the page gives exactly one new instance, in the page's current state
      await driver.setSettings(SETTINGS_ON);
      await old.reload();
      await until(() => hasStylesheet(old), 'adaptation after reload of the tab');
      const g = await quiesce(old);
      const state = await residue(old);
      expect(state.sheets).toBe(1);
      expect(state.duplicateIds).toBe(0);
      expect(g.observerStarts).toBe(1);
      expect(await colorOf(old, '#cvd')).toBe(before);

      const fresh = await driver.newTab();
      await fresh.open(`${server.origin}/basic?fresh=1`);
      await until(() => hasStylesheet(fresh), 'adaptation on a new page after the reload');
      expect((await residue(fresh)).sheets).toBe(1);
      await old.close();
      await fresh.close();
      await driver.setSettings(SETTINGS_OFF);
      record(driver, AREA, 'P05 extension reload', 'PASS', orphanDetail);
    });

    test('P05 repeated reloads do not accumulate: five reloads, one instance per page, one stylesheet', async () => {
      await driver.setSettings(SETTINGS_ON);
      for (let i = 0; i < 5; i++) {
        const tab = await driver.newTab();
        await tab.open(`${server.origin}/basic?round=${i}`);
        await until(() => hasStylesheet(tab), `adapted in round ${i}`);
        await driver.reloadExtension();
        if (browser === 'chrome') {
          await until(async () => !(await hasStylesheet(tab)), `orphan ${i} cleaned`, 15_000);
        }
        await tab.close();
      }
      const last = await driver.newTab();
      await last.open(`${server.origin}/basic?last=1`);
      await until(() => hasStylesheet(last), 'adapted after five reloads');
      const g = await quiesce(last);
      expect((await residue(last)).sheets).toBe(1);
      expect(g.observerStarts).toBe(1);
      await last.close();
      await driver.setSettings(SETTINGS_OFF);
      record(driver, AREA, 'P05 five consecutive reloads', 'PASS');
    });

    test('P06 MV3 service worker restart: stopped worker wakes on a message, nothing depends on its memory', async () => {
      test.skip(
        browser !== 'chrome',
        'MV3 service worker: Chrome only (the Firefox build is MV2 with a persistent background page)',
      );
      const chrome = driver as ChromeDriver;
      await driver.setSettings(SETTINGS_ON);
      const tab = await driver.newTab();
      await tab.open(`${server.origin}/basic?sw=1`);
      await until(() => hasStylesheet(tab), 'adapted');
      const adapted = await colorOf(tab, '#cvd');

      for (let i = 0; i < 3; i++) {
        await stopServiceWorker(chrome);
        expect(await runningWorkers(chrome)).toBe(0);
        // the content script keeps working without a worker
        await tab.ext('FLUSH_DYNAMIC');
        expect(await colorOf(tab, '#cvd')).toBe(adapted);
        // a message from an extension page wakes a fresh worker, which reads settings from storage
        const settings = await toBackground<{ enabled: boolean; visionProfile: string }>(
          driver,
          'GET_SETTINGS',
        );
        expect(settings.enabled).toBe(true);
        expect(await runningWorkers(chrome)).toBe(1);
      }

      // a worker that is down when a page loads: the page's own startup message wakes it
      await stopServiceWorker(chrome);
      const second = await driver.newTab();
      await second.open(`${server.origin}/basic?sw=2`);
      await until(() => hasStylesheet(second), 'a page loaded while the worker was down adapts');

      // an update through the worker after a restart reaches storage and the page
      await stopServiceWorker(chrome);
      const updated = await toBackground<{ adaptationStrength: number }>(
        driver,
        'UPDATE_SETTINGS',
        {
          adaptationStrength: 0.5,
        },
      );
      expect(updated.adaptationStrength).toBe(0.5);
      await tab.ext('REFRESH_ADAPTATION');
      expect((await residue(tab)).sheets).toBe(1);
      expect((await gauges(tab)).observerStarts).toBeGreaterThanOrEqual(1);
      await second.close();
      await tab.close();
      await driver.setSettings(SETTINGS_OFF);
      record(
        driver,
        AREA,
        'P06 service worker stop/restart x5',
        'PASS',
        'worker woke on every message; page unaffected',
      );
    });
  });
}
