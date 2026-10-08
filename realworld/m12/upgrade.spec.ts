/**
 * M12 (docs/m12/protocol.md) P11 and P12: upgrade from the previous frozen builds, downgrade disposition and an
 * upgrade over invalid state, in real Chrome.
 *
 * "Previous version" builds come from git tags (worktrees built by hand, see docs/m12/report.md "Upgrade"):
 * `m11-ai-semantic-engine` (the immediate predecessor, built as 0.0.9) and `m7-charts` (an older settings shape:
 * before the audit and the AI settings; built as 0.0.8). ColorAdapt has never been published, so there is no
 * public previous release: these are the frozen milestones. State is created by the OLD build itself, through
 * its own background. The update itself is what the browser does for an update of an unpacked extension: the
 * old one is unloaded (its service worker registration and content scripts go), the files on disk are replaced,
 * and the new version is loaded at the same path (same id); `storage.local` is carried across by the driver
 * (`reloadExtension`).
 *
 * Harness limitation (found by this suite, not a product defect): a build loaded by DevTools is not persisted by
 * the profile, so a browser that was killed and restarted with a *different* build at the same id kept the
 * previous build's cached service worker script (reproduced: m7 killed, the candidate started over its profile, the
 * m7 worker kept answering across three launches). Why is not established; a store update cannot be run offline.
 * The in-session unload/load below does not have that artifact,
 * and every step proves which build runs: the served files are hashed against the build on disk and the running
 * worker is asked to sanitize a write (only the candidate does).
 */
import { expect, test } from '@playwright/test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChromeDriver } from '../lib/driver';
import { ROOT, startChrome } from '../lib/driver';
import { startFixtureServer, type FixtureServer } from '../lib/server';
import { BASIC, colorOf, hasStylesheet, record, until } from '../lib/scenario';
import {
  SURFACE,
  diskHash,
  fatalLogs,
  quiesce,
  residue,
  servedHash,
  stopServiceWorker,
  toBackground,
} from './kit';

const AREA = 'm12-upgrade';
const KEY = 'coloradapt:settings';
const PREVIOUS = process.env['M12_PREVIOUS_DIR'] ?? 'E:/temp/claude/m12';
const M11 = path.join(PREVIOUS, 'wt-m11-ai-semantic-engine', 'dist', 'chrome-mv3');
const M7 = path.join(PREVIOUS, 'wt-m7-charts', 'dist', 'chrome-mv3');
const OLD_BUILDS: Array<[string, string]> = [
  ['m11-ai-semantic-engine', M11],
  ['m7-charts', M7],
];
const CANDIDATE = path.join(ROOT, 'dist', 'chrome-mv3');
const SITE = {
  hostname: 'example.test',
  enabled: true,
  visionProfile: 'protanopia',
  intensity: 0.5,
  adaptUI: true,
  adaptCharts: false,
  adaptImages: false,
};
const USER_STATE = {
  visionProfile: 'deuteranopia',
  adaptationStrength: 0.8,
  showWarnings: false,
  semanticCuesEnabled: false,
  improveLinks: false,
  siteOverrides: { 'example.test': SITE },
};

const manifestOf = (dir: string) =>
  JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;

const removeQuietly = (dir: string) => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
  } catch {
    // a browser may still hold a handle for a moment: leave it to the OS temp cleanup
  }
};

test.describe('M12 upgrade, downgrade and failed upgrade (chrome)', () => {
  test.describe.configure({ mode: 'serial' });
  let server: FixtureServer;
  let extDir: string;

  test.beforeAll(async () => {
    for (const [name, dir] of OLD_BUILDS) {
      if (!existsSync(path.join(dir, 'manifest.json')))
        throw new Error(`previous build ${name} missing: ${dir}`);
    }
    server = await startFixtureServer();
    server.serve('basic', BASIC);
    extDir = path.join(mkdtempSync(path.join(tmpdir(), 'coloradapt-upg-')), 'ext'); // one stable path = one extension id
  });
  test.afterAll(async () => {
    await server?.close();
    removeQuietly(path.dirname(extDir));
  });

  const put = (build: string) => {
    rmSync(extDir, { recursive: true, force: true });
    cpSync(build, extDir, { recursive: true });
  };

  /** Proves the browser runs exactly `build`: version, served files, and the behavior of the running worker. */
  async function expectRunning(driver: ChromeDriver, build: string): Promise<void> {
    const version = await driver.extensionEval<string>(`chrome.runtime.getManifest().version`);
    expect(version).toBe(manifestOf(build)['version']);
    for (const file of ['background.js', 'content-scripts/content.js', 'manifest.json']) {
      expect(await servedHash(driver, file), `${file} served by the browser`).toBe(
        diskHash(build, file),
      );
    }
    const prior = (await toBackground<{ adaptationStrength: number }>(driver, 'GET_SETTINGS'))
      .adaptationStrength;
    const probe = await toBackground<{ adaptationStrength: number }>(driver, 'UPDATE_SETTINGS', {
      adaptationStrength: 12345,
    });
    await toBackground(driver, 'UPDATE_SETTINGS', { adaptationStrength: prior });
    // only the candidate sanitizes a write; the previous builds store whatever they are given
    expect(
      probe.adaptationStrength,
      `the running worker is ${build === CANDIDATE ? 'the candidate' : 'the previous build'}`,
    ).toBe(build === CANDIDATE ? 1 : 12345);
  }

  /** The update: files on disk replaced, the extension unloaded and loaded again at the same path. */
  async function update(driver: ChromeDriver, build: string): Promise<void> {
    put(build);
    await driver.reloadExtension();
    await expectRunning(driver, build);
  }

  const start = async (build: string): Promise<ChromeDriver> => {
    put(build);
    const driver = await startChrome({ extensionDir: extDir });
    await expectRunning(driver, build);
    return driver;
  };

  for (const [name, oldDir] of OLD_BUILDS) {
    test(`P11 upgrade from ${name}: settings, profiles and adaptation survive; permissions do not widen`, async () => {
      const driver = await start(oldDir);
      try {
        const id = driver.extensionId;
        // 1. the previous build creates its own state and adapts a page
        await toBackground(driver, 'UPDATE_SETTINGS', { enabled: true });
        await toBackground(driver, 'UPDATE_SETTINGS', USER_STATE);
        const oldTab = await driver.newTab();
        await oldTab.open(`${server.origin}/basic`);
        await until(() => hasStylesheet(oldTab), 'the previous build adapts');
        const colorBefore = await colorOf(oldTab, '#cvd');
        const oldPermissions = await driver.extensionEval<string[]>(
          `chrome.runtime.getManifest().permissions`,
        );
        expect(oldPermissions).toEqual(['storage']);
        await oldTab.close();

        // 2. the update
        await update(driver, CANDIDATE);
        expect(driver.extensionId).toBe(id);
        const stored = (await driver.getSettings()) as Record<string, unknown>;
        expect(stored['visionProfile']).toBe('deuteranopia');
        expect(stored['adaptationStrength']).toBe(0.8);
        expect(stored['showWarnings']).toBe(false);
        expect(stored['semanticCuesEnabled']).toBe(false);
        expect(Object.keys(stored['siteOverrides'] as object)).toEqual(['example.test']);

        // the candidate's reading of it: complete, valid, newer settings at their safe defaults
        const settings = await toBackground<Record<string, unknown>>(driver, 'GET_SETTINGS');
        expect(settings['visionProfile']).toBe('deuteranopia');
        expect(settings['improveLinks']).toBe(false);
        expect(
          (settings['siteOverrides'] as Record<string, Record<string, unknown>>)['example.test'],
        ).toMatchObject({ visionProfile: 'protanopia', intensity: 0.5, adaptImages: false });
        expect(settings['adaptImages']).toBe(false);
        expect(settings['semanticAIEnabled']).toBe(false);

        // a worker restart right after the update changes nothing
        await stopServiceWorker(driver);
        expect(
          (await toBackground<Record<string, unknown>>(driver, 'GET_SETTINGS'))['visionProfile'],
        ).toBe('deuteranopia');

        // no permission surprise
        const manifest = await driver.extensionEval<{
          permissions: string[];
          host_permissions: string[];
        }>(`chrome.runtime.getManifest()`);
        expect(manifest.permissions).toEqual(oldPermissions);
        expect([...manifest.host_permissions].sort()).toEqual(
          SURFACE['chrome-mv3']!['host_permissions'],
        );

        // the page adapts the same, from one instance
        const tab = await driver.newTab();
        await tab.open(`${server.origin}/basic`);
        await until(() => hasStylesheet(tab), 'the candidate adapts after the upgrade');
        const g = await quiesce(tab);
        expect(g.observerStarts).toBe(1);
        const r = await residue(tab);
        expect(r.sheets).toBe(1);
        expect(r.duplicateIds).toBe(0);
        expect(await colorOf(tab, '#cvd')).toBe(colorBefore);
        expect(fatalLogs(tab.drainLogs())).toEqual([]);
        await tab.close();
        record(
          driver,
          AREA,
          `P11 upgrade from ${name}`,
          'PASS',
          `id ${id}; color ${colorBefore}; surface unchanged`,
        );
      } finally {
        await driver.close();
      }
    });
  }

  test('P12 downgrade: the older build starts and reads the newer state; newer-only fields are dropped on its next write (not guaranteed, not supported)', async () => {
    const driver = await start(CANDIDATE);
    try {
      await toBackground(driver, 'UPDATE_SETTINGS', {
        ...USER_STATE,
        adaptImages: true,
        semanticAIEnabled: true,
        semanticAIProvider: 'local-http',
        semanticAIEndpoint: 'http://127.0.0.1:8080',
        semanticAIModel: 'qwen2.5:7b-instruct',
      });
      await update(driver, M7); // the oldest shape, the largest gap

      const read = await toBackground<Record<string, unknown>>(driver, 'GET_SETTINGS');
      expect(read['visionProfile']).toBe('deuteranopia'); // what both versions know is intact
      expect(read['adaptationStrength']).toBe(0.8);
      const tab = await driver.newTab();
      await tab.open(`${server.origin}/basic`);
      await until(() => hasStylesheet(tab), 'the older build still adapts on the newer state');
      await tab.close();
      // its next write keeps only what it knows
      await toBackground(driver, 'UPDATE_SETTINGS', { showWarnings: true });
      const stored = (await driver.getSettings()) as Record<string, unknown>;
      const dropped = [
        'semanticAIEnabled',
        'semanticAIProvider',
        'semanticAIEndpoint',
        'semanticAIModel',
      ].filter((k) => !(k in stored));
      expect(stored['visionProfile']).toBe('deuteranopia');
      record(
        driver,
        AREA,
        'P12 downgrade to m7-charts',
        'INFO',
        `loads, reads and adapts; fields dropped on its next write: ${dropped.join(',') || 'none'}`,
      );

      // and forward again: the candidate recovers valid settings from the downgraded state
      await update(driver, CANDIDATE);
      const settings = await toBackground<Record<string, unknown>>(driver, 'GET_SETTINGS');
      expect(settings['visionProfile']).toBe('deuteranopia');
      expect(settings['semanticAIEnabled']).toBe(false);
      expect(String(settings['semanticAIEndpoint'])).toMatch(/^http:\/\/(127\.0\.0\.1|localhost)/);
      record(driver, AREA, 'P12 forward again after a downgrade', 'PASS');
    } finally {
      await driver.close();
    }
  });

  test('P11 failed upgrade: an upgrade over invalid state recovers, with no crash loop', async () => {
    const driver = await start(M11);
    try {
      await toBackground(driver, 'UPDATE_SETTINGS', USER_STATE);
      // a half-written / corrupt blob left behind by the old version
      await driver.extensionEval(
        `chrome.storage.local.set({ ${JSON.stringify(KEY)}: { visionProfile: 'deuteranopia', adaptationStrength: 'NaN', siteOverrides: { 'bad.test': 5, 'example.test': ${JSON.stringify(SITE)} }, semanticAIEndpoint: 'https://cloud.example' } })`,
      );
      await update(driver, CANDIDATE);
      for (let i = 0; i < 3; i++) {
        await stopServiceWorker(driver);
        const settings = await toBackground<Record<string, unknown>>(driver, 'GET_SETTINGS');
        expect(settings['visionProfile']).toBe('deuteranopia'); // recoverable part kept
        expect(settings['adaptationStrength']).toBe(0.7); // unrecoverable field: default
        expect(Object.keys(settings['siteOverrides'] as object)).toEqual(['example.test']); // bad entry dropped
        expect(String(settings['semanticAIEndpoint'])).toMatch(
          /^http:\/\/(127\.0\.0\.1|localhost)/,
        ); // never remote
      }
      const tab = await driver.newTab();
      await tab.open(`${server.origin}/basic`);
      await until(() => hasStylesheet(tab), 'adapts after recovery');
      await tab.close();
      record(
        driver,
        AREA,
        'P11 failed upgrade over invalid state',
        'PASS',
        'recoverable fields kept, bad entries dropped, 3 worker restarts, no loop',
      );
    } finally {
      await driver.close();
    }
  });
});
