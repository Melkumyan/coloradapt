/**
 * M11.R1: the AI-assisted review's provider path in both real browsers (Chrome 154 and Firefox, production
 * builds), against a real loopback server that plays a local model runtime. The model is scripted: this proves
 * the transport and the guarantees (what is sent, where, when, what is shown), not any model's quality.
 *
 * Per browser: the setting off sends nothing; with it on a packet arrives at the loopback, the answer is parsed
 * and validated and shown as an advisory block; a redirect to another loopback server is never followed; a
 * stored remote endpoint is never used; turning the setting off aborts a request in flight; the deterministic
 * audit is unaffected by an absent runtime. The sanitized packet of the same fixture is compared across browsers.
 *
 * Run after `pnpm build` and `pnpm build:firefox`: `RW_BROWSERS=firefox playwright test -c playwright.realworld.config.ts realworld/ai-provider.spec.ts`.
 */
import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Driver } from './lib/driver';
import { ROOT } from './lib/driver';
import { startFixtureServer, type FixtureServer } from './lib/server';
import { BROWSERS, SETTINGS_OFF, html, launch, record, until } from './lib/scenario';

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

interface Mock {
  readonly endpoint: string;
  readonly seen: Seen[];
  readonly aborted: () => number;
  release(): void;
  close(): Promise<void>;
}

type Query = {
  allowedLabels: string[];
  deterministicEvidence: { id: string; supports: string[] }[];
};

/** A loopback "runtime". `hold` keeps requests open until `release()`; `redirectTo` answers every request with a 302. */
async function startMock(options: { hold?: boolean; redirectTo?: string } = {}): Promise<Mock> {
  const seen: Seen[] = [];
  const held: (() => void)[] = [];
  let aborted = 0;
  const http: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('close', () => {
      if (!res.writableEnded) aborted += 1;
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers, body });
      if (options.redirectTo) {
        res.writeHead(302, { location: options.redirectTo });
        res.end();
        return;
      }
      const respond = (): void => {
        const parsed = JSON.parse(body || '{}') as { payload?: string };
        const query = JSON.parse(parsed.payload ?? '{}') as Query;
        const label = query.allowedLabels?.find((l) =>
          query.deterministicEvidence?.some((e) => e.supports.includes(l)),
        );
        const refs = (query.deterministicEvidence ?? [])
          .filter((e) => label && e.supports.includes(label))
          .map((e) => e.id);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'rw-mock',
            hypothesis: label
              ? {
                  schemaVersion: 1,
                  outcome: 'SUPPORTED_HYPOTHESIS',
                  label,
                  confidence: 0.9,
                  evidenceRefs: refs,
                }
              : {
                  schemaVersion: 1,
                  outcome: 'INSUFFICIENT_CONTEXT',
                  label: 'unknown',
                  confidence: 0.2,
                  evidenceRefs: [],
                },
          }),
        );
      };
      if (options.hold) held.push(respond);
      else respond();
    });
  });
  await new Promise<void>((ok) => http.listen(0, '127.0.0.1', ok));
  const port = (http.address() as AddressInfo).port;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    seen,
    aborted: () => aborted,
    release: () => held.splice(0).forEach((run) => run()),
    close: () =>
      new Promise<void>((done) => {
        http.closeAllConnections();
        http.close(() => done());
      }),
  };
}

const PAGE = html(`
  <button id="b" type="button"><canvas id="c" class="sales-chart" aria-label="Sales by region" width="300" height="150"></canvas></button>
  <p><input id="pw" type="password" aria-label="Password" value="hunter2-AI-SECRET"></p>
  <p id="note">Contact jane.private@example.com</p>
  <script>document.cookie = 'sid=SECRET-AI-COOKIE; path=/';</script>`);

const SECRETS = ['hunter2-AI-SECRET', 'jane.private', 'SECRET-AI-COOKIE'];
const AI = (endpoint: string, enabled = true) => ({
  ...SETTINGS_OFF,
  semanticAIEnabled: enabled,
  semanticAIProvider: 'local-http',
  semanticAIEndpoint: endpoint,
  semanticAIModel: 'rw-mock',
});

const PAYLOADS: Partial<Record<string, string>> = {};
const OUT = path.join(ROOT, 'realworld', '.artifacts');

for (const browser of BROWSERS) {
  test.describe(`AI provider ${browser}`, () => {
    test.describe.configure({ mode: 'serial' });
    let driver: Driver;
    let server: FixtureServer;
    const mocks: Mock[] = [];

    test.beforeAll(async () => {
      server = await startFixtureServer();
      driver = await launch(browser);
      await driver.setSettings(SETTINGS_OFF);
      server.serve('ai', PAGE);
    });
    test.afterAll(async () => {
      await Promise.all(mocks.map((m) => m.close()));
      await driver?.close();
      await server?.close();
    });

    const tabIdByUrl = (fragment: string) =>
      driver.extensionEval<number>(
        `(async () => { const api = globalThis.browser ?? globalThis.chrome; const t = (await api.tabs.query({})).filter((x) => (x.url || '').includes(${JSON.stringify(fragment)})); if (t.length !== 1) throw new Error('tabs: ' + t.length); return t[0].id; })()`,
      );

    async function openAudit() {
      const page = await driver.newTab();
      await page.open(`${server.origin}/ai`);
      const tabId = await until(() => tabIdByUrl('/ai').catch(() => null), 'the page tab');
      const audit = await driver.extensionTab(`audit.html?tabId=${tabId}`);
      await until(
        () => audit.evaluate<boolean>(`!!document.querySelector('[data-testid="summary-line"]')`),
        'audit summary',
        30_000,
      );
      return { page, audit };
    }

    const panel = (audit: Awaited<ReturnType<typeof openAudit>>['audit']) =>
      audit.evaluate<{
        coverage: string | null;
        stats: string;
        text: string;
        badges: string[];
        run: boolean;
      }>(
        `({ coverage: document.querySelector('[data-testid="assist-coverage"]')?.getAttribute('data-coverage') ?? null, stats: document.querySelector('[data-testid="assist-stats"]')?.textContent ?? '', text: document.querySelector('[data-testid="assist-panel"]')?.textContent ?? '', badges: [...document.querySelectorAll('[data-testid="assist-badge"]')].map((e) => e.getAttribute('data-assist-status') + '|' + e.textContent), run: !!document.querySelector('[data-testid="assist-run"]') })`,
      );

    async function closeTabs() {
      // Every test starts from one helper tab: leave the extension's own helper alone.
      await driver
        .extensionEval(
          `(async () => { const api = globalThis.browser ?? globalThis.chrome; const own = (await api.tabs.query({})).filter((x) => (x.url || '').includes('/ai') || (x.url || '').includes('audit.html')); for (const t of own) await api.tabs.remove(t.id).catch(() => null); })()`,
        )
        .catch(() => null);
    }
    test.afterEach(closeTabs);

    test('setting off (the default): the panel says so and no request is ever made', async () => {
      const mock = await startMock();
      mocks.push(mock);
      await driver.setSettings(AI(mock.endpoint, false));
      const { audit } = await openAudit();
      const state = await panel(audit);
      expect(state.coverage).toBe('disabled');
      expect(state.run).toBe(false);
      await new Promise((r) => setTimeout(r, 1500));
      expect(mock.seen).toHaveLength(0);
      record(
        driver,
        'ai-provider',
        'setting off: zero requests, panel says "AI assist off"',
        'PASS',
      );
    });

    test('setting on: a sanitized packet reaches the loopback, the answer is validated and shown as advisory', async () => {
      const mock = await startMock();
      mocks.push(mock);
      await driver.setSettings(AI(mock.endpoint));
      const { audit } = await openAudit();
      expect((await panel(audit)).coverage).toBe('not-run');
      expect(mock.seen).toHaveLength(0);
      await audit.clickButton('Run AI-assisted review');
      const state = await until(
        async () => {
          const s = await panel(audit);
          return s.coverage === 'completed' || s.coverage === 'partial' ? s : null;
        },
        'the review to finish',
        60_000,
      );
      expect(state.stats).toContain('sent to the model');
      expect(mock.seen.length).toBeGreaterThan(0);
      for (const request of mock.seen) {
        expect(request.method).toBe('POST');
        expect(request.url).toBe('/v1/semantic');
        for (const name of ['cookie', 'referer', 'authorization'])
          expect(request.headers[name], name).toBeUndefined();
        for (const secret of [
          ...SECRETS,
          new URL(server.origin).host,
          '/ai',
          'https://',
          'localStorage',
        ])
          expect(request.body, secret).not.toContain(secret);
      }
      // The answer was parsed, validated and rendered as an advisory interpretation next to the finding.
      expect(state.badges.length).toBeGreaterThan(0);
      for (const badge of state.badges)
        expect(badge).toMatch(
          /^(ACCEPTED_ADVISORY|REJECTED|UNRESOLVED)\|.*AI-assisted interpretation/,
        );
      expect(state.badges.some((b) => b.startsWith('ACCEPTED_ADVISORY'))).toBe(true);
      // Packet for the cross-browser comparison.
      const first = JSON.parse(mock.seen[0]?.body ?? '{}') as { payload?: string; task?: string };
      PAYLOADS[browser] = first.payload ?? '';
      mkdirSync(OUT, { recursive: true });
      writeFileSync(path.join(OUT, `ai-packet-${browser}.json`), first.payload ?? '');
      record(
        driver,
        'ai-provider',
        'setting on: loopback POST, parse, validate, advisory block rendered',
        'PASS',
        `${mock.seen.length} request(s)`,
      );
    });

    test('a redirect from the loopback to another loopback server is never followed', async () => {
      const target = await startMock();
      const origin = await startMock({
        redirectTo: `${(await Promise.resolve(target)).endpoint}/v1/semantic`,
      });
      mocks.push(target, origin);
      await driver.setSettings(AI(origin.endpoint));
      const { audit } = await openAudit();
      await audit.clickButton('Run AI-assisted review');
      const state = await until(
        async () => {
          const s = await panel(audit);
          return s.coverage === 'unavailable' ? s : null;
        },
        'unavailable coverage',
        60_000,
      );
      expect(state.text).toContain('unavailable');
      expect(target.seen).toHaveLength(0);
      expect(origin.seen.length).toBeGreaterThan(0);
      // The deterministic audit is untouched by it.
      expect(
        await audit.evaluate<boolean>(`!!document.querySelector('[data-testid="summary-line"]')`),
      ).toBe(true);
      record(driver, 'ai-provider', 'redirect to another loopback server is not followed', 'PASS');
    });

    test('a remote endpoint in storage is never contacted (the default loopback is used instead)', async () => {
      const bait = await startMock();
      mocks.push(bait);
      await driver.setSettings({
        ...AI('https://example.com'),
        semanticAIEndpoint: `http://localhost.evil.com:${new URL(bait.endpoint).port}`,
      });
      const { audit } = await openAudit();
      await audit.clickButton('Run AI-assisted review');
      const state = await until(
        async () => {
          const s = await panel(audit);
          return s.coverage === 'unavailable' ? s : null;
        },
        'unavailable coverage',
        60_000,
      );
      expect(state.text).toContain('unavailable');
      expect(bait.seen).toHaveLength(0);
      record(
        driver,
        'ai-provider',
        'a non-loopback stored endpoint is replaced, never contacted',
        'PASS',
      );
    });

    test('turning the setting off while a request is in flight aborts it', async () => {
      const mock = await startMock({ hold: true });
      mocks.push(mock);
      await driver.setSettings(AI(mock.endpoint));
      const { audit } = await openAudit();
      await audit.clickButton('Run AI-assisted review');
      await until(() => mock.seen.length > 0, 'a request in flight', 30_000);
      await driver.setSettings(AI(mock.endpoint, false));
      await until(() => mock.aborted() > 0, 'the request to be aborted', 30_000);
      const before = mock.seen.length;
      mock.release();
      await new Promise((r) => setTimeout(r, 1500));
      expect(mock.seen).toHaveLength(before);
      const state = await panel(audit);
      expect(state.coverage).toBe('disabled');
      expect(state.badges).toEqual([]);
      record(
        driver,
        'ai-provider',
        'setting off aborts an in-flight request; the late answer is not shown',
        'PASS',
      );
    });

    test('an absent runtime leaves the deterministic audit as it was', async () => {
      await driver.setSettings(AI('http://127.0.0.1:1'));
      const { audit } = await openAudit();
      const before = await audit.evaluate<string>(
        `document.querySelector('[data-testid="summary-line"]')?.textContent ?? ''`,
      );
      await audit.clickButton('Run AI-assisted review');
      const state = await until(
        async () => {
          const s = await panel(audit);
          return s.coverage === 'unavailable' ? s : null;
        },
        'unavailable coverage',
        60_000,
      );
      expect(state.badges).toEqual([]);
      const after = await audit.evaluate<string>(
        `document.querySelector('[data-testid="summary-line"]')?.textContent ?? ''`,
      );
      expect(after).toBe(before);
      record(
        driver,
        'ai-provider',
        'unreachable runtime: unavailable coverage, deterministic summary unchanged',
        'PASS',
      );
    });
  });
}

test('the sanitized packet is identical in Chrome and Firefox for the same fixture', () => {
  test.skip(!PAYLOADS['chrome'] || !PAYLOADS['firefox'], 'both browsers did not run');
  const normalize = (text: string): unknown => {
    const query = JSON.parse(text) as Record<string, unknown>;
    return query;
  };
  expect(normalize(PAYLOADS['firefox'] ?? '{}')).toEqual(normalize(PAYLOADS['chrome'] ?? '{}'));
});
