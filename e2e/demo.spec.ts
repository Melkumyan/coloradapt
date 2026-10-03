import { expect, test, type Page } from '@playwright/test';
import {
  allIds,
  computedColors,
  disable,
  enable,
  launchExtension,
  plannedColors,
  setSettings,
  settle,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';

let server: PageServer;
let ext: ExtensionSession;

test.beforeAll(async () => {
  server = await startPageServer();
  ext = await launchExtension();
});
test.afterEach(async () => {
  await Promise.all(ext.context.pages().map((page) => page.close()));
});
test.afterAll(async () => {
  await ext.close();
  await server.close();
});

async function openDemo(profile: string): Promise<Page> {
  await setSettings(ext.worker, { enabled: false, visionProfile: profile });
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/demo.html`);
  await setSettings(ext.worker, {
    enabled: true,
    visionProfile: profile,
    adaptationStrength: 1,
  });
  return page;
}

test.describe('real browser: demo page', () => {
  for (const profile of ['protanopia', 'deuteranopia', 'tritanopia', 'deuteranomaly']) {
    test(`${profile}: the browser matches the plan everywhere and OFF restores the page`, async () => {
      const page = await openDemo(profile);
      const ids = await allIds(page);
      const pristine = await computedColors(page, ids);

      // Informational only (never a pass/fail threshold): analysis + adaptation time here.
      const startedAt = Date.now();
      const plan = await enable(ext.worker, page);
      const elapsedMs = Date.now() - startedAt;
      await settle(page);
      test.info().annotations.push({
        type: 'perf-diagnostic',
        description: `${profile}: enable round-trip ${elapsedMs} ms, ${plan.changes.length} changes`,
      });

      expect(plan.summary.notApplied).toBe(0);
      const planned = await plannedColors(page, plan);
      const adapted = await computedColors(page, ids);
      for (const id of ids.filter((x) => x !== '')) {
        expect(adapted[id], id).toBe(planned[id] ?? pristine[id]);
      }

      await disable(ext.worker, page);
      await settle(page);
      expect(await computedColors(page, ids)).toEqual(pristine);
    });
  }
});
