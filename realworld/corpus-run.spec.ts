/**
 * Runs the corpus through one real browser (`RW_BROWSER=chrome|firefox`, default chrome) and writes one JSON per
 * page to `realworld/.artifacts/<browser>/`. A page that is already done is skipped (`RW_FORCE=1` redoes it).
 * `RW_OUT=name` writes to `.artifacts/<name>/` instead. `RW_ONLY=id1,id2` or a category name selects pages, `RW_LIMIT=n` caps the count.
 *
 * This is a data-collection run with only *harness-level* assertions (the page survived the extension, the
 * measurement completed). What the measurements mean is decided afterwards by `judge.spec.ts`, from the data.
 */
import { test } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CORPUS } from './corpus';
import { startBrowser, ROOT, type BrowserName, type Driver } from './lib/driver';
import { analyzePage } from './lib/page-run';

const browserName = (process.env['RW_BROWSER'] ?? 'chrome') as BrowserName;
const only = (process.env['RW_ONLY'] ?? '').split(',').filter(Boolean);
const limit = Number(process.env['RW_LIMIT'] ?? '0') || Infinity;
const force = process.env['RW_FORCE'] === '1';
// RW_OUT keeps a repeat run (or one on changed code) next to the earlier one instead of over it
const outDir = path.join(ROOT, 'realworld', '.artifacts', process.env['RW_OUT'] ?? browserName);
const RESTART_EVERY = 20;

const selected = CORPUS.filter(
  (e) => only.length === 0 || only.includes(e.id) || only.includes(e.category),
).slice(0, limit);

test.describe.configure({ mode: 'serial' });

let driver: Driver | null = null;
let served = 0;

test.beforeAll(() => {
  mkdirSync(outDir, { recursive: true });
});
test.afterAll(async () => {
  await driver?.close();
});

for (const entry of selected) {
  test(`${browserName} ${entry.id}`, async () => {
    const file = path.join(outDir, `${entry.id}.json`);
    if (!force && existsSync(file)) test.skip(true, 'already measured');
    if (driver && served >= RESTART_EVERY) {
      await driver.close();
      driver = null;
      served = 0;
    }
    driver ??= await startBrowser(browserName);
    served++;
    const tab = await driver.newTab();
    try {
      const measure = () =>
        analyzePage(driver!, tab, entry, {
          shotsDir:
            process.env['RW_SHOTS'] === '1'
              ? path.join(ROOT, 'realworld', '.artifacts', 'shots', browserName)
              : undefined,
        });
      let result = await measure();
      // a document that replaced itself while it was measured (a reload into the real page) is measured again,
      // once; if it still moves, the result says so (`documentStable: false`) and the comparison skips it
      if (result.documentStable === false) result = await measure();
      writeFileSync(file, JSON.stringify(result));
    } finally {
      await tab.close();
    }
  });
}
