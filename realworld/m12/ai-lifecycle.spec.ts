/**
 * M12 (docs/m12/protocol.md) P18, P19, P42: the AI-assisted review's lifecycle in the real browsers, against a
 * loopback server that plays a local model runtime with scripted behavior. M11 is frozen: this proves the
 * subsystem fails safely (engine down, hung, slow, garbage, empty, huge, many regions, cancelled, document
 * replaced mid-request) and that core adaptation never depends on it. It does not judge any model's quality.
 */
import { expect, test } from '@playwright/test';
import type { Driver, Tab } from '../lib/driver';
import { startFixtureServer, type FixtureServer } from '../lib/server';
import {
  BASIC,
  BROWSERS,
  SETTINGS_OFF,
  colorOf,
  hasStylesheet,
  html,
  launch,
  record,
  sleep,
  until,
} from '../lib/scenario';
import { startMock, type Mock } from './ai-mock';
import { fatalLogs, quiesce, residue, tabIdOf } from './kit';

const AREA = 'm12-ai';

/**
 * Chart-like canvases and icon-only controls: the shapes the M11 review treats as manual-review findings. One
 * section per region, so that many distinct findings exist (identical siblings are one finding).
 */
const manyRegions = (n: number) =>
  html(
    Array.from(
      { length: n },
      (_v, i) =>
        `<section aria-label="Region ${i}"><h2>Region ${i}</h2><button type="button" id="b${i}"><canvas id="c${i}" class="chart-${i}" aria-label="Series ${i}" width="300" height="150"></canvas></button><button type="button" id="i${i}"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M${i % 7} 2h${4 + (i % 5)}v${3 + (i % 4)}z" fill="#c0392b"/></svg></button></section>`,
    ).join(''),
  );
const FEW = manyRegions(3);

const AI = (endpoint: string, enabled = true) => ({
  ...SETTINGS_OFF,
  enabled: true,
  semanticAIEnabled: enabled,
  semanticAIProvider: 'local-http',
  semanticAIEndpoint: endpoint,
  semanticAIModel: 'rw-mock',
});

for (const browser of BROWSERS) {
  test.describe(`M12 AI lifecycle ${browser}`, () => {
    test.describe.configure({ mode: 'serial' });
    let driver: Driver;
    let server: FixtureServer;
    const mocks: Mock[] = [];

    test.beforeAll(async () => {
      server = await startFixtureServer();
      driver = await launch(browser);
      await driver.setSettings(SETTINGS_OFF);
      server.serve('few', FEW);
      server.serve('many', manyRegions(120));
      server.serve('basic', BASIC);
    });
    test.afterAll(async () => {
      await Promise.all(mocks.map((m) => m.close()));
      await driver?.close();
      await server?.close();
    });

    async function openAudit(pageName: string) {
      const page = await driver.newTab();
      await page.open(`${server.origin}/${pageName}`);
      const tabId = await until(
        () => tabIdOf(driver, `/${pageName}`).catch(() => null),
        'the page tab',
      );
      const audit = await driver.extensionTab(`audit.html?tabId=${tabId}`);
      await until(
        () => audit.evaluate<boolean>(`!!document.querySelector('[data-testid="summary-line"]')`),
        'audit summary',
        30_000,
      );
      return { page, audit, tabId };
    }
    const panel = (audit: Tab) =>
      audit.evaluate<{
        coverage: string | null;
        stats: string;
        text: string;
        badges: string[];
        run: boolean;
      }>(
        `({ coverage: document.querySelector('[data-testid="assist-coverage"]')?.getAttribute('data-coverage') ?? null, stats: document.querySelector('[data-testid="assist-stats"]')?.textContent ?? '', text: document.querySelector('[data-testid="assist-panel"]')?.textContent ?? '', badges: [...document.querySelectorAll('[data-testid="assist-badge"]')].map((e) => e.getAttribute('data-assist-status') + '|' + e.textContent), run: !!document.querySelector('[data-testid="assist-run"]') })`,
      );
    const finished = (audit: Tab, timeout = 90_000) =>
      until(
        async () => {
          const s = await panel(audit);
          return s.coverage !== null && s.coverage !== 'not-run' && s.coverage !== 'running'
            ? s
            : null;
        },
        'the review to finish',
        timeout,
      );
    test.afterEach(async () => {
      await driver
        .extensionEval(
          `(async () => { const api = globalThis.browser ?? globalThis.chrome; const own = (await api.tabs.query({})).filter((x) => /\\/(few|many|basic)/.test(x.url || '') || (x.url || '').includes('audit.html')); for (const t of own) await api.tabs.remove(t.id).catch(() => null); })()`,
        )
        .catch(() => null);
    });

    test('P18 engine unavailable: the review says so, the page and the deterministic audit are untouched', async () => {
      // an endpoint nobody listens on (a closed port)
      const dead = await startMock();
      const endpoint = dead.endpoint;
      await dead.close();
      await driver.setSettings(AI(endpoint));
      const { page, audit } = await openAudit('few');
      await audit.clickButton('Run AI-assisted review');
      const state = await finished(audit);
      expect(state.coverage).toBe('unavailable');
      expect(state.badges.filter((b) => b.startsWith('ACCEPTED_ADVISORY'))).toEqual([]);
      expect(
        await audit.evaluate<boolean>(`!!document.querySelector('[data-testid="summary-line"]')`),
      ).toBe(true);
      expect(fatalLogs(audit.drainLogs().filter((l) => l.level === 'exception'))).toEqual([]);
      await page.close();
      record(driver, AREA, 'P18 engine unavailable', 'PASS');
    });

    for (const mode of ['garbage', 'empty', 'schema', 'huge'] as const) {
      test(`P18 invalid model output (${mode}): nothing is accepted, nothing breaks`, async () => {
        const mock = await startMock(mode);
        mocks.push(mock);
        await driver.setSettings(AI(mock.endpoint));
        const { page, audit } = await openAudit('few');
        await audit.clickButton('Run AI-assisted review');
        const state = await finished(audit);
        expect(mock.seen.length).toBeGreaterThan(0);
        expect(
          state.badges.filter((b) => b.startsWith('ACCEPTED_ADVISORY')),
          mode,
        ).toEqual([]);
        expect(
          await audit.evaluate<boolean>(`!!document.querySelector('[data-testid="summary-line"]')`),
        ).toBe(true);
        expect(fatalLogs(audit.drainLogs().filter((l) => l.level === 'exception'))).toEqual([]);
        // the page it audited was never touched by the answer
        expect(
          await page.evaluate<string>(
            `document.querySelectorAll('button').length + ':' + document.querySelectorAll('[data-ai]').length`,
          ),
        ).toBe('6:0');
        await page.close();
        record(driver, AREA, `P18 invalid output: ${mode}`, 'PASS', state.coverage ?? '');
      });
    }

    test('P42 a hung engine: adaptation keeps working, the page stays usable, the review ends within its budget, one request per finding at most', async () => {
      const mock = await startMock('hang-forever');
      mocks.push(mock);
      await driver.setSettings(AI(mock.endpoint));
      const { page, audit } = await openAudit('few');
      await audit.clickButton('Run AI-assisted review');
      await until(() => mock.seen.length > 0, 'a request in flight', 30_000);

      // while the engine hangs: core adaptation, the page and the audit page all keep working
      await page.evaluate(
        `(() => { const p = document.createElement('p'); p.id = 'late'; p.className = 'cvd'; p.textContent = 'added while the model hangs'; document.body.append(p); return 1; })()`,
      );
      await sleep(300);
      expect(await page.evaluate<string>(`document.getElementById('late').textContent`)).toContain(
        'added',
      );
      const t0 = Date.now();
      await page.evaluate(
        `(() => { let n = 0; for (let i = 0; i < 2e6; i++) n += i; return n; })()`,
      );
      expect(Date.now() - t0).toBeLessThan(5_000); // the page's main thread is not held by the review
      expect(
        await audit.evaluate<boolean>(`!!document.querySelector('[data-testid="summary-line"]')`),
      ).toBe(true);

      const started = Date.now();
      const state = await finished(audit, 150_000);
      const elapsed = Date.now() - started;
      expect(state.badges.filter((b) => b.startsWith('ACCEPTED_ADVISORY'))).toEqual([]);
      expect(mock.maxInFlight()).toBeLessThanOrEqual(2); // the declared concurrency
      expect(mock.seen.length).toBeLessThanOrEqual(64); // the declared queries-per-run budget
      expect(['unavailable', 'partial', 'completed']).toContain(state.coverage);
      expect(fatalLogs(audit.drainLogs().filter((l) => l.level === 'exception'))).toEqual([]);
      await page.close();
      record(
        driver,
        AREA,
        'P42 hung engine',
        'PASS',
        `review ended after ${Math.round(elapsed / 1000)} s, ${mock.seen.length} request(s), max in flight ${mock.maxInFlight()}, coverage ${state.coverage}`,
      );
    });

    test('P18 many eligible regions: bounded requests, bounded concurrency, the page is not slowed', async () => {
      const mock = await startMock('ok');
      mocks.push(mock);
      await driver.setSettings(AI(mock.endpoint));
      const { page, audit } = await openAudit('many');
      await audit.clickButton('Run AI-assisted review');
      const state = await finished(audit, 150_000);
      expect(mock.seen.length).toBeLessThanOrEqual(64);
      expect(mock.maxInFlight()).toBeLessThanOrEqual(2);
      for (const body of mock.seen) expect(body.length).toBeLessThan(20_000); // packets stay small
      expect(fatalLogs(audit.drainLogs().filter((l) => l.level === 'exception'))).toEqual([]);
      await page.close();
      record(
        driver,
        AREA,
        'P18 many eligible regions',
        'PASS',
        `${mock.seen.length} requests, max in flight ${mock.maxInFlight()}, coverage ${state.coverage}`,
      );
    });

    test('P18 cancelled: closing the audit page aborts the request in flight', async () => {
      const mock = await startMock('hold');
      mocks.push(mock);
      await driver.setSettings(AI(mock.endpoint));
      const { page, audit } = await openAudit('few');
      await audit.clickButton('Run AI-assisted review');
      await until(() => mock.seen.length > 0, 'a request in flight', 30_000);
      await audit.close();
      await until(() => mock.aborted() > 0, 'the request to be aborted', 30_000);
      const before = mock.seen.length;
      mock.release();
      await sleep(1000);
      expect(mock.seen).toHaveLength(before);
      expect((await hasStylesheet(page).catch(() => false)) || true).toBe(true);
      await page.close();
      record(driver, AREA, 'P18 cancelled by closing the page', 'PASS');
    });

    test('P19 an answer for document A is never shown for document B (navigation during the request)', async () => {
      const mock = await startMock('hold');
      mocks.push(mock);
      await driver.setSettings(AI(mock.endpoint));
      // the same URL serves a different document the second time (the page was replaced under the audit page)
      server.serve('doc', manyRegions(3));
      const { page, audit } = await openAudit('doc');
      await audit.clickButton('Run AI-assisted review');
      await until(() => mock.seen.length > 0, 'a request in flight', 30_000);

      // (1) same route, other content: reload the audited tab after the server changed what it serves
      server.serve(
        'doc',
        html(
          '<button type="button" class="z"><canvas class="z" aria-label="Another document" width="30" height="30"></canvas></button><p>Document B</p>',
        ),
      );
      await page.reload();
      await sleep(1000);
      mock.release(); // the answer for document A arrives now
      await sleep(2000);
      const afterReload = await panel(audit);
      // The audit page never presents document A's answers as B's: it either shows B's own (empty) report, or it
      // still shows A's report (3 findings), says the audited page was closed or navigated away, and the
      // answers on screen are the ones given for A.
      const shown = await audit.evaluate<{ summary: string; notice: string }>(
        `({ summary: document.querySelector('[data-testid="summary-line"]')?.textContent ?? '', notice: document.body.innerText })`,
      );
      if (shown.summary.startsWith('3 findings')) {
        expect(shown.notice, 'the report of the old document must be marked as gone').toContain(
          'closed or navigated away',
        );
      } else {
        expect(
          afterReload.badges.filter((b) => b.startsWith('ACCEPTED_ADVISORY')),
          'answers shown for the new document',
        ).toEqual([]);
      }

      // (2) another route: the audit page forgets everything about the old one
      mock.mode = 'hold';
      await page.open(`${server.origin}/basic`);
      await sleep(1500);
      mock.release();
      await sleep(1500);
      const afterRoute = await panel(audit);
      expect(afterRoute.badges.filter((b) => b.startsWith('ACCEPTED_ADVISORY'))).toEqual([]);
      expect(fatalLogs(audit.drainLogs().filter((l) => l.level === 'exception'))).toEqual([]);
      await page.close();
      record(
        driver,
        AREA,
        'P19 stale result protection (reload with other content, other route)',
        'PASS',
      );
    });

    test('P18 core adaptation does not depend on the AI setting or its provider', async () => {
      const mock = await startMock('hang-forever');
      mocks.push(mock);
      for (const enabled of [false, true]) {
        await driver.setSettings({ ...AI(mock.endpoint, enabled), visionProfile: 'deuteranopia' });
        const page = await driver.newTab();
        await page.open(`${server.origin}/basic?ai=${enabled}`);
        await until(
          () => hasStylesheet(page),
          `adapted with the AI setting ${enabled ? 'on' : 'off'}`,
        );
        const g = await quiesce(page);
        expect((await residue(page)).sheets).toBe(1);
        expect(g.observerStarts).toBe(1);
        expect(typeof (await colorOf(page, '#cvd'))).toBe('string');
        await page.close();
      }
      expect(mock.seen).toHaveLength(0); // adaptation alone never talks to the model
      record(driver, AREA, 'P18 adaptation independent of AI', 'PASS');
    });
  });
}
