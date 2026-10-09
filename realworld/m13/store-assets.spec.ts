/**
 * M13 store assets (docs/store/REVIEWER_GUIDE.md, "Screenshots"): the Chrome Web Store screenshots (1280x800) and the
 * small promo tile (440x280), made from the REAL extension running in real Chrome on the controlled reviewer fixture
 * (docs/store/reviewer-fixture/index.html: no accounts, no personal data, no third-party content). Pictures are
 * screenshots of the product; the only drawing is a caption band and the layout that puts two of them side by side.
 *
 * Run: `pnpm release:assets` (after `pnpm build`). Writes `release/m13/assets/`. Not part of any test run.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, test, type Browser } from '@playwright/test';
import { ROOT, type ChromeTab } from '../lib/driver';
import { startFixtureServer } from '../lib/server';
import { SETTINGS_OFF, hasStylesheet, launch, until } from '../lib/scenario';
import { quiesce, tabIdOf } from '../m12/kit';
import { decodePng, toRgbPng } from './png';

const OUT = process.env['M13_ASSETS'] ?? path.join(ROOT, 'release', 'm13', 'assets');
const FIXTURE = readFileSync(
  path.join(ROOT, 'docs', 'store', 'reviewer-fixture', 'index.html'),
  'utf8',
);
const CHART = readFileSync(
  path.join(ROOT, 'docs', 'store', 'reviewer-fixture', 'chart.html'),
  'utf8',
);
const ICON = readFileSync(path.join(ROOT, 'assets', 'store', 'icon.svg'), 'utf8');
const data = (png: Buffer): string => `data:image/png;base64,${png.toString('base64')}`;

const FONT = `font-family: 'Segoe UI', system-ui, sans-serif;`;
const BAND = (text: string): string =>
  `<div style="height:56px;background:#1b2a49;color:#fff;display:flex;align-items:center;padding:0 28px;font-size:24px;font-weight:600;${FONT}">${text}</div>`;

async function compose(
  browser: Browser,
  width: number,
  height: number,
  body: string,
): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    await page.setContent(
      `<html><body style="margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#fff">${body}</body></html>`,
    );
    await page.evaluate(async () => {
      for (const image of document.images) {
        if (image.complete) continue;
        await new Promise((resolve) => {
          image.onload = resolve;
          image.onerror = resolve;
        });
      }
    });
    return toRgbPng(await page.screenshot({ type: 'png' }));
  } finally {
    await page.close();
  }
}

test('store assets from the real extension', async () => {
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });
  const server = await startFixtureServer();
  server.serve('sample', FIXTURE);
  server.serve('chart.html', CHART);
  const driver = await launch('chrome');
  const composer = await chromium.launch();
  const save = (name: string, png: Buffer): void => {
    const { width, height } = decodePng(png);
    writeFileSync(path.join(OUT, name), png);
    console.log(`wrote ${name} ${width}x${height}`);
  };
  try {
    const ON = { ...SETTINGS_OFF, enabled: true, adaptationStrength: 0.8 };
    const open = async (
      settings: Record<string, unknown>,
      size: { width: number; height: number },
    ) => {
      await driver.setSettings(settings);
      const tab = (await driver.newTab()) as ChromeTab;
      await tab.page.setViewportSize(size);
      await tab.open(`${server.origin}/sample`);
      if (settings['enabled'] === true) {
        await until(() => hasStylesheet(tab), 'the adaptation stylesheet', 30_000);
        await quiesce(tab);
        await tab.page.waitForTimeout(600);
      }
      return tab;
    };
    const closeAll = (): Promise<unknown> =>
      driver
        .extensionEval(
          `(async () => { const api = globalThis.browser ?? globalThis.chrome; for (const t of await api.tabs.query({})) if ((t.url || '').includes('/sample') || (t.url || '').includes('audit.html')) await api.tabs.remove(t.id).catch(() => null); })()`,
        )
        .catch(() => null);

    // 01 before / after, side by side
    let tab = await open({ ...SETTINGS_OFF, enabled: false }, { width: 640, height: 744 });
    const before = await tab.screenshot();
    await closeAll();
    tab = await open(ON, { width: 640, height: 744 });
    const after = await tab.screenshot();
    save(
      'screenshot-01.png',
      await compose(
        composer,
        1280,
        800,
        `<div style="display:flex;height:800px">
           <div style="width:640px"><div style="${FONT}height:56px;background:#4a5568;color:#fff;font-size:22px;display:flex;align-items:center;padding:0 24px">Original page</div><img src="${data(before)}" style="display:block"></div>
           <div style="width:640px"><div style="${FONT}height:56px;background:#1b2a49;color:#fff;font-size:22px;display:flex;align-items:center;padding:0 24px">With ColorAdapt (deuteranopia profile)</div><img src="${data(after)}" style="display:block"></div>
         </div>`,
      ),
    );
    const afterCrop = after;
    const beforeCrop = before;
    await closeAll();

    // 03 semantic cues and 04 charts: the adapted page at full width
    tab = await open(ON, { width: 1280, height: 744 });
    const top = await tab.screenshot();
    save(
      'screenshot-03.png',
      await compose(
        composer,
        1280,
        800,
        `${BAND('Small non-color cues where color alone carried a state')}<img src="${data(top)}" style="display:block">`,
      ),
    );
    const chartTab = (await driver.newTab()) as ChromeTab;
    await chartTab.page.setViewportSize({ width: 1280, height: 744 });
    await chartTab.open(`${server.origin}/chart.html`);
    await until(() => hasStylesheet(chartTab), 'the adaptation stylesheet', 30_000);
    await quiesce(chartTab);
    await chartTab.page.waitForTimeout(1200);
    const chart = await chartTab.screenshot();
    save(
      'screenshot-04.png',
      await compose(
        composer,
        1280,
        800,
        `${BAND('Chart series told apart by line style, not only by color')}<img src="${data(chart)}" style="display:block">`,
      ),
    );

    // 02 the popup over the adapted page
    const popup = (await driver.extensionTab('popup.html')) as ChromeTab;
    await popup.page.setViewportSize({ width: 360, height: 700 });
    await popup.page.reload();
    await popup.page.waitForSelector('main.popup');
    await popup.page.waitForTimeout(500);
    const card = await popup.page.locator('main.popup').screenshot({ type: 'png' });
    const cardSize = decodePng(card);
    save(
      'screenshot-02.png',
      await compose(
        composer,
        1280,
        800,
        `${BAND('Pick the color-vision profile that matches you')}
         <div style="position:relative;height:744px;overflow:hidden"><img src="${data(top)}" style="display:block;filter:brightness(0.55)">
           <img src="${data(card)}" style="position:absolute;right:56px;top:28px;width:${Math.round(cardSize.width * 1.6)}px;box-shadow:0 18px 48px rgba(0,0,0,.45);border-radius:8px"></div>`,
      ),
    );
    await popup.close();

    // 05 developer audit with the optional AI panel (off by default)
    const tabId = await until(() => tabIdOf(driver, '/sample').catch(() => null), 'the page tab');
    const audit = (await driver.extensionTab(`audit.html?tabId=${tabId}`)) as ChromeTab;
    await audit.page.setViewportSize({ width: 1280, height: 744 });
    await until(
      () => audit.evaluate<boolean>(`!!document.querySelector('[data-testid="summary-line"]')`),
      'audit summary',
      30_000,
    );
    await audit.page.waitForTimeout(500);
    // the AI panel's heading a little below the top edge, so no table row is cut by the caption band
    await audit.page.evaluate(() => {
      const heading = document.getElementById('assist-heading');
      if (heading) window.scrollTo(0, heading.getBoundingClientRect().top + window.scrollY - 150);
    });
    await audit.page.waitForTimeout(400);
    const auditShot = await audit.screenshot();
    save(
      'screenshot-05.png',
      await compose(
        composer,
        1280,
        800,
        `${BAND('Developer audit, and the optional local AI-assisted review (off by default)')}<img src="${data(auditShot)}" style="display:block">`,
      ),
    );
    await closeAll();

    // promo tile 440x280
    save(
      'promo-440x280.png',
      await compose(
        composer,
        440,
        280,
        `<div style="${FONT}width:440px;height:280px;background:#1b2a49;color:#fff;position:relative">
           <div style="position:absolute;left:28px;top:30px;width:84px;height:84px">${ICON.replace(/width="128" height="128"/, 'width="84" height="84"')}</div>
           <div style="position:absolute;left:128px;top:36px;font-size:36px;font-weight:700">ColorAdapt</div>
           <div style="position:absolute;left:128px;top:86px;font-size:17px;line-height:1.3;width:290px;color:#dfe6f3">Tell colors apart on the web</div>
           <div style="position:absolute;left:28px;right:28px;top:140px;height:112px;display:flex;gap:12px">
             <div style="flex:1;overflow:hidden;border-radius:6px;background:#fff;position:relative"><img src="${data(beforeCrop)}" style="position:absolute;left:-14px;top:-62px;width:640px"><span style="position:absolute;left:6px;bottom:6px;background:#4a5568;font-size:12px;padding:1px 6px;border-radius:3px">Before</span></div>
             <div style="flex:1;overflow:hidden;border-radius:6px;background:#fff;position:relative"><img src="${data(afterCrop)}" style="position:absolute;left:-14px;top:-62px;width:640px"><span style="position:absolute;left:6px;bottom:6px;background:#2f5da8;font-size:12px;padding:1px 6px;border-radius:3px">After</span></div>
           </div>
         </div>`,
      ),
    );
  } finally {
    await composer.close();
    await driver.close();
    await server.close();
  }
});
