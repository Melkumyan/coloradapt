/**
 * M13: the packed extensions produce no CSP (or manifest) warning of their own. M12 found Firefox complaining
 * about `http://[::1]:*`; the source is gone from the policy, and this keeps it gone, in the browsers' own words:
 *
 *   Firefox: the browser console (nsIConsoleService) after every extension page was opened
 *   Chrome:  developerPrivate's `manifestErrors` / `runtimeErrors` for the extension, as chrome://extensions shows them
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ROOT, startFirefox, type FirefoxDriver } from '../lib/driver';
import { BROWSERS, launch, record } from '../lib/scenario';

const WARNING = /content.security.policy|couldn.t parse|unrecognized|invalid source|manifest|CSP/i;

for (const browser of BROWSERS) {
  test(`${browser}: no CSP or manifest warning from ColorAdapt`, async () => {
    const driver =
      browser === 'firefox' ? await startFirefox({ systemAccess: true }) : await launch(browser);
    try {
      for (const page of ['popup.html', 'options.html', 'audit.html?tabId=1']) {
        const tab = await driver.extensionTab(page);
        await tab.evaluate<boolean>(`new Promise((r) => setTimeout(() => r(true), 400))`);
        await tab.close();
      }
      let messages: string[];
      if (browser === 'firefox') {
        const ff = driver as FirefoxDriver;
        await ff.wd('POST', '/moz/context', { context: 'chrome' });
        try {
          messages = (await ff.wd('POST', '/execute/sync', {
            script: `return Services.console.getMessageArray().map((m) => String(m.message || m)).filter((t) => /moz-extension|coloradapt|Content-Security-Policy|extension/i.test(t));`,
            args: [],
          })) as string[];
        } finally {
          await ff.wd('POST', '/moz/context', { context: 'content' });
        }
      } else {
        const tab = await driver.newTab();
        await tab.open('chrome://extensions/');
        messages = await tab.evaluate<string[]>(
          `new Promise((resolve) => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: false }, (all) => resolve(all.filter((e) => e.name === 'ColorAdapt').flatMap((e) => [...e.manifestErrors, ...e.runtimeErrors].map((x) => x.message)))))`,
        );
      }
      const own = messages.filter((m) => WARNING.test(m));
      console.log(
        `${browser}: ${messages.length} extension-related console messages, ${own.length} warnings`,
        own,
      );
      expect(own).toEqual([]);
      record(
        driver,
        'm13-csp',
        'no CSP/manifest warning from ColorAdapt',
        'PASS',
        `${messages.length} messages inspected`,
      );
    } finally {
      await driver.close();
    }
  });
}

// The detector must be able to see the warning it guards against: the M12 policy, with `[::1]`, is the control.
test('control: the detector sees the M12 policy with http://[::1]:* in Firefox', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ca-m12-csp-'));
  cpSync(path.join(ROOT, 'dist', 'firefox-mv2'), dir, { recursive: true });
  const file = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as { content_security_policy: string };
  manifest.content_security_policy += ' http://[::1]:*';
  writeFileSync(file, JSON.stringify(manifest));
  const driver = await startFirefox({ systemAccess: true, extensionDir: dir });
  try {
    await driver.wd('POST', '/moz/context', { context: 'chrome' });
    const messages = (await driver.wd('POST', '/execute/sync', {
      script: `return Services.console.getMessageArray().map((m) => String(m.message || m)).filter((t) => /Content-Security-Policy|moz-extension|coloradapt/i.test(t));`,
      args: [],
    })) as string[];
    await driver.wd('POST', '/moz/context', { context: 'content' });
    console.log(
      'control messages',
      messages.filter((m) => WARNING.test(m)),
    );
    expect(messages.filter((m) => WARNING.test(m)).length).toBeGreaterThan(0);
  } finally {
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
