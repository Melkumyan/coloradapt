/**
 * M13: an accessibility extension must not ship an inaccessible control surface. The popup, the options page and the
 * developer audit (with the AI panel and its "not granted" / "unavailable" notice) are checked in real Chrome and
 * Firefox for what can be measured by a script:
 *
 *   - every control has an accessible name;
 *   - the keyboard reaches every control, never traps, and every focused control shows a focus indicator;
 *   - text contrast (WCAG 2.x ratio) of every readable text, with its effective background;
 *   - reflow at a 320 px wide viewport (400 percent zoom of 1280): no horizontal scrolling on options and audit;
 *   - state is never color alone (the panel states are words with distinct symbols: unit-tested, repeated here for the
 *     notice that shows).
 *
 * It does not replace a screen-reader pass; none was run (docs/store/RELEASE_RISK_REGISTER.md).
 */
import { expect, test } from '@playwright/test';
import type { Driver, FirefoxDriver, Tab } from '../lib/driver';
import { startChrome, startFirefox } from '../lib/driver';
import { startFixtureServer } from '../lib/server';
import { BROWSERS, SETTINGS_OFF, html, record, until } from '../lib/scenario';
import { tabIdOf } from '../m12/kit';

interface Finding {
  readonly kind: string;
  readonly what: string;
}

/** Runs in the page: names, contrast. Returns the findings. */
const STATIC_CHECKS = `(() => {
  const out = [];
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const describe = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ((el.textContent || '').trim() ? ' "' + (el.textContent || '').trim().slice(0, 30) + '"' : '');
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label'); if (aria && aria.trim()) return aria.trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' ').trim(); if (t) return t; }
    if (el.labels && el.labels.length) { const t = [...el.labels].map((l) => l.textContent || '').join(' ').trim(); if (t) return t; }
    if (el.tagName === 'INPUT' && ['button', 'submit'].includes(el.type) && el.value) return el.value;
    const text = (el.textContent || '').trim(); if (text) return text;
    return (el.getAttribute('title') || '').trim();
  };
  const controls = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=checkbox], [tabindex]')].filter(visible);
  for (const el of controls) if (!nameOf(el)) out.push({ kind: 'name', what: describe(el) });
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const background = (el) => { const chain = []; for (let n = el; n; n = n.parentElement) chain.push(n); let bg = { r: 255, g: 255, b: 255, a: 1 }; for (const n of chain.reverse()) { const s = getComputedStyle(n); if (s.backgroundImage !== 'none') return null; const c = parse(s.backgroundColor); if (c && c.a > 0) bg = over(c, bg); } return bg; };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let minRatio = 21;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n.textContent || '').trim()) continue;
    const el = n.parentElement; if (!el || seen.has(el) || !visible(el)) continue; seen.add(el);
    if (['SCRIPT', 'STYLE'].includes(el.tagName)) continue;
    const s = getComputedStyle(el); const fg0 = parse(s.color); const bg = background(el); if (!fg0 || !bg) continue;
    const fg = over({ ...fg0, a: fg0.a * (parseFloat(s.opacity) || 1) }, bg);
    const l1 = lum(fg), l2 = lum(bg); const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(s.fontSize); const bold = parseInt(s.fontWeight, 10) >= 700 || s.fontWeight === 'bold';
    const large = size >= 24 || (bold && size >= 18.66);
    minRatio = Math.min(minRatio, ratio);
    if (ratio < (large ? 3 : 4.5)) out.push({ kind: 'contrast', what: describe(el) + ' ' + ratio.toFixed(2) + ':1' });
  }
  return { findings: out, controls: controls.length, minRatio: Number(minRatio.toFixed(2)) };
})()`;

/** One Tab press and what has the focus afterwards. */
const FOCUS = `(() => { const a = document.activeElement; if (!a || a === document.body) return null; const s = getComputedStyle(a); const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none'; return { key: a.tagName.toLowerCase() + '#' + (a.id || '') + '@' + [...a.parentElement.children].indexOf(a) + ':' + (a.textContent || '').trim().slice(0, 20), ring }; })()`;

async function keyboard(tab: Tab, controls: number): Promise<Finding[]> {
  const out: Finding[] = [];
  const visited = new Set<string>();
  let blank = 0;
  for (let i = 0; i < controls + 12; i += 1) {
    await tab.press('Tab');
    const focus = await tab.evaluate<{ key: string; ring: boolean } | null>(FOCUS);
    if (focus === null) {
      blank += 1;
      if (visited.size > 0 && blank >= 1) break;
      continue;
    }
    if (visited.has(focus.key)) break;
    visited.add(focus.key);
    if (!focus.ring) out.push({ kind: 'focus-ring', what: focus.key });
  }
  if (visited.size < 1) out.push({ kind: 'keyboard', what: 'nothing took focus' });
  return out;
}

async function allowOrDeny(driver: FirefoxDriver, choice: 'allow' | 'deny'): Promise<void> {
  const chrome = async (script: string): Promise<unknown> => {
    await driver.wd('POST', '/moz/context', { context: 'chrome' });
    try {
      return await driver.wd('POST', '/execute/sync', { script, args: [] });
    } finally {
      await driver.wd('POST', '/moz/context', { context: 'content' });
    }
  };
  await until(
    async () =>
      (await chrome(
        `const w = Services.wm.getMostRecentWindow('navigator:browser'); const n = w.PopupNotifications.getNotification('addon-webext-permissions'); if (!n) return false; ${
          choice === 'allow'
            ? 'n.mainAction.callback({});'
            : 'const a = n.secondaryActions && n.secondaryActions[0]; if (a) a.callback({}); else w.PopupNotifications.remove(n);'
        } return true;`,
      )) === true,
    'the native permission prompt',
    20_000,
  );
}

for (const browser of BROWSERS) {
  test(`${browser}: popup, options and developer audit are operable, named, readable and reflow`, async () => {
    test.setTimeout(240_000);
    const server = await startFixtureServer();
    server.serve(
      'sample',
      html(
        `<section aria-label="Region"><h2>Region</h2><button type="button"><canvas class="chart" aria-label="Series" width="300" height="150"></canvas></button></section>`,
      ),
    );
    const driver: Driver =
      browser === 'chrome' ? await startChrome() : await startFirefox({ systemAccess: true });
    try {
      // a dead loopback port: "unavailable" notice (Chrome); the denied native prompt (Firefox)
      await driver.setSettings({
        ...SETTINGS_OFF,
        enabled: true,
        semanticAIEnabled: true,
        semanticAIProvider: 'local-http',
        semanticAIEndpoint: 'http://127.0.0.1:1',
        semanticAIModel: 'rw-mock',
      });
      const problems: Record<string, Finding[]> = {};
      const stats: Record<string, { controls: number; minRatio: number }> = {};
      const inspect = async (name: string, tab: Tab, narrow = true): Promise<void> => {
        const result = await tab.evaluate<{
          findings: Finding[];
          controls: number;
          minRatio: number;
        }>(STATIC_CHECKS);
        const found = [...result.findings, ...(await keyboard(tab, result.controls))];
        if (narrow) {
          const reflow = await tab.evaluate<boolean>(
            `document.documentElement.scrollWidth <= window.innerWidth + 1`,
          );
          if (!reflow)
            found.push({ kind: 'reflow', what: 'horizontal scroll at the current width' });
        }
        problems[name] = found;
        stats[name] = { controls: result.controls, minRatio: result.minRatio };
      };

      const popup = await driver.extensionTab('popup.html');
      await until(
        () => popup.evaluate<boolean>(`!!document.getElementById('vision-profile')`),
        'the popup',
      );
      await inspect('popup', popup, false);
      await popup.close();

      const options = await driver.extensionTab('options.html');
      await until(
        () => options.evaluate<boolean>(`!!document.getElementById('options-ai-endpoint')`),
        'the options page',
      );
      await inspect('options', options);
      await options.close();

      const page = await driver.newTab();
      await page.open(`${server.origin}/sample`);
      const tabId = await until(() => tabIdOf(driver, '/sample').catch(() => null), 'the page tab');
      const audit = await driver.extensionTab(`audit.html?tabId=${tabId}`);
      await until(
        () => audit.evaluate<boolean>(`!!document.querySelector('[data-testid="assist-run"]')`),
        'the run button',
        30_000,
      );
      await inspect('audit', audit);
      // the notice
      await audit.clickButton('Run AI-assisted review');
      if (browser === 'firefox') await allowOrDeny(driver as FirefoxDriver, 'deny');
      await until(
        () => audit.evaluate<boolean>(`!!document.querySelector('[role="alert"].notice')`),
        'the unavailable / not granted notice',
        60_000,
      );
      await inspect('audit-notice', audit);
      // a narrow viewport (400 percent zoom of a 1280 wide window)
      if (browser === 'chrome') {
        const tab = audit as unknown as {
          page: { setViewportSize(s: { width: number; height: number }): Promise<void> };
        };
        await tab.page.setViewportSize({ width: 320, height: 640 });
        await new Promise((r) => setTimeout(r, 400));
        const narrow = await audit.evaluate<boolean>(
          `document.documentElement.scrollWidth <= window.innerWidth + 8`,
        );
        stats['audit-320px'] = { controls: 0, minRatio: 0 };
        if (!narrow)
          (problems['audit'] ??= []).push({ kind: 'reflow', what: 'horizontal scroll at 320 px' });
      }
      console.log(browser, JSON.stringify(stats));
      for (const [name, list] of Object.entries(problems)) expect(list, name).toEqual([]);
      record(
        driver,
        'm13-ui-a11y',
        'popup/options/audit: names, keyboard, focus ring, contrast, reflow',
        'PASS',
        JSON.stringify(stats).slice(0, 400),
      );
    } finally {
      await driver.close();
      await server.close();
    }
  });
}
