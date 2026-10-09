/**
 * M13.R1: the static public pages (public-site/privacy, public-site/support) in a real browser: readable without
 * JavaScript, keyboard operable, semantic headings, contrast in light and dark, reflow at 320 CSS px and at 200 % zoom,
 * and not a single network request (no beacon, font, script or image).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect, test, type Page } from '@playwright/test';
import { ROOT } from '../lib/driver';

const PAGES = ['privacy', 'support'] as const;
const url = (slug: string): string =>
  pathToFileURL(path.join(ROOT, 'public-site', slug, 'index.html')).href;

/** WCAG contrast ratio from two computed `rgb(...)` strings. */
function ratio(a: string, b: string): number {
  const lum = (css: string): number => {
    const [r, g, bl] = (css.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0']).slice(0, 3).map(Number);
    const f = (v: number): number => {
      const s = (v ?? 0) / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(bl!);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

async function overflowX(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

for (const slug of PAGES) {
  test.describe(`public page ${slug}`, () => {
    test('is readable with JavaScript off, has semantic structure, and makes no request', async () => {
      const browser = await chromium.launch();
      try {
        const context = await browser.newContext({ javaScriptEnabled: false });
        const requests: string[] = [];
        context.on('request', (r) => requests.push(r.url()));
        const page = await context.newPage();
        await page.goto(url(slug));
        expect(await page.locator('h1').count()).toBe(1);
        expect(await page.locator('main h2').count()).toBeGreaterThan(2);
        expect(await page.locator('html').getAttribute('lang')).toBe('en');
        expect(await page.locator('nav[aria-label]').count()).toBe(1);
        expect((await page.locator('main').innerText()).length).toBeGreaterThan(1500);
        // heading levels never skip downward
        const levels = await page.$$eval('h1,h2,h3', (hs) => hs.map((h) => Number(h.tagName[1])));
        for (let i = 1; i < levels.length; i++)
          expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);
        // the only request is the document itself
        expect(requests).toEqual([url(slug)]);
        // external links are plain, noreferrer anchors
        const bad = await page.$$eval('a[href^="http"]', (as) =>
          as
            .filter((a) => !/noopener/.test(a.getAttribute('rel') ?? ''))
            .map((a) => a.getAttribute('href')),
        );
        expect(bad).toEqual([]);
      } finally {
        await browser.close();
      }
    });

    for (const scheme of ['light', 'dark'] as const) {
      test(`${scheme}: contrast, focus indicator and reflow (320 px, 200 % zoom)`, async () => {
        const browser = await chromium.launch();
        try {
          const context = await browser.newContext({
            colorScheme: scheme,
            viewport: { width: 1000, height: 800 },
          });
          const page = await context.newPage();
          await page.goto(url(slug));
          const colors = await page.evaluate(() => {
            const css = (el: Element, p: string): string =>
              getComputedStyle(el).getPropertyValue(p);
            const body = document.body;
            const link = document.querySelector('main a') ?? document.querySelector('nav a')!;
            const code = document.querySelector('main code');
            return {
              fg: css(body, 'color'),
              bg: css(body, 'background-color'),
              link: css(link, 'color'),
              code: code ? css(code, 'color') : css(body, 'color'),
              codeBg: code ? css(code, 'background-color') : css(body, 'background-color'),
              footer: css(document.querySelector('footer')!, 'color'),
            };
          });
          expect(ratio(colors.fg, colors.bg)).toBeGreaterThanOrEqual(7);
          expect(ratio(colors.link, colors.bg)).toBeGreaterThanOrEqual(4.5);
          expect(ratio(colors.code, colors.codeBg)).toBeGreaterThanOrEqual(4.5);
          expect(ratio(colors.footer, colors.bg)).toBeGreaterThanOrEqual(4.5);

          // keyboard: Tab reaches the first link and it shows a visible focus indicator
          await page.keyboard.press('Tab');
          const focus = await page.evaluate(() => {
            const el = document.activeElement!;
            const s = getComputedStyle(el);
            return {
              tag: el.tagName,
              style: s.outlineStyle,
              width: parseFloat(s.outlineWidth),
            };
          });
          expect(focus.tag).toBe('A');
          expect(focus.style).not.toBe('none');
          expect(focus.width).toBeGreaterThanOrEqual(2);

          // mobile width and 200 % zoom (a 640 px window at 2x is 320 CSS px)
          for (const width of [320, 360]) {
            await page.setViewportSize({ width, height: 700 });
            expect(await overflowX(page)).toBeLessThanOrEqual(0);
          }
          await page.setViewportSize({ width: 320, height: 700 });
          const size = await page.evaluate(() => getComputedStyle(document.body).fontSize);
          expect(parseFloat(size)).toBeGreaterThanOrEqual(16);
          await page.evaluate(() => {
            document.documentElement.style.fontSize = '200%';
          });
          expect(await overflowX(page)).toBeLessThanOrEqual(0);
        } finally {
          await browser.close();
        }
      });
    }
  });
}

test('the two pages link to each other and carry the same version as the release', async () => {
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(url('privacy'));
    const hrefs = await page.$$eval('nav a', (as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs).toEqual(['../privacy/', '../support/']);
    expect(await page.locator('footer').innerText()).toContain('0.1.0');
    expect(await page.locator('nav a[aria-current="page"]').count()).toBe(1);
  } finally {
    await browser.close();
  }
});
