/**
 * M13: the loopback-only policy of the PACKED extensions, in real Chrome and Firefox. The endpoint parser, the
 * extension-page CSP and the transport must agree, so every address the settings page accepts is reachable
 * and every other is refused before a request leaves:
 *
 *   127.0.0.1 and localhost -> accepted, reached
 *   [::1]                   -> refused by the settings page (neither browser can express it in the CSP)
 *   a public URL, a LAN address, another scheme -> refused, 0 requests
 *   a redirect from the endpoint to another loopback server -> not followed, the second server sees nothing
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import type { Driver } from '../lib/driver';
import { startFirefox, type FirefoxDriver } from '../lib/driver';
import { startFixtureServer, type FixtureServer } from '../lib/server';
import { BROWSERS, SETTINGS_OFF, html, launch, record, until } from '../lib/scenario';
import { startMock, type Mock } from '../m12/ai-mock';
import { tabIdOf } from '../m12/kit';

const AREA = 'm13-loopback';
const PAGE = html(
  `<section aria-label="Region"><h2>Region</h2><button type="button"><canvas class="chart" aria-label="Series" width="300" height="150"></canvas></button></section>`,
);

const AI = (endpoint: string) => ({
  ...SETTINGS_OFF,
  enabled: true,
  semanticAIEnabled: true,
  semanticAIProvider: 'local-http',
  semanticAIEndpoint: endpoint,
  semanticAIModel: 'rw-mock',
});

for (const browser of BROWSERS) {
  test.describe(`M13 loopback policy ${browser}`, () => {
    test.describe.configure({ mode: 'serial' });
    let driver: Driver;
    let server: FixtureServer;
    const open: Array<{ close: () => Promise<void> | void }> = [];

    test.beforeAll(async () => {
      server = await startFixtureServer();
      server.serve('few', PAGE);
      driver =
        browser === 'firefox' ? await startFirefox({ systemAccess: true }) : await launch(browser);
    });
    test.afterAll(async () => {
      for (const c of open) await c.close();
      await driver?.close();
      await server?.close();
    });
    test.afterEach(async () => {
      await driver
        .extensionEval(
          `(async () => { const api = globalThis.browser ?? globalThis.chrome; const own = (await api.tabs.query({})).filter((x) => (x.url || '').endsWith('/few') || (x.url || '').includes('audit.html') || (x.url || '').includes('options.html')); for (const t of own) await api.tabs.remove(t.id).catch(() => null); })()`,
        )
        .catch(() => null);
    });

    /** Opens the audit of the fixture page and presses Run; on Firefox answers the native prompt with Allow when it shows. */
    async function review(): Promise<string> {
      const page = await driver.newTab();
      await page.open(`${server.origin}/few`);
      const tabId = await until(() => tabIdOf(driver, '/few').catch(() => null), 'the page tab');
      const audit = await driver.extensionTab(`audit.html?tabId=${tabId}`);
      await until(
        () => audit.evaluate<boolean>(`!!document.querySelector('[data-testid="summary-line"]')`),
        'audit summary',
        30_000,
      );
      await audit.clickButton('Run AI-assisted review');
      if (browser === 'firefox') await allowIfPrompted(driver as FirefoxDriver);
      return until(
        async () => {
          const c = await audit.evaluate<string | null>(
            `document.querySelector('[data-testid="assist-coverage"]')?.getAttribute('data-coverage') ?? null`,
          );
          return c !== null && c !== 'not-run' && c !== 'running' ? c : null;
        },
        'the review to finish',
        60_000,
      );
    }

    async function endpointField(
      text: string,
    ): Promise<{ invalid: string | null; stored: unknown }> {
      const options = await driver.extensionTab('options.html');
      await until(
        () => options.evaluate<boolean>(`!!document.getElementById('options-ai-endpoint')`),
        'the endpoint field',
      );
      await options.evaluate<boolean>(
        `(() => { const i = document.getElementById('options-ai-endpoint'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
      );
      await new Promise((r) => setTimeout(r, 600));
      const invalid = await options.evaluate<string | null>(
        `document.getElementById('options-ai-endpoint').getAttribute('aria-invalid')`,
      );
      const stored = ((await driver.getSettings()) as { semanticAIEndpoint?: string } | null)
        ?.semanticAIEndpoint;
      return { invalid, stored };
    }

    for (const host of ['127.0.0.1', 'localhost']) {
      test(`${host} is accepted and reached`, async () => {
        const mock: Mock = await startMock();
        open.push(mock);
        const endpoint = mock.endpoint.replace('127.0.0.1', host);
        await driver.setSettings(AI(endpoint));
        const coverage = await review();
        expect(['completed', 'partial']).toContain(coverage);
        expect(mock.seen.length).toBeGreaterThan(0);
        record(
          driver,
          AREA,
          `${host}: accepted and reached`,
          'PASS',
          `requests ${mock.seen.length}`,
        );
      });
    }

    for (const [name, text] of [
      ['the IPv6 loopback', 'http://[::1]:11999'],
      ['a public URL', 'https://example.com'],
      ['a LAN address', 'http://192.168.1.10:11434'],
      ['https on the loopback', 'https://127.0.0.1:11434'],
      ['a numeric spelling of the loopback', 'http://2130706433:11434'],
    ] as const) {
      test(`${name} is refused by the settings page and never saved`, async () => {
        const mock: Mock = await startMock();
        open.push(mock);
        await driver.setSettings(AI(mock.endpoint));
        const { invalid, stored } = await endpointField(text);
        expect(invalid).toBe('true');
        expect(stored).toBe(mock.endpoint);
        expect(mock.seen.length).toBe(0);
        record(driver, AREA, `${name}: refused, not saved`, 'PASS');
      });
    }

    test('a redirect from the endpoint to another loopback server is not followed', async () => {
      const target = await startMock();
      open.push(target);
      const bounce: Server = createServer((_q, r) => {
        r.writeHead(307, { location: `${target.endpoint}/v1/semantic` });
        r.end();
      });
      await new Promise<void>((ok) => bounce.listen(0, '127.0.0.1', ok));
      open.push({ close: () => new Promise<void>((ok) => bounce.close(() => ok())) });
      await driver.setSettings(AI(`http://127.0.0.1:${(bounce.address() as AddressInfo).port}`));
      const coverage = await review();
      expect(coverage).toBe('unavailable');
      expect(target.seen.length).toBe(0);
      record(driver, AREA, 'redirect to another loopback server: not followed', 'PASS');
    });
  });
}

/** Answers Firefox's native permission prompt with Allow, if one shows within a few seconds. */
async function allowIfPrompted(driver: FirefoxDriver): Promise<void> {
  const chrome = async <T>(script: string): Promise<T> => {
    await driver.wd('POST', '/moz/context', { context: 'chrome' });
    try {
      return (await driver.wd('POST', '/execute/sync', { script, args: [] })) as T;
    } finally {
      await driver.wd('POST', '/moz/context', { context: 'content' });
    }
  };
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const done = await chrome<boolean>(
      `const w = Services.wm.getMostRecentWindow('navigator:browser'); const n = w.PopupNotifications.getNotification('addon-webext-permissions'); if (!n) return false; n.mainAction.callback({}); return true;`,
    );
    if (done) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}
