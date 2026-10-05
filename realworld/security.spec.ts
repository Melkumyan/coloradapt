/**
 * Privacy, security and localization of the developer audit in both real browsers.
 *
 * - privacy: a page full of secrets (form values, hidden fields, a password, textarea and contenteditable text,
 *   a token in the query, a secret in the fragment, credentials in the address, private data in attributes) is
 *   audited; the audit page, the JSON export, the HTML export, the logs, the extension's storage and the network
 *   are searched for every one of them.
 * - security: hostile DOM (markup in class/id/text, huge strings, bidi and zero-width characters, lone
 *   surrogates, a 1,500-deep tree, thousands of classes and attributes, SVG payloads); the audit must stay
 *   bounded, the audit page must run no page-supplied script, and an exported HTML report opened in the browser
 *   must be inert. A scaling check guards against quadratic processing.
 * - localization: Latin, Cyrillic, RTL and CJK pages export valid, readable, sanitized reports.
 */
import { expect, test } from '@playwright/test';
import { parseAuditReport } from '../src/core/audit';
import { median } from './budgets';
import type { Driver, Tab } from './lib/driver';
import { startFixtureServer, type FixtureServer } from './lib/server';
import {
  BROWSERS,
  CAPTURE_EXPORTS,
  READ_EXPORTS,
  SETTINGS_OFF,
  SETTINGS_ON,
  auditRun,
  html,
  launch,
  record,
  until,
} from './lib/scenario';

const SECRETS = [
  'hunter2-PW-SECRET',
  'SECRETQ-123',
  'jane.private@example.com',
  'jane.private%40example.com',
  'FRAG-SECRET-9',
  'HIDDEN-SECRET-77',
  'dear diary SECRET-NOTE',
  'typed by the user SECRET-EDIT',
  'TOKEN-ABCDEF',
  'USER-998877',
  'pass-in-url',
  'audituser',
  'SECRET-COOKIE-55',
  'SECRET-STORAGE-66',
];

const BIDI = /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2028\u2029\uFEFF]/;

const PRIVATE_PAGE = html(`
  <p id="low" class="low">Contact jane.private@example.com for details, low contrast</p>
  <p id="cvd" class="cvd">Red on green, public paragraph text</p>
  <form>
    <input id="email" type="email" aria-label="Email" aria-invalid="true" value="jane.private@example.com" style="border:1px solid #888">
    <input id="pw" type="password" aria-label="Password" value="hunter2-PW-SECRET">
    <input id="plain" type="text" aria-label="Name" value="HIDDEN-SECRET-77" style="color:#aaa;background:#fff">
    <input type="hidden" name="csrf" value="HIDDEN-SECRET-77">
    <textarea id="notes" aria-label="Notes" style="color:#aaa;background:#fff">dear diary SECRET-NOTE</textarea>
  </form>
  <p id="edit" class="low" contenteditable="true">typed by the user SECRET-EDIT</p>
  <p id="data" class="low" data-user-id="USER-998877" data-token="TOKEN-ABCDEF">visible text of a tagged paragraph</p>
  <script>document.cookie = 'sid=SECRET-COOKIE-55; path=/'; try { localStorage.setItem('k', 'SECRET-STORAGE-66'); } catch (e) {}</script>`);

for (const browser of BROWSERS) {
  test.describe(`security ${browser}`, () => {
    test.describe.configure({ mode: 'serial' });
    let driver: Driver;
    let server: FixtureServer;

    test.beforeAll(async () => {
      server = await startFixtureServer();
      driver = await launch(browser);
      await driver.setSettings(SETTINGS_OFF);
    });
    test.afterAll(async () => {
      await driver?.close();
      await server?.close();
    });

    const tabIdByUrl = (fragment: string) =>
      driver.extensionEval<number>(
        `(async () => { const api = globalThis.browser ?? globalThis.chrome; const t = (await api.tabs.query({})).filter((x) => (x.url || '').includes(${JSON.stringify(fragment)})); if (t.length !== 1) throw new Error('tabs: ' + t.length); return t[0].id; })()`,
      );

    /**
     * Opens the audit page for the tab whose address contains `fragment`, exports both reports with real clicks and
     * returns the exact bytes the page produced (a Blob capture; the real download is checked in runtime.spec.ts).
     */
    async function auditAndExport(fragment: string) {
      const tabId = await tabIdByUrl(fragment);
      const audit = await driver.extensionTab(`audit.html?tabId=${tabId}`);
      await until(
        () => audit.evaluate<boolean>(`!!document.querySelector('[data-testid="summary-line"]')`),
        'audit summary',
      );
      await audit.evaluate(CAPTURE_EXPORTS);
      await until(
        () =>
          audit.evaluate<boolean>(
            `![...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Export JSON').disabled`,
          ),
        'export enabled',
      );
      await audit.clickButton('Export JSON');
      await audit.clickButton('Export HTML report');
      const blobs = await until(async () => {
        const all = await audit.evaluate<Array<{ type: string; text: string }>>(READ_EXPORTS);
        return all.length >= 2 ? all : null;
      }, 'both exports produced');
      const jsonText = blobs.find((b) => b.type.startsWith('application/json'))!.text;
      const htmlText = blobs.find((b) => b.type.startsWith('text/html'))!.text;
      expect(parseAuditReport(jsonText).ok).toBe(true);
      expect(htmlText).toMatch(/<\/html>\s*$/i);
      const ui = await audit.evaluate<{
        text: string;
        html: string;
        title: string;
        name: string;
        scripts: number;
        inline: number;
      }>(
        `({ text: document.body.innerText, html: document.documentElement.outerHTML, title: document.title, name: window.name, scripts: document.querySelectorAll('script').length, inline: document.querySelectorAll('[onload],[onerror],[onclick],[onmouseover],[onfocus]').length })`,
      );
      return { audit, json: { text: jsonText }, htmlFile: { text: htmlText }, ui, tabId };
    }

    test('privacy: secrets reach neither the audit page, the exports, the logs, the storage nor the network', async () => {
      await driver.setSettings(SETTINGS_ON);
      server.serve('privacy', PRIVATE_PAGE);
      const page = await driver.newTab();
      const origin = new URL(server.origin);
      const address = `http://audituser:pass-in-url@${origin.host}/privacy?token=SECRETQ-123&email=jane.private%40example.com#FRAG-SECRET-9`;
      await page.open(address);
      await until(
        () => page.ext('GET_DYNAMIC_DIAGNOSTICS').catch(() => null),
        'content script',
      ).catch(() => null);
      // the content script answers by exact address; credentials may be stripped from it, so look the tab up by path
      const tabId = await tabIdByUrl('/privacy');
      const out = await auditAndExport('/privacy');
      const everything: Record<string, string> = {
        'audit page text': out.ui.text,
        'audit page html': out.ui.html,
        'audit page title': out.ui.title + out.ui.name,
        'JSON export': out.json.text,
        'HTML export': out.htmlFile.text,
      };
      const storage = JSON.stringify(
        await driver.extensionEval(
          `(globalThis.browser ?? globalThis.chrome).storage.local.get(null)`,
        ),
      );
      everything['extension storage'] = storage;
      everything['logs'] = JSON.stringify([...page.drainLogs(), ...out.audit.drainLogs()]);
      // the audit page itself keeps nothing of its own
      const own = await out.audit.evaluate<string>(
        `(async () => JSON.stringify({ ls: Object.keys(localStorage), ss: Object.keys(sessionStorage), idb: (indexedDB.databases ? await indexedDB.databases() : []).map((d) => d.name), cookie: document.cookie }))()`,
      );
      expect(own).toBe('{"ls":[],"ss":[],"idb":[],"cookie":""}');
      const leaks: string[] = [];
      for (const [where, text] of Object.entries(everything)) {
        for (const secret of SECRETS)
          if (text.includes(secret)) leaks.push(`${where}: ${secret.slice(0, 6)}…`);
      }
      expect(leaks).toEqual([]);
      // what the report does say about the address: origin and path only
      const report = parseAuditReport(out.json.text);
      expect(report.ok).toBe(true);
      if (report.ok) {
        expect(report.report.page.origin).toBe(server.origin);
        expect(report.report.page.pathname).toBe('/privacy');
      }
      // network: the extension caused no request of its own (the page and the browser's favicon only)
      const requests = server.requests().filter((r) => !/favicon\.ico/.test(r));
      expect(requests).toEqual(['GET /privacy?token=SECRETQ-123&email=jane.private%40example.com']);
      expect(tabId).toBeGreaterThan(0);
      record(
        driver,
        'privacy',
        'audit UI, JSON, HTML, logs, storage, network searched for 14 secrets',
        'PASS',
        `searched ${Object.keys(everything).length} outputs; page keeps nothing (localStorage/sessionStorage/IndexedDB/cookie empty); requests: ${requests.length} (the page itself)`,
      );
      await out.audit.close();
      await page.close();
    });

    test('security: hostile DOM stays bounded, nothing runs in the audit page, the exported HTML is inert', async () => {
      await driver.setSettings(SETTINGS_ON);
      server.serve(
        'hostile',
        html(`
        <div id="host"></div>
        <script>
          window.__pwned = 0;
          const host = document.getElementById('host');
          const add = (el) => host.appendChild(el);
          const p = (cls, text, id) => { const e = document.createElement('p'); e.className = 'low ' + cls; if (id) e.id = id; e.textContent = text; return e; };
          // markup in class, id and text
          add(p('x" onmouseover="window.__pwned=1" y', '<img src=x onerror="window.__pwned=3"> <script>window.__pwned=33<\\/script>', '"><img src=x onerror=window.__pwned=2>'));
          // bidi, zero-width, lone surrogate, combining and astral characters
          add(p('bidi', 'abc\\u202Eevil\\u202C \\u2066iso\\u2069 \\u200Bzero\\u200Dwidth\\uFEFF \\uD800 lone e\\u0301\\u0301\\u0301 \\u{1F600}\\u{1F1FA}\\u{1F1F8}', 'bidi'));
          // huge strings
          add(p('c' + 'x'.repeat(200000), 'big '.repeat(500000), 'i' + 'y'.repeat(200000)));
          // many classes and attributes on one element
          const many = p(Array.from({ length: 8000 }, (_, i) => 'k' + i).join(' '), 'many classes', 'many');
          for (let i = 0; i < 4000; i++) many.setAttribute('data-a' + i, String(i));
          add(many);
          // deep tree: 1,500 is the deepest Chrome itself survives (2,000 crashes the page with no extension installed)
          let deep = host; for (let i = 0; i < 1500; i++) { const d = document.createElement('div'); deep.appendChild(d); deep = d; }
          deep.appendChild(p('deep', 'deep leaf', 'deep'));
          // SVG payloads as page content
          const svg = document.createElement('div');
          svg.innerHTML = '<svg width="40" height="20" onload="window.__pwned=4"><script>window.__pwned=5<\\/script><foreignObject><iframe srcdoc="&lt;script&gt;parent.__pwned=6&lt;/script&gt;"></iframe></foreignObject><a href="javascript:window.__pwned=7"><text id="svgtext" x="2" y="14" fill="#ddd">svg text</text></a><use href="data:image/svg+xml,%3Csvg onload=window.__pwned=8 xmlns=%22http://www.w3.org/2000/svg%22/%3E"/></svg>';
          add(svg);
        </script>`),
      );
      const page = await driver.newTab();
      await page.open(`${server.origin}/hostile`);
      await until(
        () => page.ext('GET_DYNAMIC_DIAGNOSTICS'),
        'content script on a hostile page',
        30_000,
      );
      // the page runs some of its own payloads by itself (an inline SVG onload fires): the baseline for "the audit changed nothing"
      const pwnedBefore = await page.evaluate<number>('window.__pwned');
      const t0 = Date.now();
      const snap = await auditRun(page);
      const auditMs = Date.now() - t0;
      expect(auditMs).toBeLessThan(15_000);
      expect(snap.findings.length).toBeGreaterThan(0);
      const out = await auditAndExport('/hostile');
      // the audit page ran nothing the page supplied
      expect(await out.audit.evaluate<string>('typeof window.__pwned')).toBe('undefined');
      expect(out.ui.inline).toBe(0);
      expect(out.ui.html).not.toMatch(/<img[^>]+onerror/i);
      expect(out.ui.text + out.json.text).not.toMatch(BIDI);
      // no unpaired surrogate survives (valid emoji pairs are fine)
      expect(out.json.text).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
      // the exported HTML opened in the browser: no script, no handler, no javascript: link, nothing executed
      const report = await driver.newTab();
      // opened as a document of its own, on a different origin than the audited page
      server.serve('exported-report', out.htmlFile.text);
      await report.open(`${server.altOrigin}/exported-report`);
      const inert = await report.evaluate<{
        scripts: number;
        handlers: number;
        js: number;
        imgs: number;
        pwned: string;
        frames: number;
      }>(
        `({ scripts: document.querySelectorAll('script').length, handlers: document.querySelectorAll('[onload],[onerror],[onclick],[onmouseover]').length, js: document.querySelectorAll('[href^="javascript:" i],[src^="javascript:" i]').length, imgs: document.querySelectorAll('img,iframe,object,embed,link[rel=stylesheet][href]').length, pwned: typeof window.__pwned, frames: document.querySelectorAll('iframe').length })`,
      );
      expect(inert).toEqual({
        scripts: 0,
        handlers: 0,
        js: 0,
        imgs: 0,
        pwned: 'undefined',
        frames: 0,
      });
      expect(server.requests().some((r) => /pwn|onerror|\/x$/i.test(r))).toBe(false);
      // the page's own world is untouched by the audit: nothing it set changed, nothing new appeared
      expect(await page.evaluate<number>('window.__pwned')).toBe(pwnedBefore);
      record(
        driver,
        'security',
        'hostile DOM: markup in class/id/text, huge strings, bidi/zero-width/lone surrogates, 1,500-deep tree, 8,000 classes + 4,000 attributes, SVG payloads',
        'PASS',
        `audit ${auditMs} ms (bounded); audit page ran no page script; exported HTML inert (0 scripts, 0 handlers, 0 javascript: links, 0 sub-resources); no bidi/zero-width/lone surrogate in reports`,
      );
      await report.close();
      await out.audit.close();
      await page.close();
    });

    test('security: audit time scales (about) linearly, never quadratically', async () => {
      await driver.setSettings(SETTINGS_ON);
      const timings: Record<number, number> = {};
      for (const n of [500, 1000, 2000, 4000]) {
        server.serve(
          `scale${n}`,
          html(`<div id="host"></div><script>
            const host = document.getElementById('host');
            for (let i = 0; i < ${n}; i++) { const e = document.createElement('p'); e.className = 'low a' + (i % 17) + ' b' + (i % 13); e.id = 'p' + i; e.textContent = 'row ' + i + ' \\u202E text'; host.appendChild(e); }
          </script>`),
        );
        const runs: number[] = [];
        for (let r = 0; r < 3; r++) {
          const tab = await driver.newTab();
          await tab.open(`${server.origin}/scale${n}`);
          await until(() => tab.ext('GET_DYNAMIC_DIAGNOSTICS'), 'content script');
          const t0 = Date.now();
          await auditRun(tab);
          runs.push(Date.now() - t0);
          await tab.close();
        }
        timings[n] = median(runs);
      }
      const ratio = timings[4000]! / Math.max(1, timings[500]!);
      // linear is 8x for 8x the elements; quadratic would be 64x. Allow 2.5x of linear.
      expect(ratio).toBeLessThan(20);
      record(
        driver,
        'security',
        'audit time vs size (500/1000/2000/4000 elements, median of 3)',
        'PASS',
        `${JSON.stringify(timings)} ms; 8x elements -> ${ratio.toFixed(1)}x time (linear 8x, quadratic 64x)`,
      );
    });

    const LOCALES: Array<{ name: string; attrs: string; text: string; probe: string }> = [
      {
        name: 'latin',
        attrs: 'lang="fr"',
        text: 'Texte à faible contraste: déjà vu, naïve façade, Œuvre',
        probe: 'faible contraste',
      },
      {
        name: 'cyrillic',
        attrs: 'lang="ru"',
        text: 'Текст с низким контрастом: пример на русском языке',
        probe: 'низким контрастом',
      },
      {
        name: 'rtl-arabic',
        attrs: 'lang="ar" dir="rtl"',
        text: 'نص منخفض التباين: مثال باللغة العربية',
        probe: 'منخفض التباين',
      },
      {
        name: 'rtl-hebrew',
        attrs: 'lang="he" dir="rtl"',
        text: 'טקסט בניגודיות נמוכה: דוגמה בעברית',
        probe: 'בניגודיות נמוכה',
      },
      {
        name: 'cjk-ja',
        attrs: 'lang="ja"',
        text: 'コントラストが低いテキスト：日本語の例',
        probe: 'コントラスト',
      },
      {
        name: 'cjk-zh',
        attrs: 'lang="zh-Hans"',
        text: '对比度低的文本：中文示例',
        probe: '对比度',
      },
    ];
    for (const locale of LOCALES) {
      test(`localization (${locale.name}): reports are valid UTF-8, readable and sanitized`, async () => {
        await driver.setSettings(SETTINGS_ON);
        const title = `${locale.text.slice(0, 8)}\u202E evil`;
        server.serve(
          `loc-${locale.name}`,
          html(
            `<p id="t" class="low">${locale.text}\u202E</p><p id="c" class="cvd">${locale.text}</p>`,
            `<title>${title}</title>`,
            locale.attrs,
          ),
        );
        const page = await driver.newTab();
        await page.open(`${server.origin}/loc-${locale.name}`);
        await until(() => page.ext('GET_DYNAMIC_DIAGNOSTICS'), 'content script');
        const out = await auditAndExport(`/loc-${locale.name}`);
        const parsed = parseAuditReport(out.json.text);
        expect(parsed.ok).toBe(true);
        expect(out.json.text).toContain(locale.probe); // the snippet is readable, not mojibake
        expect(out.htmlFile.text).toContain(locale.probe);
        expect(out.htmlFile.text).toMatch(/<meta charset="utf-8">/i);
        expect(out.json.text + out.htmlFile.text + out.ui.text).not.toMatch(BIDI);
        record(
          driver,
          'localization',
          `${locale.name}: export valid and sanitized`,
          'PASS',
          `snippet readable in JSON and HTML, no bidi/zero-width controls, the page's bidi-laden title does not reach the report`,
        );
        await out.audit.close();
        await page.close();
      });
    }
  });
}

/** Keep the type import used under every configuration. */
export type { Tab };
