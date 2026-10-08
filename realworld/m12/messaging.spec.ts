/**
 * M12 (docs/m12/protocol.md) P21, P26 (message authority), P53 (URL handling): internal messaging against an
 * absent receiver, a closed tab, a restarted worker, duplicates, malformed payloads and a stale audit port; and
 * a page that tries to command the extension with forged messages. Real browsers, production builds.
 */
import { expect, test } from '@playwright/test';
import type { ChromeDriver, Driver } from '../lib/driver';
import { startFixtureServer, type FixtureServer } from '../lib/server';
import {
  BASIC,
  BROWSERS,
  SETTINGS_ON,
  hasStylesheet,
  launch,
  record,
  sleep,
  until,
} from '../lib/scenario';
import {
  fatalLogs,
  gauges,
  quiesce,
  residue,
  stopServiceWorker,
  tabIdOf,
  toBackground,
} from './kit';

const AREA = 'm12-messaging';

interface Sent {
  ok: boolean;
  value?: unknown;
  error?: string;
  timedOut?: boolean;
}

/** `tabs.sendMessage` from an extension page, never hanging: a send that does not answer within 8 s reports `timedOut`. */
const sendToTab = (driver: Driver, tabId: number, message: unknown): Promise<Sent> =>
  driver.extensionEval<Sent>(
    `(async () => {
      const api = globalThis.browser ?? globalThis.chrome;
      const timeout = new Promise((r) => setTimeout(() => r({ ok: false, timedOut: true }), 8000));
      const send = (async () => {
        try { return { ok: true, value: await api.tabs.sendMessage(${tabId}, ${JSON.stringify(message)}) }; }
        catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
      })();
      return await Promise.race([send, timeout]);
    })()`,
  );

/** Many sends issued together from inside the extension page (one WebDriver call, truly concurrent in the browser). */
const sendManyToTab = (driver: Driver, tabId: number, messages: unknown[]): Promise<Sent[]> =>
  driver.extensionEval<Sent[]>(
    `(async () => {
      const api = globalThis.browser ?? globalThis.chrome;
      return await Promise.all(${JSON.stringify(messages)}.map(async (m) => {
        try { return { ok: true, value: await api.tabs.sendMessage(${tabId}, m) }; }
        catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
      }));
    })()`,
  );

const msg = (type: string, payload?: unknown) => ({ channel: 'coloradapt', type, payload });

for (const browser of BROWSERS) {
  test.describe(`M12 messaging ${browser}`, () => {
    test.describe.configure({ mode: 'serial' });
    let driver: Driver;
    let server: FixtureServer;

    test.beforeAll(async () => {
      server = await startFixtureServer();
      server.serve('basic', BASIC);
      server.serve('other', BASIC.replace('fixture', 'other page'));
      driver = await launch(browser);
      await driver.setSettings(SETTINGS_ON);
    });
    test.afterAll(async () => {
      await driver?.close();
      await server?.close();
    });

    test('P21 absent receiver and closed tab: a clean rejection, never a hang, and the extension keeps working', async () => {
      const blank = await driver.newTab(); // about:blank: no content script
      const blankId = await tabIdOf(driver, 'about:blank').catch(() => -1);
      if (blankId >= 0) {
        const r = await sendToTab(driver, blankId, msg('GET_ANALYSIS'));
        expect(r.timedOut ?? false).toBe(false);
        expect(r.ok).toBe(false);
      }
      await blank.close();

      const doomed = await driver.newTab();
      await doomed.open(`${server.origin}/basic?doomed=1`);
      await until(() => hasStylesheet(doomed), 'adapted');
      const id = await tabIdOf(driver, '/basic?doomed=1');
      await doomed.close();
      const gone = await sendToTab(driver, id, msg('GET_ANALYSIS'));
      expect(gone.timedOut ?? false).toBe(false);
      expect(gone.ok).toBe(false);

      // the background and the other tabs are unaffected
      const live = await driver.newTab();
      await live.open(`${server.origin}/basic?live=1`);
      await until(() => hasStylesheet(live), 'a later page adapts');
      expect(await toBackground<{ enabled: boolean }>(driver, 'GET_SETTINGS')).toMatchObject({
        enabled: true,
      });
      expect(fatalLogs(live.drainLogs())).toEqual([]);
      await live.close();
      record(
        driver,
        AREA,
        'P21 absent receiver / closed tab',
        'PASS',
        `${gone.error ?? ''}`.slice(0, 100),
      );
    });

    test('P21 duplicated and concurrent messages are idempotent: one stylesheet, one observer, empty queues', async () => {
      const tab = await driver.newTab();
      await tab.open(`${server.origin}/basic?dup=1`);
      await until(() => hasStylesheet(tab), 'adapted');
      const id = await tabIdOf(driver, '/basic?dup=1');
      const messages: unknown[] = [];
      for (let i = 0; i < 12; i++) {
        messages.push(msg('ENABLE_ADAPTATION'), msg('REFRESH_ADAPTATION'));
        if (i % 3 === 0) messages.push(msg('FLUSH_DYNAMIC'));
      }
      for (const r of await sendManyToTab(driver, id, messages)) expect(r.ok, r.error).toBe(true);
      const g = await quiesce(tab);
      const r = await residue(tab);
      expect(r.sheets).toBe(1);
      expect(r.duplicateIds).toBe(0);
      expect(g.queueOverflows).toBe(0);
      await tab.ext('DISABLE_ADAPTATION');
      await tab.ext('DISABLE_ADAPTATION'); // a duplicate disable is harmless
      expect((await residue(tab)).sheets).toBe(0);
      await tab.ext('ENABLE_ADAPTATION');
      expect((await residue(tab)).sheets).toBe(1);
      await tab.close();
      record(
        driver,
        AREA,
        'P21 duplicate/concurrent messages',
        'PASS',
        `${messages.length} messages`,
      );
    });

    test('P21 malformed and unknown messages never wedge the content script or the background', async () => {
      const tab = await driver.newTab();
      await tab.open(`${server.origin}/basic?junk=1`);
      await until(() => hasStylesheet(tab), 'adapted');
      const id = await tabIdOf(driver, '/basic?junk=1');
      const junk: unknown[] = [
        null,
        'ColorAdapt',
        42,
        { channel: 'coloradapt' },
        { channel: 'coloradapt', type: 'NOT_A_TYPE' },
        { channel: 'other', type: 'GET_ANALYSIS' },
        msg('AUDIT_RUN', { scope: { not: 'a scope' } }),
        msg('AUDIT_HIGHLIGHT', null),
        msg('AUDIT_SEMANTIC_CASES', 'x'),
        msg('UPDATE_SETTINGS', { enabled: 'maybe', adaptationStrength: 'lots' }),
      ];
      for (const m of junk) {
        const r = await sendToTab(driver, id, m);
        expect(r.timedOut ?? false, JSON.stringify(m)).toBe(false);
      }
      // malformed settings patches sent to the background are sanitized, never stored raw
      const stored = await toBackground<Record<string, unknown>>(driver, 'UPDATE_SETTINGS', {
        enabled: 'maybe',
        adaptationStrength: 'lots',
      });
      expect(typeof stored['enabled']).toBe('boolean');
      expect(stored['adaptationStrength']).toBe(0.7);
      await driver.setSettings(SETTINGS_ON);
      // still alive
      const ok = await sendToTab(driver, id, msg('GET_DYNAMIC_DIAGNOSTICS'));
      expect(ok.ok).toBe(true);
      expect(
        fatalLogs(tab.drainLogs()).filter((l) => !/handler for .* failed/.test(l.text)),
      ).toEqual([]);
      await tab.close();
      record(driver, AREA, 'P21 malformed/unknown messages', 'PASS', `${junk.length} forms`);
    });

    test('P21 a message after the worker restarted, and a stale audit port after the audited page navigated', async () => {
      if (browser === 'chrome') {
        const tab0 = await driver.newTab();
        await tab0.open(`${server.origin}/basic?w=1`);
        await until(() => hasStylesheet(tab0), 'adapted');
        const id0 = await tabIdOf(driver, '/basic?w=1');
        await stopServiceWorker(driver as ChromeDriver);
        // the content script's own settings read wakes the worker
        const r = await sendToTab(driver, id0, msg('REFRESH_ADAPTATION'));
        expect(r.ok, r.error).toBe(true);
        await tab0.close();
      }

      const page = await driver.newTab();
      await page.open(`${server.origin}/basic?port=1`);
      await until(() => hasStylesheet(page), 'adapted');
      const id = await tabIdOf(driver, '/basic?port=1');
      const audit = await driver.extensionTab(`audit.html?tabId=${id}`);
      await until(
        () => audit.evaluate<boolean>(`!!document.querySelector('[data-testid="summary-line"]')`),
        'audit summary',
        30_000,
      );
      const before = await page.ext<{ sessionsOpen?: number }>('AUDIT_DIAGNOSTICS');
      // the audited page navigates away while the audit page (and its port) is open
      await page.open(`${server.origin}/other`);
      await until(() => hasStylesheet(page), 'the new document adapts');
      await sleep(500);
      const g = await quiesce(page);
      expect(g.queueOverflows).toBe(0);
      // the new document answers, the audit page survived and the old document's port left nothing behind
      expect((await sendToTab(driver, id, msg('AUDIT_GET'))).ok).toBe(true);
      expect(fatalLogs(audit.drainLogs())).toEqual([]);
      await audit.close();
      await sleep(500);
      expect((await residue(page)).sheets).toBe(1);
      void before;
      await page.close();
      record(driver, AREA, 'P21 worker restart + stale audit port', 'PASS');
    });

    test('P26 forged messages from the page cannot command the extension', async () => {
      await driver.setSettings({ ...SETTINGS_ON, visionProfile: 'deuteranopia', enabled: true });
      const tab = await driver.newTab();
      await tab.open(`${server.origin}/basic?spoof=1`);
      await until(() => hasStylesheet(tab), 'adapted');
      const before = (await driver.getSettings()) as Record<string, unknown>;
      const attempt = await tab.evaluate<string>(`(async () => {
        const out = [];
        const forged = [
          { channel: 'coloradapt', type: 'UPDATE_SETTINGS', payload: { enabled: false, visionProfile: 'tritanopia', semanticAIEndpoint: 'http://127.0.0.1:1' } },
          { channel: 'coloradapt', type: 'DISABLE_ADAPTATION', payload: undefined },
          { channel: 'coloradapt', type: 'AUDIT_RUN', payload: { scope: 'major' } },
        ];
        for (const m of forged) {
          window.postMessage(m, '*');
          window.dispatchEvent(new MessageEvent('message', { data: m, origin: location.origin }));
          document.dispatchEvent(new CustomEvent('coloradapt', { detail: m }));
          window.dispatchEvent(new CustomEvent('coloradapt', { detail: m }));
        }
        // the page's own routes to extension messaging
        try { out.push('chrome.runtime.sendMessage: ' + typeof (window.chrome && window.chrome.runtime && window.chrome.runtime.sendMessage)); } catch (e) { out.push('chrome err'); }
        try { out.push('browser: ' + typeof window.browser); } catch (e) { out.push('browser err'); }
        try {
          if (window.chrome && window.chrome.runtime && window.chrome.runtime.sendMessage) {
            await new Promise((resolve) => { try { window.chrome.runtime.sendMessage('abcdefghijklmnopabcdefghijklmnop', forged[0], () => { void window.chrome.runtime.lastError; resolve(); }); } catch (e) { resolve(); } });
            out.push('sent-to-fake-id');
          }
        } catch (e) { out.push('send threw'); }
        return out.join(' | ');
      })()`);
      await sleep(1500);
      const after = (await driver.getSettings()) as Record<string, unknown>;
      // the page has no route to extension messaging at all
      expect(attempt).toContain('chrome.runtime.sendMessage: undefined');
      expect(attempt).toContain('browser: undefined');
      expect(after).toEqual(before); // nothing changed in storage
      expect(await hasStylesheet(tab)).toBe(true); // nothing switched off
      expect((await gauges(tab)).state).toBeDefined();
      await tab.close();
      record(driver, AREA, 'P26 forged messages from a page', 'PASS', attempt.slice(0, 160));
    });

    test('P14/P17 the browser keeps extension pages on themselves and the loopback (CSP), and runs no injected script', async () => {
      for (const path of ['popup.html', 'audit.html?tabId=1']) {
        const ui = await driver.extensionTab(path);
        await sleep(500);
        const result = await ui.evaluate<{
          outcomes: Record<string, string>;
          violations: string[];
          injected: boolean;
        }>(`(async () => {
          const violations = [];
          document.addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective + ' ' + e.blockedURI.slice(0, 40)));
          const outcomes = {};
          const tries = {
            remote: 'https://example.com/',
            lan: 'http://192.168.1.10:8080/',
            loopback: ${JSON.stringify(server.origin)} + '/basic',
            alt_loopback: ${JSON.stringify(server.altOrigin)} + '/basic',
            self: location.origin + '/popup.html',
          };
          for (const [name, url] of Object.entries(tries)) {
            try { await fetch(url, { mode: 'no-cors' }); outcomes[name] = 'allowed'; } catch { outcomes[name] = 'blocked'; }
          }
          outcomes.websocket = await new Promise((resolve) => {
            try { const ws = new WebSocket('wss://example.com/'); ws.onerror = () => resolve('blocked'); ws.onopen = () => { ws.close(); resolve('allowed'); }; setTimeout(() => resolve('timeout'), 4000); } catch { resolve('blocked'); }
          });
          // code from the page's own DOM: an inline script and a remote one must not run
          window.__injected = false;
          const inline = document.createElement('script'); inline.textContent = 'window.__injected = true'; document.body.append(inline);
          const remote = document.createElement('script'); remote.src = 'https://example.com/x.js'; document.body.append(remote);
          await new Promise((r) => setTimeout(r, 800));
          return { outcomes, violations, injected: window.__injected === true };
        })()`);
        expect(result.outcomes['remote'], `${path}: remote fetch`).toBe('blocked');
        expect(result.outcomes['lan'], `${path}: LAN fetch`).toBe('blocked');
        expect(result.outcomes['websocket'], `${path}: remote websocket`).toBe('blocked');
        expect(result.outcomes['loopback'], `${path}: loopback fetch`).toBe('allowed');
        expect(result.outcomes['alt_loopback'], `${path}: localhost fetch`).toBe('allowed');
        expect(result.outcomes['self'], `${path}: own origin`).toBe('allowed');
        expect(result.injected, `${path}: injected inline script ran`).toBe(false);
        expect(
          result.violations.some((v) => v.startsWith('connect-src')),
          `${path}: violations ${result.violations.join('; ')}`,
        ).toBe(true);
        await ui.close();
      }
      record(
        driver,
        AREA,
        'P14/P17 CSP on extension pages',
        'PASS',
        'remote, LAN, websocket, inline and remote script blocked; loopback and self allowed',
      );
    });

    test('P53 the audit page rejects hostile or malformed tabId values without throwing or reaching a tab', async () => {
      const forms = [
        '',
        '?tabId=',
        '?tabId=abc',
        '?tabId=-1',
        '?tabId=1e9',
        '?tabId=0x10',
        '?tabId=javascript:alert(1)',
        '?tabId=%00',
        '?tabId=1.5',
        '?tabId=99999999999999999999',
        '?tabId=2147483648',
        '?tabId=2147483647',
        '?tabId=987654',
        '?tabId=1&tabId=2',
        '?tabId=data:text/html,x',
        '?tabId=file:///C:/x',
      ];
      for (const q of forms) {
        const ui = await driver.extensionTab(`audit.html${q}`);
        await sleep(400);
        const body = await ui.evaluate<string>(`document.body.innerText`);
        expect(body, q).toContain('ColorAdapt developer audit');
        expect(fatalLogs(ui.drainLogs().filter((l) => l.level === 'exception')), q).toEqual([]);
        await ui.close();
      }
      record(driver, AREA, 'P53 hostile tabId values', 'PASS', `${forms.length} forms`);
    });
  });
}
