/**
 * M12 (docs/m12/protocol.md) P22: the accessibility of ColorAdapt's own pages (popup, options, developer audit)
 * in the real browsers: accessible names, roles and states, a complete keyboard path with a visible focus
 * indicator and no trap, focus staying inside the page when content changes, text contrast and zoom reflow.
 */
import { expect, test } from '@playwright/test';
import { startFirefox, type ChromeTab, type Driver, type Tab } from '../lib/driver';
import { startFixtureServer, type FixtureServer } from '../lib/server';
import {
  BASIC,
  BROWSERS,
  SETTINGS_ON,
  hasStylesheet,
  launch,
  record,
  until,
} from '../lib/scenario';
import { tabIdOf } from './kit';

const AREA = 'm12-ui-a11y';

/** In-page probes (a plain script: evaluated in the extension page's own world). */
const PROBES = `(() => {
  const INTERACTIVE = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"]), [role=button], [role=checkbox], [role=switch], [role=tab]';
  const enabled = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const text = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim();
  const nameOf = (el) => {
    const label = el.getAttribute('aria-label'); if (label && label.trim()) return label.trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\\s+/).map((id) => { const e = document.getElementById(id); return e ? text(e) : ''; }).join(' ').trim(); if (t) return t; }
    if (el.labels && el.labels.length) { const t = [...el.labels].map(text).join(' ').trim(); if (t) return t; }
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type) && el.value) return el.value;
    const alt = el.querySelector('img[alt]'); if (alt && alt.getAttribute('alt')) return alt.getAttribute('alt');
    const t = text(el); if (t) return t;
    return (el.getAttribute('title') || '').trim();
  };
  const lum = (c) => { const v = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const rgba = (s) => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const backdrop = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c && c.a > 0.99) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
  return {
    interactive: () => [...document.querySelectorAll(INTERACTIVE)].filter(visible).filter(enabled),
    unnamed: () => [...document.querySelectorAll(INTERACTIVE)].filter(visible).filter((e) => !nameOf(e)).map((e) => e.outerHTML.slice(0, 100)),
    describe: (el) => el === document.body ? 'BODY' : (el.tagName + (el.id ? '#' + el.id : '') + ':' + nameOf(el).slice(0, 40)),
    focusStyle: (el) => { const s = getComputedStyle(el); return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, boxShadow: s.boxShadow }; },
    contrast: () => {
      const bad = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const seen = new Set();
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement; if (!el || seen.has(el) || !n.textContent.trim() || !visible(el)) continue; seen.add(el);
        const s = getComputedStyle(el); const fg = rgba(s.color); if (!fg) continue; const bg = backdrop(el);
        const a = fg.a; const mix = [fg.r * a + bg.r * (1 - a), fg.g * a + bg.g * (1 - a), fg.b * a + bg.b * (1 - a)];
        const l1 = lum(mix), l2 = lum([bg.r, bg.g, bg.b]); const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        const size = parseFloat(s.fontSize), bold = parseInt(s.fontWeight, 10) >= 700; const large = size >= 24 || (size >= 18.66 && bold);
        if (ratio < (large ? 3 : 4.5)) bad.push({ text: n.textContent.trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100 });
      }
      return bad;
    },
    headings: () => [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => h.tagName),
    lang: () => document.documentElement.lang,
    title: () => document.title,
    overflowAt: (zoom) => { document.documentElement.style.zoom = String(zoom); const w = document.documentElement.scrollWidth - window.innerWidth; document.documentElement.style.zoom = ''; return w; },
  };
})()`;

const probe = <T>(tab: Tab, call: string): Promise<T> => tab.evaluate<T>(`(${PROBES}).${call}`);

interface Stop {
  readonly name: string;
  readonly outlineStyle: string;
  readonly outlineWidth: string;
  readonly boxShadow: string;
}

/** Tab through a page from its start, recording each stop and how its focus is drawn; `expected + 2` presses. */
async function tabRound(tab: Tab, expected: number): Promise<Stop[]> {
  await tab.evaluate(`(document.activeElement && document.activeElement.blur(), 1)`);
  const stops: Stop[] = [];
  for (let i = 0; i < expected + 2; i++) {
    await tab.press('Tab');
    stops.push(
      await tab.evaluate<Stop>(
        `(() => { const p = ${PROBES}; return { name: p.describe(document.activeElement), ...p.focusStyle(document.activeElement) }; })()`,
      ),
    );
  }
  return stops;
}

const drawn = (s: Stop) =>
  (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none';

for (const browser of BROWSERS) {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`M12 UI accessibility ${browser} ${scheme}`, () => {
      test.describe.configure({ mode: 'serial' });
      let driver: Driver;
      let server: FixtureServer;

      test.beforeAll(async () => {
        server = await startFixtureServer();
        server.serve('basic', BASIC);
        // Firefox is told which scheme its content prefers; Chrome is emulated per page (DevTools)
        driver =
          browser === 'firefox'
            ? await startFirefox({
                prefs: {
                  'layout.css.prefers-color-scheme.content-override': scheme === 'dark' ? 0 : 1,
                },
              })
            : await launch(browser);
        await driver.setSettings({ ...SETTINGS_ON, visionProfile: 'deuteranopia' });
      });
      test.afterAll(async () => {
        await driver?.close();
        await server?.close();
      });

      /** Chrome: ask the page for the scheme under test. Firefox was started with it. */
      async function emulate(tab: Tab): Promise<void> {
        if (browser !== 'chrome') return;
        const cdp = await (tab as ChromeTab).session();
        await cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: scheme }],
        });
      }

      async function ready(path: string): Promise<Tab> {
        const ui = await driver.extensionTab(path);
        await emulate(ui);
        expect(
          await ui.evaluate<boolean>(`matchMedia('(prefers-color-scheme: dark)').matches`),
          `the page is in the ${scheme} scheme under test`,
        ).toBe(scheme === 'dark');
        await until(
          () =>
            ui.evaluate<boolean>(`document.querySelectorAll('button, select, input').length > 0`),
          `${path} controls`,
          30_000,
        );
        return ui;
      }

      for (const path of ['popup.html', 'options.html']) {
        test(`P22 ${path}: names, roles, keyboard path, visible focus, no trap, contrast, reflow`, async () => {
          const ui = await ready(path);
          expect(await probe<string>(ui, 'lang()'), 'document language').not.toBe('');
          expect(await probe<string>(ui, 'title()'), 'document title').not.toBe('');
          const headings = await probe<string[]>(ui, 'headings()');
          expect(
            headings.filter((h) => h === 'H1'),
            'one main heading',
          ).toHaveLength(1);
          expect(
            await probe<string[]>(ui, 'unnamed()'),
            'controls without an accessible name',
          ).toEqual([]);

          // a real keyboard pass: every interactive element is reached, in DOM order, and focus is visible
          const count = (await probe<unknown[]>(ui, 'interactive()')).length;
          expect(count).toBeGreaterThan(2);
          const stops = await tabRound(ui, count);
          const names = stops.map((st) => st.name);
          const reached = new Set(names.slice(0, count));
          expect(reached.size, `distinct stops in ${count} Tabs: ${names.join(' > ')}`).toBe(count);
          // visible focus on every stop inside the page
          expect(
            stops
              .slice(0, count)
              .filter((st) => !drawn(st))
              .map((st) => st.name),
            'controls with no visible focus indicator',
          ).toEqual([]);
          // not a trap: past the last control the focus leaves the page's controls (the browser's own UI, or a wrap)
          const last = names[count - 1];
          expect(
            names.slice(count).some((n) => n !== last || n === 'BODY'),
            `stuck on ${last}`,
          ).toBe(true);

          // contrast of every visible text
          const lowContrast = await probe<Array<{ text: string; ratio: number }>>(ui, 'contrast()');
          expect(lowContrast, 'text below WCAG AA contrast').toEqual([]);

          // reflow at 200% and 400% zoom: no horizontal scrolling needed
          for (const zoom of [2, 4]) {
            expect(
              await probe<number>(ui, `overflowAt(${zoom})`),
              `horizontal overflow at ${zoom * 100}%`,
            ).toBeLessThanOrEqual(1);
          }
          await ui.close();
          record(
            driver,
            AREA,
            `P22 ${path} (${scheme})`,
            'PASS',
            `${count} controls, ${headings.join(',')}`,
          );
        });
      }

      test('P22 popup: the toggle exposes its state and changing a setting keeps focus on the control', async () => {
        const ui = await ready('popup.html');
        const state = await ui.evaluate<{ pressed: string | null; name: string }>(
          `(() => { const b = document.querySelector('button[aria-pressed]'); return { pressed: b && b.getAttribute('aria-pressed'), name: b ? (b.getAttribute('aria-label') || b.textContent || '').trim() : '' }; })()`,
        );
        expect(state.pressed).toMatch(/^(true|false)$/);
        // the group is named (labelledby) and the select has a label
        expect(
          await ui.evaluate<boolean>(
            `(() => { const s = document.querySelector('select'); return !!(s && s.labels && s.labels.length); })()`,
          ),
        ).toBe(true);
        // activate the toggle with the keyboard: its state flips and focus does not fall to the body
        await ui.evaluate(`(document.querySelector('button[aria-pressed]').focus(), 1)`);
        const before = state.pressed;
        await ui.press('Enter');
        await until(
          () =>
            ui.evaluate<boolean>(
              `document.querySelector('button[aria-pressed]').getAttribute('aria-pressed') !== ${JSON.stringify(before)}`,
            ),
          'the toggle state to change',
        );
        expect(
          await ui.evaluate<string>(
            `document.activeElement ? document.activeElement.tagName : 'NONE'`,
          ),
        ).toBe('BUTTON');
        await ui.press('Space');
        await until(
          () =>
            ui.evaluate<boolean>(
              `document.querySelector('button[aria-pressed]').getAttribute('aria-pressed') === ${JSON.stringify(before)}`,
            ),
          'the toggle to flip back with Space',
        );
        await ui.close();
        record(driver, AREA, `P22 popup toggle state and focus (${scheme})`, 'PASS');
      });

      test('P22 developer audit page: names, roles, keyboard path, focus kept when findings change, contrast', async () => {
        const page = await driver.newTab();
        await page.open(`${server.origin}/basic`);
        await until(() => hasStylesheet(page), 'adapted');
        const id = await tabIdOf(driver, '/basic');
        const audit = await driver.extensionTab(`audit.html?tabId=${id}`);
        await emulate(audit);
        await until(
          () => audit.evaluate<boolean>(`!!document.querySelector('[data-testid="summary-line"]')`),
          'audit summary',
          30_000,
        );
        expect(
          await probe<string[]>(audit, 'unnamed()'),
          'controls without an accessible name',
        ).toEqual([]);
        expect(await probe<string>(audit, 'lang()')).not.toBe('');
        const lowContrast = await probe<Array<{ text: string; ratio: number }>>(
          audit,
          'contrast()',
        );
        expect(lowContrast, 'text below WCAG AA contrast').toEqual([]);
        const count = (await probe<unknown[]>(audit, 'interactive()')).length;
        const stops = await tabRound(audit, count);
        expect(
          new Set(stops.slice(0, count).map((st) => st.name)).size,
          stops.map((st) => st.name).join(' > '),
        ).toBe(count);
        expect(
          stops
            .slice(0, count)
            .filter((st) => !drawn(st))
            .map((st) => st.name),
          'controls with no visible focus indicator',
        ).toEqual([]);

        // focus stays on a control of the page while the audited page changes under it (a live update)
        await audit.evaluate(
          `(document.querySelector('select') && document.querySelector('select').focus(), 1)`,
        );
        await page.evaluate(
          `(() => { const p = document.createElement('p'); p.className = 'low'; p.textContent = 'live low contrast text'; document.body.append(p); return 1; })()`,
        );
        await until(
          () =>
            audit.evaluate<boolean>(
              `document.activeElement && document.activeElement !== document.body`,
            ),
          'focus to stay on a control after a live update',
        );
        expect(await audit.evaluate<boolean>(`document.activeElement === document.body`)).toBe(
          false,
        );
        for (const zoom of [2, 4]) {
          expect(
            await probe<number>(audit, `overflowAt(${zoom})`),
            `audit overflow at ${zoom * 100}%`,
          ).toBeLessThanOrEqual(1);
        }
        await audit.close();
        await page.close();
        record(driver, AREA, `P22 developer audit page (${scheme})`, 'PASS', `${count} controls`);
      });
    });
  }
}
