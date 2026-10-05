/**
 * Extension lifecycle in the real browsers (Chrome 154 and Firefox, production builds): load, enable, disable,
 * reload, navigation, tab switching, several tabs, the popup, the developer audit (open, findings, real file
 * exports, highlight, focus, live updates), extension reload and browser restart.
 */
import { expect, test } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAuditReport } from '../src/core/audit';
import type { ChromeDriver } from './lib/driver';
import { startChrome, startFirefox, type Driver, type Tab } from './lib/driver';
import { startFixtureServer, type FixtureServer } from './lib/server';
import {
  BASIC,
  BROWSERS,
  SETTINGS_OFF,
  SETTINGS_ON,
  auditRun,
  colorOf,
  hasStylesheet,
  html,
  record,
  sleep,
  until,
} from './lib/scenario';

const AREA = 'runtime';

for (const browser of BROWSERS) {
  test.describe(`runtime ${browser}`, () => {
    test.describe.configure({ mode: 'serial' });
    let driver: Driver;
    let server: FixtureServer;
    let downloads: string;

    test.beforeAll(async () => {
      server = await startFixtureServer();
      server.serve('basic', BASIC);
      server.serve('basic2', BASIC.replace('fixture', 'fixture two'));
      server.serve('other', html('<p id="low" class="low">Another page, low contrast</p>'));
      downloads = mkdtempSync(path.join(tmpdir(), 'coloradapt-dl-'));
      if (browser === 'chrome') {
        driver = await startChrome();
        const session = await (driver as ChromeDriver).newBrowserSession();
        await session.send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: downloads,
        });
      } else {
        driver = await startFirefox({
          prefs: {
            'browser.download.folderList': 2,
            'browser.download.dir': downloads,
            'browser.download.useDownloadDir': true,
            'browser.helperApps.neverAsk.saveToDisk': 'application/json,text/html',
          },
        });
      }
      await driver.setSettings(SETTINGS_OFF);
    });

    test.afterAll(async () => {
      await driver?.close();
      await server?.close();
      rmSync(downloads, { recursive: true, force: true });
    });

    const tabIdOf = (url: string) =>
      driver.extensionEval<number>(
        `(async () => { const api = globalThis.browser ?? globalThis.chrome; const t = (await api.tabs.query({})).filter((x) => x.url === ${JSON.stringify(url)}); if (t.length !== 1) throw new Error('tabs: ' + t.length); return t[0].id; })()`,
      );

    test('extension is installed and its content script runs', async () => {
      const manifest = await driver.extensionEval<{
        name: string;
        version: string;
        manifest_version: number;
      }>(`(globalThis.browser ?? globalThis.chrome).runtime.getManifest()`);
      expect(manifest.name).toBe('ColorAdapt');
      expect(manifest.version).toBe('0.1.0');
      const tab = await driver.newTab();
      await tab.open(`${server.origin}/basic`);
      const diag = await until(
        () => tab.ext<{ state: string }>('GET_DYNAMIC_DIAGNOSTICS'),
        'content script answers',
      );
      expect(typeof diag.state).toBe('string');
      expect(await hasStylesheet(tab)).toBe(false); // protection is off: nothing injected
      record(
        driver,
        AREA,
        'install + content script executes',
        'PASS',
        `manifest v${manifest.manifest_version}`,
      );
      await tab.close();
    });

    test('enable adapts the page and disable restores it exactly', async () => {
      const tab = await driver.newTab();
      await tab.open(`${server.origin}/basic`);
      await until(() => tab.ext('GET_DYNAMIC_DIAGNOSTICS'), 'content script');
      const original = await colorOf(tab, '#cvd');
      await driver.setSettings(SETTINGS_ON);
      const plan = await tab.ext<{ changes: unknown[] }>('ENABLE_ADAPTATION');
      expect(plan.changes.length).toBeGreaterThan(0);
      expect(await hasStylesheet(tab)).toBe(true);
      const adapted = await colorOf(tab, '#cvd');
      expect(adapted).not.toBe(original);
      await tab.ext('DISABLE_ADAPTATION');
      expect(await hasStylesheet(tab)).toBe(false);
      expect(await colorOf(tab, '#cvd')).toBe(original);
      record(
        driver,
        AREA,
        'enable adapts, disable restores',
        'PASS',
        `${original} -> ${adapted} -> ${original}`,
      );
      await tab.close();
    });

    test('the setting survives reload and hard navigation; disabling stops it', async () => {
      await driver.setSettings(SETTINGS_ON);
      const tab = await driver.newTab();
      await tab.open(`${server.origin}/basic`);
      await until(() => hasStylesheet(tab), 'adaptation on load');
      await tab.reload();
      await until(() => hasStylesheet(tab), 'adaptation after reload');
      await tab.open(`${server.origin}/basic2`);
      await until(() => hasStylesheet(tab), 'adaptation after a hard navigation');
      await driver.setSettings(SETTINGS_OFF);
      await tab.reload();
      await until(() => tab.ext('GET_DYNAMIC_DIAGNOSTICS'), 'content script after reload');
      await sleep(500);
      expect(await hasStylesheet(tab)).toBe(false);
      record(
        driver,
        AREA,
        'enabled setting applies on reload and hard navigation; off stops it',
        'PASS',
      );
      await tab.close();
    });

    test('tab switching and several tabs adapt independently', async () => {
      await driver.setSettings(SETTINGS_ON);
      const tabs: Tab[] = [];
      for (let i = 1; i <= 3; i++) {
        const t = await driver.newTab();
        await t.open(`${server.origin}/basic?tab=${i}`);
        await until(() => t.ext('GET_DYNAMIC_DIAGNOSTICS'), `content script of tab ${i}`);
        tabs.push(t);
      }
      // protection is on in settings, so each tab adapts on its own load; switch between them and disable one
      for (const t of tabs) await until(() => hasStylesheet(t), 'adapted tab');
      await tabs[1]!.focus();
      await tabs[1]!.ext('DISABLE_ADAPTATION');
      await tabs[0]!.focus();
      expect(await hasStylesheet(tabs[0]!)).toBe(true);
      expect(await hasStylesheet(tabs[1]!)).toBe(false);
      expect(await hasStylesheet(tabs[2]!)).toBe(true);
      // closing a tab does not touch the others
      await tabs[0]!.close();
      expect(await hasStylesheet(tabs[2]!)).toBe(true);
      await tabs[2]!.ext('DISABLE_ADAPTATION');
      expect(await hasStylesheet(tabs[2]!)).toBe(false);
      await tabs[1]!.close();
      await tabs[2]!.close();
      await driver.setSettings(SETTINGS_OFF);
      record(driver, AREA, 'tab switch + 3 tabs independent', 'PASS');
    });

    test('the popup renders and its toggle persists the setting', async () => {
      const popup = await driver.extensionTab('popup.html');
      const label = () =>
        popup.evaluate<string>(`document.querySelector('.popup__toggle')?.textContent ?? ''`);
      await until(async () => (await label()) === 'OFF', 'popup shows OFF');
      await popup.evaluate(`document.querySelector('.popup__toggle').click()`);
      await until(async () => (await label()) === 'ON', 'popup shows ON');
      expect(((await driver.getSettings()) as { enabled: boolean }).enabled).toBe(true);
      await popup.evaluate(`document.querySelector('.popup__toggle').click()`);
      await until(async () => (await label()) === 'OFF', 'popup shows OFF again');
      expect(((await driver.getSettings()) as { enabled: boolean }).enabled).toBe(false);
      const logs = popup.drainLogs().filter((l) => !/favicon/i.test(l.text));
      record(
        driver,
        AREA,
        'popup opens and toggle persists',
        'PASS',
        logs.length ? `console: ${logs.map((l) => l.text).join(' | ')}` : 'no console errors',
      );
      await popup.close();
    });

    test('developer audit: opens, populates, exports real files, highlights, takes focus, updates live', async () => {
      const page = await driver.newTab();
      await page.open(`${server.origin}/basic`);
      await until(() => page.ext('GET_DYNAMIC_DIAGNOSTICS'), 'content script');
      const tabId = await tabIdOf(await page.url());
      const audit = await driver.extensionTab(`audit.html?tabId=${tabId}`);
      const summary = () =>
        audit.evaluate<string>(
          `document.querySelector('[data-testid="summary-line"]')?.textContent ?? ''`,
        );
      await until(async () => (await summary()) !== '', 'audit summary');
      const cards = () =>
        audit.evaluate<number>(`document.querySelectorAll('[data-testid="finding"]').length`);
      expect(await cards()).toBeGreaterThanOrEqual(2); // low contrast + color-vision conflict

      // exports: the page's own buttons, real downloads into a temp dir
      const press = (text: string) =>
        audit.evaluate(
          `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`,
        );
      // a download can be visible before it is complete: wait until each file is whole
      await press('Export JSON');
      const exported = await until(() => {
        const name = readdirSync(downloads).find((f) => f.endsWith('.json'));
        if (!name) return null;
        const parsed = parseAuditReport(readFileSync(path.join(downloads, name), 'utf8'));
        return parsed.ok ? { name, parsed } : null;
      }, 'a complete JSON export');
      await press('Export HTML report');
      const exportedHtml = await until(() => {
        const name = readdirSync(downloads).find((f) => f.endsWith('.html'));
        if (!name) return null;
        const text = readFileSync(path.join(downloads, name), 'utf8');
        return /<\/html>\s*$/i.test(text) ? { name, text } : null;
      }, 'a complete HTML export');
      const jsonFile = exported.name;
      const htmlFile = exportedHtml.name;
      expect(exportedHtml.text).not.toMatch(/<script/i);
      expect(jsonFile).not.toMatch(/[?#:*]/);

      // highlight: an element of the first finding is outlined on the audited page
      await audit.evaluate(
        `document.querySelector('[data-testid="finding"] .card__toggle').click()`,
      );
      await until(
        () =>
          audit.evaluate<boolean>(
            `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Show on page')`,
          ),
        'a Show on page button',
      );
      await audit.evaluate(
        `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Show on page').click()`,
      );
      await until(
        () =>
          page.evaluate<boolean>(
            `document.querySelector('[data-coloradapt-audit-overlay]') !== null`,
          ),
        'highlight overlay on the page',
      );
      // focus: the page's own focus was not stolen and the audit page's controls are keyboard reachable
      expect(
        await page.evaluate<string>(
          `document.activeElement ? document.activeElement.localName : ''`,
        ),
      ).toBe('body');
      await audit.press('Tab');
      expect(await audit.evaluate<string>(`document.activeElement.localName`)).not.toBe('body');

      // live update: new content on the page changes the audit without a reload
      const before = await audit.evaluate<string>(
        `document.querySelector('[data-testid="summary-line"]').textContent`,
      );
      await page.evaluate(
        `document.body.insertAdjacentHTML('beforeend', '<p id="late" style="color:#bbbbbb;background:#ffffff">Added later, low contrast</p>')`,
      );
      await until(
        async () =>
          (await audit.evaluate<string>(
            `document.querySelector('[data-testid="summary-line"]').textContent`,
          )) !== before,
        'audit refreshes after a dynamic update',
      );

      // closing the audit page ends the session: the highlight goes
      await audit.close();
      await until(
        () =>
          page.evaluate<boolean>(
            `document.querySelector('[data-coloradapt-audit-overlay]') === null`,
          ),
        'highlight removed when the audit page closes',
      );
      const snapshot = await auditRun(page);
      expect(snapshot.findings.length).toBeGreaterThanOrEqual(3);
      record(
        driver,
        AREA,
        'developer audit: open, findings, export JSON+HTML (real downloads), highlight, focus, dynamic update, close',
        'PASS',
        `files ${jsonFile}, ${htmlFile}`,
      );
      await page.close();
    });

    test('extension reload: new pages work, the orphaned page stays usable', async () => {
      await driver.setSettings(SETTINGS_ON);
      const old = await driver.newTab();
      await old.open(`${server.origin}/basic?old=1`);
      await until(() => hasStylesheet(old), 'adapted before reload');
      await driver.reloadExtension();
      // the page that was open keeps working as a page (its adaptation may stay or go, but it must not break)
      expect(await old.evaluate<string>(`document.getElementById('fine').textContent`)).toContain(
        'readable',
      );
      const fresh = await driver.newTab();
      await fresh.open(`${server.origin}/basic?fresh=1`);
      await until(() => hasStylesheet(fresh), 'adaptation after extension reload');
      const orphanStillStyled = await hasStylesheet(old);
      record(
        driver,
        AREA,
        'extension reload',
        'PASS',
        `orphaned page keeps its stylesheet: ${orphanStillStyled}`,
      );
      await old.close();
      await fresh.close();
      await driver.setSettings(SETTINGS_OFF);
    });
  });
}

test.describe('browser restart', () => {
  test.describe.configure({ mode: 'serial' });

  test('chrome: settings persist across a browser restart (the unpacked extension is loaded again)', async () => {
    test.skip(!BROWSERS.includes('chrome'));
    const first = await startChrome({ keepProfile: true });
    const profile = first.profileDir;
    await first.setSettings({ ...SETTINGS_ON, visionProfile: 'tritanopia' });
    await first.close();
    const second = await startChrome({ profileDir: profile });
    try {
      const stored = (await second.getSettings()) as { enabled: boolean; visionProfile: string };
      expect(stored.enabled).toBe(true);
      expect(stored.visionProfile).toBe('tritanopia');
      record(
        second,
        AREA,
        'browser restart: settings persist',
        'PASS',
        'same profile, extension re-loaded via DevTools',
      );
    } finally {
      await second.close();
      rmSync(profile, { recursive: true, force: true });
    }
  });
});

test.describe('firefox browser restart', () => {
  test.describe.configure({ mode: 'serial' });

  test('firefox: settings persist across a browser restart (the temporary add-on is installed again)', async () => {
    test.skip(!BROWSERS.includes('firefox'));
    const profile = mkdtempSync(path.join(tmpdir(), 'coloradapt-ff-'));
    const first = await startFirefox({ profileDir: profile });
    await first.setSettings({ ...SETTINGS_ON, visionProfile: 'tritanopia' });
    await first.close();
    await sleep(2000);
    const second = await startFirefox({ profileDir: profile });
    try {
      const stored = (await second.getSettings()) as
        { enabled: boolean; visionProfile: string } | undefined;
      expect(stored?.enabled).toBe(true);
      expect(stored?.visionProfile).toBe('tritanopia');
      record(
        second,
        AREA,
        'browser restart: settings persist',
        'PASS',
        'same profile, temporary add-on installed again',
      );
    } finally {
      await second.close();
      await sleep(1500);
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
