#!/usr/bin/env node
/**
 * Renders the extension icons (public/icon-<size>.png, picked up by WXT as the manifest `icons`) from the
 * single source drawing assets/store/icon.svg. Run it only when the drawing changes; the PNGs are committed
 * sources, so a normal build never needs a browser.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const svg = readFileSync(path.join(ROOT, 'assets', 'store', 'icon.svg'), 'utf8');
const out = path.join(ROOT, 'public');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
try {
  for (const size of [16, 32, 48, 96, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px">${svg.replace(
        /width="128" height="128"/,
        `width="${size}" height="${size}"`,
      )}</div></body></html>`,
    );
    const png = await page.screenshot({ omitBackground: true, type: 'png' });
    writeFileSync(path.join(out, `icon-${size}.png`), png);
    await page.close();
  }
} finally {
  await browser.close();
}

// The store icon (Chrome guideline: 96 px artwork inside 128 px with 16 px of transparent padding).
{
  const page = await (await chromium.launch()).newPage({ viewport: { width: 128, height: 128 } });
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><div style="position:absolute;left:16px;top:16px">${svg.replace(/width="128" height="128"/, 'width="96" height="96"')}</div></body></html>`,
  );
  writeFileSync(
    path.join(ROOT, 'assets', 'store', 'store-icon-128.png'),
    await page.screenshot({ omitBackground: true, type: 'png' }),
  );
  await page.context().browser().close();
}
console.log('icons written to', out);
