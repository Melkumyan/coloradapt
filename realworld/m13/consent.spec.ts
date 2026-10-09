/**
 * M13 (docs/AI_PRIVACY.md, "Firefox consent"): the optional `websiteContent` data-collection consent, in real
 * Firefox, with Firefox's own native prompt answered through its privileged (chrome) context. Against a loopback
 * "runtime" that counts what reaches it:
 *
 *   fresh install  -> nothing granted, nothing sent
 *   Run, deny      -> the native prompt appeared, 0 provider requests, the audit still works
 *   Run, grant     -> the loopback is reached (and only it)
 *   revoke, Run    -> a new prompt; denied again -> no new request
 *   revoke while a request is in flight -> the run ends, no further request
 */
import { expect, test } from '@playwright/test';
import type { FirefoxDriver, Tab } from '../lib/driver';
import { startFirefox } from '../lib/driver';
import { startFixtureServer, type FixtureServer } from '../lib/server';
import { SETTINGS_OFF, html, record, until } from '../lib/scenario';
import { startMock, type Mock } from '../m12/ai-mock';
import { tabIdOf } from '../m12/kit';

const AREA = 'm13-consent';

const REGIONS = html(
  Array.from(
    { length: 3 },
    (_v, i) =>
      `<section aria-label="Region ${i}"><h2>Region ${i}</h2><button type="button" id="b${i}"><canvas id="c${i}" class="chart-${i}" aria-label="Series ${i}" width="300" height="150"></canvas></button></section>`,
  ).join(''),
);

type Answer = 'allow' | 'deny';

/** Runs a privileged script in the browser chrome, then returns to the content context. */
async function chromeEval<T>(driver: FirefoxDriver, script: string): Promise<T> {
  await driver.wd('POST', '/moz/context', { context: 'chrome' });
  try {
    return (await driver.wd('POST', '/execute/sync', { script, args: [] })) as T;
  } finally {
    await driver.wd('POST', '/moz/context', { context: 'content' });
  }
}

/** The notification ids currently shown by the browser window. */
const shown = (driver: FirefoxDriver): Promise<string[]> =>
  chromeEval<string[]>(
    driver,
    `const w = Services.wm.getMostRecentWindow('navigator:browser'); return (w.PopupNotifications._currentNotifications || []).map((n) => n.id);`,
  );

/** Answers the native permission prompt: the main action allows, the first secondary action denies. */
async function answer(driver: FirefoxDriver, choice: Answer): Promise<string> {
  const id = await until(
    async () => (await shown(driver)).find((n) => /webext|permission/i.test(n)) ?? null,
    'the native permission prompt',
    20_000,
  );
  await chromeEval(
    driver,
    `const w = Services.wm.getMostRecentWindow('navigator:browser'); const n = w.PopupNotifications.getNotification(${JSON.stringify(id)}); ${
      choice === 'allow'
        ? 'n.mainAction.callback({});'
        : 'const a = n.secondaryActions && n.secondaryActions[0]; if (a) a.callback({}); else w.PopupNotifications.remove(n);'
    } return true;`,
  );
  return id;
}

test.describe('M13 Firefox data-collection consent', () => {
  test.describe.configure({ mode: 'serial' });
  let driver: FirefoxDriver;
  let server: FixtureServer;
  let mock: Mock;

  test.beforeAll(async () => {
    server = await startFixtureServer();
    server.serve('few', REGIONS);
    mock = await startMock();
    driver = await startFirefox({ systemAccess: true });
    await driver.setSettings({
      ...SETTINGS_OFF,
      enabled: true,
      semanticAIEnabled: true,
      semanticAIProvider: 'local-http',
      semanticAIEndpoint: mock.endpoint,
      semanticAIModel: 'rw-mock',
    });
  });
  test.afterAll(async () => {
    await mock?.close();
    await driver?.close();
    await server?.close();
  });

  test.afterEach(async () => {
    await driver
      .extensionEval(
        `(async () => { const api = globalThis.browser ?? globalThis.chrome; const own = (await api.tabs.query({})).filter((x) => (x.url || '').endsWith('/few') || /few$/.test(x.url || '') || (x.url || '').includes('audit.html')); for (const t of own) await api.tabs.remove(t.id).catch(() => null); })()`,
      )
      .catch(() => null);
  });

  const granted = (): Promise<string[]> =>
    driver.extensionEval<string[]>(
      `(async () => (await (globalThis.browser ?? globalThis.chrome).permissions.getAll()).data_collection || [])()`,
    );

  async function openAudit(): Promise<Tab> {
    const page = await driver.newTab();
    await page.open(`${server.origin}/few`);
    const tabId = await until(() => tabIdOf(driver, '/few').catch(() => null), 'the page tab');
    const audit = await driver.extensionTab(`audit.html?tabId=${tabId}`);
    await until(
      () => audit.evaluate<boolean>(`!!document.querySelector('[data-testid="summary-line"]')`),
      'audit summary',
      30_000,
    );
    return audit;
  }
  const coverage = (audit: Tab): Promise<string | null> =>
    audit.evaluate<string | null>(
      `document.querySelector('[data-testid="assist-coverage"]')?.getAttribute('data-coverage') ?? null`,
    );
  const settled = (audit: Tab) =>
    until(
      async () => {
        const c = await coverage(audit);
        return c !== null && c !== 'not-run' && c !== 'running' ? c : null;
      },
      'the review to finish',
      60_000,
    );

  test('a fresh install has nothing granted, and sends nothing before any click', async () => {
    expect(await granted()).toEqual([]);
    const audit = await openAudit();
    expect(await coverage(audit)).toBe('not-run');
    expect(mock.seen.length).toBe(0);
    expect(await granted()).toEqual([]);
    record(driver, AREA, 'fresh install: websiteContent not granted, 0 provider requests', 'PASS');
  });

  test('Run, then Deny in the native prompt: 0 provider requests, the audit still works', async () => {
    const audit = await openAudit();
    await audit.clickButton('Run AI-assisted review');
    const id = await answer(driver, 'deny');
    const c = await settled(audit);
    const text = await audit.evaluate<string>(
      `document.querySelector('[data-testid="assist-panel"]')?.textContent ?? ''`,
    );
    expect(c).toBe('unavailable');
    expect(text).toContain('needs your permission');
    expect(mock.seen.length).toBe(0);
    expect(await granted()).toEqual([]);
    expect(
      await audit.evaluate<boolean>(`!!document.querySelector('[data-testid="summary-line"]')`),
    ).toBe(true);
    record(
      driver,
      AREA,
      'denied: 0 provider requests; manual review remains',
      'PASS',
      `prompt ${id}`,
    );
  });

  test('Run, then Allow: the loopback runtime is reached and websiteContent is granted', async () => {
    const audit = await openAudit();
    await audit.clickButton('Run AI-assisted review');
    await answer(driver, 'allow');
    const c = await settled(audit);
    expect(['completed', 'partial']).toContain(c);
    expect(mock.seen.length).toBeGreaterThan(0);
    expect(await granted()).toEqual(['websiteContent']);
    record(driver, AREA, 'granted: loopback reached', 'PASS', `requests ${mock.seen.length}`);
  });

  test('Revoked: the next Run asks again, and a denial sends nothing', async () => {
    await driver.extensionEval(
      `(async () => { await (globalThis.browser ?? globalThis.chrome).permissions.remove({ data_collection: ['websiteContent'] }); })()`,
    );
    expect(await granted()).toEqual([]);
    const before = mock.seen.length;
    const audit = await openAudit();
    await audit.clickButton('Run AI-assisted review');
    await answer(driver, 'deny');
    expect(await settled(audit)).toBe('unavailable');
    expect(mock.seen.length).toBe(before);
    record(driver, AREA, 'revoked then denied: no new provider request', 'PASS');
  });

  test('Granted again for the next check', async () => {
    const audit = await openAudit();
    await audit.clickButton('Run AI-assisted review');
    await answer(driver, 'allow');
    await settled(audit);
    expect(await granted()).toEqual(['websiteContent']);
  });

  test('Revoked while a request is in flight: the run ends and no further request is sent', async () => {
    mock.mode = 'hold';
    const before = mock.seen.length;
    const audit = await openAudit();
    await audit.clickButton('Run AI-assisted review');
    await until(() => (mock.seen.length > before ? true : null), 'a request held by the runtime');
    const sent = mock.seen.length;
    await driver.extensionEval(
      `(async () => { await (globalThis.browser ?? globalThis.chrome).permissions.remove({ data_collection: ['websiteContent'] }); })()`,
    );
    const c = await settled(audit);
    mock.release();
    await new Promise((r) => setTimeout(r, 1500));
    expect(c).toBe('unavailable');
    expect(mock.seen.length).toBe(sent);
    expect(await granted()).toEqual([]);
    mock.mode = 'ok';
    record(
      driver,
      AREA,
      'revoked in flight: run ends, 0 further requests',
      'PASS',
      `sent ${sent - before} before revoke`,
    );
  });
});
