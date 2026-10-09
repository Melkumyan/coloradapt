/**
 * M13 release smoke: the EXACT bytes that would be uploaded (the archives in release/m13/), extracted and installed
 * into a fresh browser profile, in real Chrome and real Firefox. Not the working `dist/`.
 *
 *   fresh install: nothing stored, defaults (AI off, image layer off), the popup opens
 *   AI off: the audit page offers no review and the loopback runtime never hears from it
 *   adaptation, profile switch from the popup, OFF restores the page, a dynamic page, cues, charts, images opt-in
 *   the developer audit
 *   restart with the same profile, and an upgrade-like reload: settings preserved, AI still off
 *
 * Run `pnpm release:package` first. Evidence lines go to realworld/.artifacts/scenarios.jsonl.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { FIREFOX_ID, ROOT, startChrome, startFirefox, type Driver, type Tab } from '../lib/driver';
import { startFixtureServer, type FixtureServer } from '../lib/server';
import {
  BASIC,
  BROWSERS,
  SETTINGS_OFF,
  colorOf,
  hasStylesheet,
  html,
  record,
  until,
} from '../lib/scenario';
import { startMock, type Mock } from '../m12/ai-mock';
import { fatalLogs, quiesce, residue, tabIdOf, toBackground } from '../m12/kit';
// @ts-expect-error plain .mjs helper shared with the release scripts
import { readZip } from '../../scripts/release/lib.mjs';

const AREA = 'm13-fresh';
const VERSION = (
  JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }
).version;
const FIXTURE_DIR = path.join(ROOT, 'docs', 'store', 'reviewer-fixture');

/** A tiny single-color icon (a red cross on white): a readable monochrome bitmap for the opt-in image layer. */
const ICON_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAV0lEQVR4nGO4pq5xTV3jPxEAopIBQhHUA1fGgMwhqPr///8MmEJ4VCM04NKDKciARxqrESgakBXhciS6BjQ9mLIUayDNSaR5mrRgJS3iSEsaJCc+UpM3AGr1Wt8E4WkuAAAAAElFTkSuQmCC';

function extract(browser: 'chrome' | 'firefox'): string {
  const zip = path.join(ROOT, 'release', 'm13', browser, `coloradapt-${browser}-${VERSION}.zip`);
  const dir = mkdtempSync(path.join(tmpdir(), `coloradapt-release-${browser}-`));
  for (const [name, data] of readZip(readFileSync(zip)) as Map<string, Buffer>) {
    const file = path.join(dir, ...name.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
  return dir;
}

for (const browser of BROWSERS) {
  test.describe(`M13 fresh install of the release archive: ${browser}`, () => {
    test.describe.configure({ mode: 'serial' });
    let dir: string;
    let profile: string;
    let driver: Driver;
    let server: FixtureServer;
    let mock: Mock;

    const start = (): Promise<Driver> =>
      browser === 'chrome'
        ? startChrome({ extensionDir: dir, profileDir: profile })
        : startFirefox({ extensionDir: dir, profileDir: profile, systemAccess: true });

    test.beforeAll(async () => {
      dir = extract(browser);
      profile = mkdtempSync(path.join(tmpdir(), `coloradapt-fresh-${browser}-`));
      server = await startFixtureServer();
      server.serve('basic', BASIC);
      server.serve('sample', readFileSync(path.join(FIXTURE_DIR, 'index.html'), 'utf8'));
      server.serve('chart.html', readFileSync(path.join(FIXTURE_DIR, 'chart.html'), 'utf8'));
      server.serve(
        'dynamic',
        html(
          `<div id="host"></div><script>setTimeout(() => { const p = document.createElement('p'); p.id = 'late'; p.className = 'cvd'; p.textContent = 'Added after load'; document.getElementById('host').appendChild(p); }, 600);</script>`,
        ),
      );
      server.serve(
        'icons',
        html(
          `<button type="button" style="background:#ffffff;border:1px solid #888"><img id="ico" alt="Close" width="16" height="16" src="data:image/png;base64,${ICON_PNG}"></button>`,
        ),
      );
      mock = await startMock();
      driver = await start();
    });
    test.afterAll(async () => {
      await mock?.close();
      await driver?.close();
      await server?.close();
      // Windows may keep a handle on the profile for a moment after the browser exits; a leftover temp folder is not a failure
      for (const d of [dir, profile]) {
        try {
          rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
        } catch {
          // left for the OS temp cleanup
        }
      }
    });
    test.afterEach(async () => {
      await driver
        .extensionEval(
          `(async () => { const api = globalThis.browser ?? globalThis.chrome; for (const t of await api.tabs.query({})) { const u = t.url || ''; if (/\\/(basic|sample|dynamic|icons)$|chart\\.html$|audit\\.html/.test(u)) await api.tabs.remove(t.id).catch(() => null); } })()`,
        )
        .catch(() => null);
    });

    const page = async (name: string, settings?: Record<string, unknown>): Promise<Tab> => {
      if (settings) await driver.setSettings(settings);
      const tab = await driver.newTab();
      await tab.open(`${server.origin}/${name}`);
      return tab;
    };

    test('installs from the archive with nothing stored and the safe defaults', async () => {
      const stored = await driver.getSettings();
      expect(stored == null || Object.keys(stored).length === 0).toBe(true);
      const effective = await toBackground<Record<string, unknown>>(driver, 'GET_SETTINGS');
      expect(effective['semanticAIEnabled']).toBe(false);
      expect(effective['adaptImages']).toBe(false);
      expect(effective['visionProfile']).toBe('normal');
      const manifest = await driver.extensionEval<{ version: string; name: string }>(
        `(globalThis.browser ?? globalThis.chrome).runtime.getManifest()`,
      );
      expect(manifest.version).toBe(VERSION);
      // the permanent id (M13.R1): Firefox reports the manifest id, Chrome derives its own from the key/path
      const runtimeId = await driver.extensionEval<string>(
        `(globalThis.browser ?? globalThis.chrome).runtime.id`,
      );
      if (browser === 'firefox') expect(runtimeId).toBe(FIREFOX_ID);
      else expect(runtimeId).toMatch(/^[a-p]{32}$/);
      record(driver, AREA, 'runtime.id', 'PASS', runtimeId);
      record(
        driver,
        AREA,
        'fresh install: nothing stored, AI off, images off, defaults',
        'PASS',
        `version ${manifest.version}`,
      );
    });

    test('the popup opens with the defaults and no extension error', async () => {
      const popup = await driver.extensionTab('popup.html');
      await until(
        () => popup.evaluate<boolean>(`!!document.getElementById('vision-profile')`),
        'the popup',
      );
      expect(await popup.evaluate<string>(`document.getElementById('vision-profile').value`)).toBe(
        'normal',
      );
      expect(fatalLogs(popup.drainLogs())).toEqual([]);
      await popup.close();
      record(driver, AREA, 'popup opens, profile normal', 'PASS');
    });

    test('AI off: the audit offers no review and the loopback runtime hears nothing', async () => {
      await driver.setSettings({
        ...SETTINGS_OFF,
        enabled: true,
        semanticAIEnabled: false,
        semanticAIProvider: 'local-http',
        semanticAIEndpoint: mock.endpoint,
        semanticAIModel: 'rw-mock',
      });
      await page('sample');
      const tabId = await until(() => tabIdOf(driver, '/sample').catch(() => null), 'the page tab');
      const audit = await driver.extensionTab(`audit.html?tabId=${tabId}`);
      await until(
        () => audit.evaluate<boolean>(`!!document.querySelector('[data-testid="summary-line"]')`),
        'audit summary',
        30_000,
      );
      expect(
        await audit.evaluate<boolean>(`!!document.querySelector('[data-testid="assist-run"]')`),
      ).toBe(false);
      expect(
        await audit.evaluate<string>(
          `document.querySelector('[data-testid="assist-coverage"]')?.getAttribute('data-coverage')`,
        ),
      ).toBe('disabled');
      await new Promise((r) => setTimeout(r, 1000));
      expect(mock.seen.length).toBe(0);
      expect(fatalLogs(audit.drainLogs())).toEqual([]);
      record(driver, AREA, 'AI off: developer audit works, 0 provider requests', 'PASS');
    });

    test('adapts a page, follows a profile switch from the popup, and OFF restores the page', async () => {
      await driver.setSettings({
        ...SETTINGS_OFF,
        enabled: true,
        visionProfile: 'deuteranopia',
        adaptationStrength: 1,
      });
      const tab = await page('basic');
      await until(() => hasStylesheet(tab), 'the adaptation stylesheet', 30_000);
      await quiesce(tab);
      const adapted = await colorOf(tab, '#cvd');
      expect(adapted).not.toBe('rgb(214, 39, 40)');
      // the popup writes the profile; the content script follows
      const popup = await driver.extensionTab('popup.html');
      await until(
        () => popup.evaluate<boolean>(`!!document.getElementById('vision-profile')`),
        'the popup',
      );
      await popup.evaluate(
        `(() => { const s = document.getElementById('vision-profile'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'deuteranomaly'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
      );
      await until(
        async () =>
          ((await driver.getSettings()) as { visionProfile?: string } | null)?.visionProfile ===
          'deuteranomaly',
        'the stored profile',
      );
      await popup.close();
      // what the popup does next: tell the page (its own tab is not the active one here, so the test sends the same typed messages)
      await tab.ext('REFRESH_ADAPTATION');
      expect(await colorOf(tab, '#cvd')).not.toBe('rgb(214, 39, 40)');
      await driver.setSettings({ ...SETTINGS_OFF, enabled: false });
      await tab.ext('DISABLE_ADAPTATION');
      await until(
        async () => (await colorOf(tab, '#cvd')) === 'rgb(214, 39, 40)',
        'the page to be given back',
        30_000,
      );
      // the analyzer's own id marker is by design (docs/ARCHITECTURE.md); nothing that changes the page's look remains
      const left = await residue(tab);
      expect(Object.keys(left.attributes).filter((k) => k !== 'data-coloradapt-id')).toEqual([]);
      expect(left.styleRules).toBeLessThanOrEqual(0);
      record(
        driver,
        AREA,
        'adapts, profile switch from the popup, OFF restores the original color',
        'PASS',
      );
    });

    test('a dynamic page: an element added after load is adapted', async () => {
      await driver.setSettings({
        ...SETTINGS_OFF,
        enabled: true,
        visionProfile: 'deuteranopia',
        adaptationStrength: 1,
      });
      const tab = await page('dynamic');
      await until(
        () => tab.evaluate<boolean>(`!!document.getElementById('late')`),
        'the late element',
      );
      await quiesce(tab);
      await until(
        async () => (await colorOf(tab, '#late')) !== 'rgb(214, 39, 40)',
        'the late element to be adapted',
        20_000,
      );
      record(driver, AREA, 'dynamic page: late element adapted', 'PASS');
    });

    test('semantic cues and chart differentiation are applied; image layer off reads nothing, on reads the icon', async () => {
      await driver.setSettings({
        ...SETTINGS_OFF,
        enabled: true,
        visionProfile: 'deuteranopia',
        adaptationStrength: 0.8,
      });
      const sample = await page('sample');
      await until(() => hasStylesheet(sample), 'the stylesheet', 30_000);
      await quiesce(sample);
      const d = await sample.ext<{
        semantic: { cuesActive: number };
        images: { imagesDiscovered: number };
      }>('GET_DYNAMIC_DIAGNOSTICS');
      expect(d.semantic.cuesActive).toBeGreaterThan(0);
      expect(d.images.imagesDiscovered).toBe(0);
      const chart = await page('chart.html');
      await until(() => hasStylesheet(chart), 'the stylesheet', 30_000);
      await quiesce(chart);
      const c = await chart.ext<{ charts: { seriesAdapted: number } }>('GET_DYNAMIC_DIAGNOSTICS');
      expect(c.charts.seriesAdapted).toBeGreaterThan(0);
      await driver.setSettings({
        ...SETTINGS_OFF,
        enabled: true,
        visionProfile: 'deuteranopia',
        adaptationStrength: 1,
        adaptImages: true,
      });
      const icons = await page('icons');
      await until(() => hasStylesheet(icons).catch(() => false), 'the stylesheet', 30_000).catch(
        () => null,
      );
      await quiesce(icons);
      const i = await icons.ext<{ images: { imagesDiscovered: number } }>(
        'GET_DYNAMIC_DIAGNOSTICS',
      );
      expect(i.images.imagesDiscovered).toBeGreaterThan(0);
      record(
        driver,
        AREA,
        'cues, chart series, image layer (off reads none, opt-in discovers the icon)',
        'PASS',
        `cues ${d.semantic.cuesActive}, series ${c.charts.seriesAdapted}`,
      );
    });

    test('restart with the same profile: settings are preserved and AI is still off', async () => {
      await driver.setSettings({
        ...SETTINGS_OFF,
        enabled: true,
        visionProfile: 'tritanopia',
        adaptationStrength: 0.6,
      });
      await driver.close();
      driver = await start();
      const stored = (await driver.getSettings()) as { visionProfile?: string } | null;
      expect(stored?.visionProfile).toBe('tritanopia');
      const effective = await toBackground<Record<string, unknown>>(driver, 'GET_SETTINGS');
      expect(effective['visionProfile']).toBe('tritanopia');
      expect(effective['semanticAIEnabled']).toBe(false);
      record(driver, AREA, 'browser restart: settings kept, AI off', 'PASS');
    });

    test('an upgrade-like reload keeps the settings and does not turn AI on', async () => {
      await driver.reloadExtension();
      const effective = await toBackground<Record<string, unknown>>(driver, 'GET_SETTINGS');
      expect(effective['visionProfile']).toBe('tritanopia');
      expect(effective['semanticAIEnabled']).toBe(false);
      expect(effective['adaptImages']).toBe(false);
      record(driver, AREA, 'extension reload: settings kept, AI off, images off', 'PASS');
    });
  });
}
