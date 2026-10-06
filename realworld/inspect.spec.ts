/**
 * Investigation tool: opens one corpus page (`RW_INSPECT=<id>`, `RW_BROWSER`), waits as the crawl does, and
 * prints the JSON result of the script in `RW_INSPECT_JS` (a file holding one JS expression, run in the page).
 * Read-only; writes nothing.
 */
import { test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { CORPUS } from './corpus';
import { startBrowser, type BrowserName } from './lib/driver';
import { sleep } from './lib/page-run';

const id = process.env['RW_INSPECT'];
const file = process.env['RW_INSPECT_JS'];

test('inspect', async () => {
  test.skip(!id || !file, 'RW_INSPECT and RW_INSPECT_JS are required');
  const entry = CORPUS.find((e) => e.id === id)!;
  const driver = await startBrowser((process.env['RW_BROWSER'] ?? 'chrome') as BrowserName);
  try {
    const tab = await driver.newTab();
    await tab.open(entry.url);
    await sleep(Number(process.env['RW_SETTLE'] ?? '6000'));
    const result = await tab.evaluate<unknown>(readFileSync(file!, 'utf8'));
    console.log(`INSPECT ${JSON.stringify(result, null, 1)}`);
    await tab.close();
  } finally {
    await driver.close();
  }
});
