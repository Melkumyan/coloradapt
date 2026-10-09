/**
 * M13: the permissions of the release packages as the browsers themselves report them (not as our listing says), so
 * the listing explains exactly these and nothing is announced that the text does not cover.
 *
 *   Chrome:  developerPrivate (the data behind chrome://extensions and the install dialog): broad host access (the
 *            browser derives its "all websites" warning from `hasAllHosts`) and NO other permission warning.
 *   Firefox: permissions.getAll() from the extension: `storage` and the two web patterns, plus the data-collection
 *            declaration of the manifest.
 *
 * The exact words of the two dialogs are the browsers' own (Chrome: "Read and change all your data on all websites";
 * Firefox: "Access your data for all websites"); they are not captured here and are quoted in the listing as documented.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ROOT, startChrome, startFirefox } from '../lib/driver';
import { BROWSERS, record } from '../lib/scenario';
// @ts-expect-error plain .mjs helper shared with the release scripts
import { readZip } from '../../scripts/release/lib.mjs';

const VERSION = (
  JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

function extract(browser: 'chrome' | 'firefox'): string {
  const zip = path.join(ROOT, 'release', 'm13', browser, `coloradapt-${browser}-${VERSION}.zip`);
  const dir = mkdtempSync(path.join(tmpdir(), `coloradapt-prompt-${browser}-`));
  for (const [name, data] of readZip(readFileSync(zip)) as Map<string, Buffer>) {
    const file = path.join(dir, ...name.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
  return dir;
}

interface ChromeInfo {
  runtimeHostPermissions: { hasAllHosts: boolean; hosts: Array<{ host: string }> };
  simplePermissions: unknown[];
}

for (const browser of BROWSERS) {
  test(`${browser}: the permissions of the release package, as the browser reports them`, async () => {
    test.setTimeout(180_000);
    const dir = extract(browser);
    const driver =
      browser === 'chrome'
        ? await startChrome({ extensionDir: dir })
        : await startFirefox({ extensionDir: dir, systemAccess: true });
    try {
      let facts: unknown;
      if (browser === 'chrome') {
        const tab = await driver.newTab();
        await tab.open('chrome://extensions/');
        const info = await tab.evaluate<ChromeInfo>(
          `new Promise((resolve, reject) => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: false }, (all) => { const e = all.find((x) => x.name === 'ColorAdapt'); e ? resolve(e.permissions) : reject(new Error('not installed')); }))`,
        );
        await tab.close();
        expect(info.runtimeHostPermissions.hasAllHosts).toBe(true);
        expect(info.runtimeHostPermissions.hosts.map((h) => h.host).sort()).toEqual([
          'http://*/*',
          'https://*/*',
        ]);
        // storage carries no warning, and nothing else is declared
        expect(info.simplePermissions).toEqual([]);
        facts = info;
      } else {
        const got = await driver.extensionEval<{
          permissions: string[];
          origins: string[];
          data_collection?: string[];
        }>(`(globalThis.browser ?? globalThis.chrome).permissions.getAll()`);
        const manifest = await driver.extensionEval<{
          browser_specific_settings: { gecko: { data_collection_permissions: unknown } };
        }>(`(globalThis.browser ?? globalThis.chrome).runtime.getManifest()`);
        expect([...got.permissions].sort()).toEqual(['storage']);
        expect([...got.origins].sort()).toEqual(['http://*/*', 'https://*/*']);
        expect(got.data_collection ?? []).toEqual([]);
        // Firefox adds `has_previous_consent` (false on a fresh install) to what it reports
        expect(manifest.browser_specific_settings.gecko.data_collection_permissions).toMatchObject({
          required: ['none'],
          optional: ['websiteContent'],
          has_previous_consent: false,
        });
        facts = {
          ...got,
          manifest: manifest.browser_specific_settings.gecko.data_collection_permissions,
        };
      }
      console.log(browser, 'PERMISSION FACTS', JSON.stringify(facts));
      record(
        driver,
        'm13-prompts',
        `${browser} permissions as the browser reports them: ${JSON.stringify(facts)}`.slice(
          0,
          500,
        ),
        'PASS',
      );
    } finally {
      await driver.close();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
      } catch {
        // left for the OS temp cleanup
      }
    }
  });
}
