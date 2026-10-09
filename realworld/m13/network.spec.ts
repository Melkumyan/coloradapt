/**
 * M13: what the packed extension puts on the network, in real Chrome and Firefox, from a fresh install of the release
 * archive. The browsers' own traffic (updates, safe browsing, telemetry) is excluded by attribution, not by hope:
 *
 *   Chrome:  every request of every page of the browser context (the fixture page, popup, options, audit pages);
 *            the extension has no other network-capable surface (the service worker contains no network primitive,
 *            checked by `release:validate`).
 *   Firefox: an `http-on-modify-request` observer in the privileged context records each channel with the principal that
 *            triggered it; requests triggered by the extension's own principal (moz-extension://, or an expanded
 *            principal that includes it, which is a content script) are the ones counted.
 *
 * Normal mode: 0 requests from ColorAdapt to anything but the fixture page itself. AI mode (Firefox: after allowing
 * the native prompt): requests only to the configured loopback runtime.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  ROOT,
  startChrome,
  startFirefox,
  type ChromeDriver,
  type FirefoxDriver,
} from '../lib/driver';
import { startFixtureServer } from '../lib/server';
import { BASIC, BROWSERS, SETTINGS_OFF, hasStylesheet, record, until } from '../lib/scenario';
import { startMock } from '../m12/ai-mock';
import { quiesce, tabIdOf } from '../m12/kit';
// @ts-expect-error plain .mjs helper shared with the release scripts
import { readZip } from '../../scripts/release/lib.mjs';

const VERSION = (
  JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }
).version;
const FIXTURE_DIR = path.join(ROOT, 'docs', 'store', 'reviewer-fixture');

function extract(browser: 'chrome' | 'firefox'): string {
  const zip = path.join(ROOT, 'release', 'm13', browser, `coloradapt-${browser}-${VERSION}.zip`);
  const dir = mkdtempSync(path.join(tmpdir(), `coloradapt-net-${browser}-`));
  for (const [name, data] of readZip(readFileSync(zip)) as Map<string, Buffer>) {
    const file = path.join(dir, ...name.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
  return dir;
}

const INTERNAL = /^(data:|blob:|about:|chrome-extension:|moz-extension:)/;

for (const browser of BROWSERS) {
  test(`${browser}: the release archive makes no request of its own in normal mode, and only loopback in AI mode`, async () => {
    test.setTimeout(240_000);
    const dir = extract(browser);
    const server = await startFixtureServer();
    server.serve('basic', BASIC);
    server.serve('sample', readFileSync(path.join(FIXTURE_DIR, 'index.html'), 'utf8'));
    server.serve('chart.html', readFileSync(path.join(FIXTURE_DIR, 'chart.html'), 'utf8'));
    const mock = await startMock();
    const driver =
      browser === 'chrome'
        ? await startChrome({ extensionDir: dir })
        : await startFirefox({ extensionDir: dir, systemAccess: true });
    const seen: Array<{ url: string; frame: string }> = [];
    let controlHosts = new Set<string>();
    let aiMode = false;
    try {
      if (browser === 'chrome') {
        // the same pages in a browser without the extension: what the host machine's own software (antivirus
        // injection, browser services) contacts anyway
        const control = await startChrome({ extension: false });
        try {
          const hosts = new Set<string>();
          control.browserContext.on('request', (r) => hosts.add(new URL(r.url()).host));
          for (const name of ['basic', 'sample', 'chart.html']) {
            const tab = await control.newTab();
            await tab.open(`${server.origin}/${name}`);
          }
          await new Promise((r) => setTimeout(r, 2500));
          controlHosts = hosts;
        } finally {
          await control.close();
        }
        (driver as ChromeDriver).browserContext.on('request', (r) => {
          let frame = '';
          try {
            frame = r.frame().url();
          } catch {
            frame = 'worker';
          }
          seen.push({ url: r.url(), frame });
        });
      } else {
        const ff = driver as FirefoxDriver;
        await ff.wd('POST', '/moz/context', { context: 'chrome' });
        await ff.wd('POST', '/execute/sync', {
          script: `const log = []; Services.wm.getMostRecentWindow('navigator:browser').__caNet = log;
            Services.obs.addObserver({ observe(subject) { try { const ch = subject.QueryInterface(Ci.nsIChannel); const p = ch.loadInfo && ch.loadInfo.triggeringPrincipal; log.push({ url: ch.URI.spec, trigger: p ? p.originNoSuffix + '|' + (p.isExpandedPrincipal ? 'expanded:' + p.allowlist.map((x) => x.originNoSuffix).join(',') : '') : '' }); } catch (e) {} } }, 'http-on-modify-request');
            return true;`,
          args: [],
        });
        await ff.wd('POST', '/moz/context', { context: 'content' });
      }
      const open = async (name: string) => {
        const tab = await driver.newTab();
        await tab.open(`${server.origin}/${name}`);
        return tab;
      };
      const visit = async (): Promise<void> => {
        await driver.setSettings({
          ...SETTINGS_OFF,
          enabled: true,
          visionProfile: 'deuteranopia',
          adaptationStrength: 1,
        });
        for (const name of ['basic', 'sample', 'chart.html']) {
          const tab = await open(name);
          await until(() => hasStylesheet(tab), 'the stylesheet', 30_000);
          await quiesce(tab);
        }
        for (const page of ['popup.html', 'options.html'])
          await (
            await driver.extensionTab(page)
          ).evaluate<boolean>(`new Promise((r) => setTimeout(() => r(true), 600))`);
        const tabId = await until(
          () => tabIdOf(driver, '/sample').catch(() => null),
          'the page tab',
        );
        const audit = await driver.extensionTab(`audit.html?tabId=${tabId}`);
        await until(
          () => audit.evaluate<boolean>(`!!document.querySelector('[data-testid="summary-line"]')`),
          'audit summary',
          30_000,
        );
      };
      await visit();
      await new Promise((r) => setTimeout(r, 1500));

      const firefoxLog = async (): Promise<Array<{ url: string; trigger: string }>> => {
        const ff = driver as FirefoxDriver;
        await ff.wd('POST', '/moz/context', { context: 'chrome' });
        try {
          return (await ff.wd('POST', '/execute/sync', {
            script: `return Services.wm.getMostRecentWindow('navigator:browser').__caNet;`,
            args: [],
          })) as Array<{ url: string; trigger: string }>;
        } finally {
          await ff.wd('POST', '/moz/context', { context: 'content' });
        }
      };
      const ours = async (): Promise<string[]> => {
        const allowed = (u: string): boolean =>
          INTERNAL.test(u) ||
          u.startsWith(server.origin) ||
          u.startsWith(server.altOrigin) ||
          (aiMode && u.startsWith(mock.endpoint));
        if (browser === 'chrome') {
          // an extension page or worker may reach nothing but what is allowed; a web page's requests (the content
          // script runs inside it) may reach only hosts the same pages reach without the extension
          return seen
            .filter(({ url, frame }) => {
              if (allowed(url)) return false;
              if (/^(chrome-extension:|worker)/.test(frame)) return true;
              return !controlHosts.has(new URL(url).host);
            })
            .map(({ url }) => url);
        }
        const log = await firefoxLog();
        // requests triggered by the extension: its own principal, or a content script (an expanded principal naming it)
        return log
          .filter((e) => /moz-extension:\/\//.test(e.trigger) && !allowed(e.url))
          .map((e) => e.url);
      };
      const normalOutside = await ours();
      const total = browser === 'chrome' ? seen.length : (await firefoxLog()).length;
      expect(mock.seen.length).toBe(0);
      expect(normalOutside).toEqual([]);
      record(
        driver,
        'm13-network',
        'normal mode: 0 requests by ColorAdapt to anything but local pages',
        'PASS',
        `${total} requests observed in all (fixture, extension pages)`,
      );

      // AI mode: only the configured loopback runtime may be contacted by the extension
      aiMode = true;
      await driver.setSettings({
        ...SETTINGS_OFF,
        enabled: true,
        semanticAIEnabled: true,
        semanticAIProvider: 'local-http',
        semanticAIEndpoint: mock.endpoint,
        semanticAIModel: 'rw-mock',
      });
      await driver.extensionEval(
        `(async () => { const api = globalThis.browser ?? globalThis.chrome; for (const t of await api.tabs.query({})) { const u = t.url || ''; if (u.includes('/sample') || u.includes('/basic') || u.includes('chart.html') || u.includes('audit.html') || u.includes('options.html')) await api.tabs.remove(t.id).catch(() => null); } })()`,
      );
      const before = mock.seen.length;
      await open('sample');
      const tabId = await until(() => tabIdOf(driver, '/sample').catch(() => null), 'the page tab');
      const audit = await driver.extensionTab(`audit.html?tabId=${tabId}`);
      await until(
        () => audit.evaluate<boolean>(`!!document.querySelector('[data-testid="assist-run"]')`),
        'the run button',
        30_000,
      );
      await audit.clickButton('Run AI-assisted review');
      if (browser === 'firefox') {
        const ff = driver as FirefoxDriver;
        await until(
          async () => {
            await ff.wd('POST', '/moz/context', { context: 'chrome' });
            try {
              return (await ff.wd('POST', '/execute/sync', {
                script: `const w = Services.wm.getMostRecentWindow('navigator:browser'); const n = w.PopupNotifications.getNotification('addon-webext-permissions'); if (!n) return false; n.mainAction.callback({}); return true;`,
                args: [],
              })) as boolean;
            } finally {
              await ff.wd('POST', '/moz/context', { context: 'content' });
            }
          },
          'the native permission prompt',
          20_000,
        );
      }
      await until(
        async () => {
          const c = await audit.evaluate<string | null>(
            `document.querySelector('[data-testid="assist-coverage"]')?.getAttribute('data-coverage') ?? null`,
          );
          return c !== null && c !== 'not-run' && c !== 'running' ? c : null;
        },
        'the review to finish',
        60_000,
      );
      expect(mock.seen.length).toBeGreaterThan(before);
      // the attribution works: the runtime request is seen, and seen as the extension's
      const attributed =
        browser === 'chrome'
          ? seen.some(
              ({ url, frame }) =>
                url.startsWith(mock.endpoint) && frame.startsWith('chrome-extension://'),
            )
          : (await firefoxLog()).some(
              (e) => e.url.startsWith(mock.endpoint) && /moz-extension:\/\//.test(e.trigger),
            );
      expect(attributed).toBe(true);
      const outside = await ours();
      expect(outside).toEqual([]);
      record(
        driver,
        'm13-network',
        'AI mode: the only extension traffic is to the configured loopback runtime',
        'PASS',
        `runtime requests ${mock.seen.length - before}`,
      );
    } finally {
      await mock.close();
      await driver.close();
      await server.close();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
      } catch {
        // left for the OS temp cleanup
      }
    }
  });
}
