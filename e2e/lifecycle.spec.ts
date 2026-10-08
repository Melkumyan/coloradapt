import { expect, test, type Page } from '@playwright/test';
import type { AdaptationPlan, UserSettings, VisionProfile } from '../src/domain/models';
import {
  allIds,
  computedColors,
  disable,
  enable,
  hasStylesheet,
  hexToRgb,
  launchExtension,
  plannedColors,
  refresh,
  sendToPage,
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
// One tab per test: messages address a tab by URL, so stale tabs must not linger.
test.afterEach(async () => {
  await Promise.all(ext.context.pages().map((page) => page.close()));
});
test.afterAll(async () => {
  await ext.close();
  await server.close();
});

type Overrides = Partial<UserSettings>;

/** Opens `basic.html` with ColorAdapt switched off so the first state is the pristine page. */
async function openPristine(settings: Overrides): Promise<Page> {
  await setSettings(ext.worker, { ...settings, enabled: false });
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/basic.html`);
  return page;
}

async function configure(settings: Overrides): Promise<void> {
  await setSettings(ext.worker, { enabled: true, adaptationStrength: 1, ...settings });
}

/** The browser must show exactly what the plan says, for every planned change. */
async function expectPlanAppliedInBrowser(page: Page, plan: AdaptationPlan): Promise<void> {
  const planned = await plannedColors(page, plan);
  const actual = await computedColors(page, Object.keys(planned));
  expect(actual).toEqual(planned);
}

test.describe('real browser: adaptation lifecycle', () => {
  test('A. red/green conflict: ON changes the computed color, OFF restores it exactly', async () => {
    const page = await openPristine({ visionProfile: 'deuteranopia' });
    const ids = await allIds(page);
    const pristine = await computedColors(page, ids);
    expect(pristine['conflict']).toBe(hexToRgb('#c0392b'));

    await configure({ visionProfile: 'deuteranopia' });
    const plan = await enable(ext.worker, page);
    await settle(page);

    expect(plan.summary.adapted).toBeGreaterThan(0);
    expect(plan.summary.notApplied).toBe(0);
    const adapted = await computedColors(page, ids);
    expect(adapted['conflict']).not.toBe(pristine['conflict']);
    await expectPlanAppliedInBrowser(page, plan);

    await disable(ext.worker, page);
    await settle(page);
    expect(await hasStylesheet(page)).toBe(false);
    expect(await computedColors(page, ids)).toEqual(pristine);
  });

  test('B. accessible pair is never changed', async () => {
    const page = await openPristine({ visionProfile: 'deuteranopia' });
    const pristine = await computedColors(page, ['accessible', 'white-on-dark']);

    await configure({ visionProfile: 'deuteranopia' });
    const plan = await enable(ext.worker, page);
    await settle(page);

    expect(await computedColors(page, ['accessible', 'white-on-dark'])).toEqual(pristine);
    expect(Object.keys(await plannedColors(page, plan))).not.toContain('accessible');
    expect(Object.keys(await plannedColors(page, plan))).not.toContain('white-on-dark');
  });

  test('C. five ON/OFF cycles restore the original computed styles every time', async () => {
    const page = await openPristine({ visionProfile: 'deuteranopia' });
    const ids = await allIds(page);
    const pristine = await computedColors(page, ids);
    const pristineHtml = await page.evaluate(() =>
      document.body.outerHTML.replace(/ data-coloradapt-(id|s)="[^"]*"/g, ''),
    );

    await configure({ visionProfile: 'deuteranopia' });
    let firstAdapted: Record<string, string> | null = null;
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const plan = await enable(ext.worker, page);
      await settle(page);
      await expectPlanAppliedInBrowser(page, plan);
      const adapted = await computedColors(page, ids);
      firstAdapted ??= adapted;
      expect(adapted).toEqual(firstAdapted);

      await disable(ext.worker, page);
      await settle(page);
      expect(await hasStylesheet(page)).toBe(false);
      expect(await computedColors(page, ids)).toEqual(pristine);
    }
    // Apart from the targeting attribute, the page DOM is untouched.
    expect(
      await page.evaluate(() =>
        document.body.outerHTML.replace(/ data-coloradapt-(id|s)="[^"]*"/g, ''),
      ),
    ).toBe(pristineHtml);
  });

  test('D. repeated analysis and refresh never drift', async () => {
    const page = await openPristine({ visionProfile: 'deuteranopia' });
    const ids = await allIds(page);
    await configure({ visionProfile: 'deuteranopia' });

    const first = await enable(ext.worker, page);
    await settle(page);
    const firstColors = await computedColors(page, ids);
    const firstPlanned = await plannedColors(page, first);

    for (let i = 0; i < 4; i += 1) {
      await sendToPage(ext.worker, page, 'ANALYZE_PAGE');
      await settle(page);
      expect(await computedColors(page, ids)).toEqual(firstColors);

      const plan = await refresh(ext.worker, page);
      await settle(page);
      expect(await computedColors(page, ids)).toEqual(firstColors);
      expect(await plannedColors(page, plan)).toEqual(firstPlanned);
      expect(plan.changes.map((c) => [c.originalValue, c.adaptedValue])).toEqual(
        first.changes.map((c) => [c.originalValue, c.adaptedValue]),
      );
    }
  });

  test('E. profile changes re-plan from the original styles without accumulating', async () => {
    const profiles: VisionProfile[] = ['protanopia', 'deuteranopia', 'tritanopia'];
    const expected: Record<string, Record<string, string>> = {};

    // Reference: each profile on its own fresh page.
    for (const profile of profiles) {
      const fresh = await openPristine({ visionProfile: profile });
      await configure({ visionProfile: profile });
      await enable(ext.worker, fresh);
      await settle(fresh);
      expected[profile] = await computedColors(fresh, await allIds(fresh));
      await fresh.close();
    }
    expect(new Set(profiles.map((p) => JSON.stringify(expected[p]))).size).toBeGreaterThan(1);

    // Same sequence on a single page, twice over, switching via REFRESH.
    const page = await openPristine({ visionProfile: 'protanopia' });
    const ids = await allIds(page);
    const pristine = await computedColors(page, ids);
    await configure({ visionProfile: 'protanopia' });
    await enable(ext.worker, page);
    for (const profile of [...profiles, ...profiles, 'protanopia' as const]) {
      await configure({ visionProfile: profile });
      const plan = await refresh(ext.worker, page);
      await settle(page);
      expect(plan.profile).toBe(profile);
      await expectPlanAppliedInBrowser(page, plan);
      expect(await computedColors(page, ids)).toEqual(expected[profile]);
    }
    await disable(ext.worker, page);
    await settle(page);
    expect(await computedColors(page, ids)).toEqual(pristine);
  });

  test('F. strength 0 / 0.5 / 1 in the browser; moving between them never accumulates', async () => {
    const reference: Record<number, Record<string, string>> = {};
    const strengths = [0, 0.5, 1];
    for (const strength of strengths) {
      const fresh = await openPristine({ visionProfile: 'deuteranopia' });
      await configure({ visionProfile: 'deuteranopia', adaptationStrength: strength });
      const plan = await enable(ext.worker, fresh);
      await settle(fresh);
      reference[strength] = await computedColors(fresh, await allIds(fresh));
      await expectPlanAppliedInBrowser(fresh, plan);
      if (strength === 0) expect(plan.changes).toHaveLength(0);
      await fresh.close();
    }
    const pristine = reference[0]!;
    expect(reference[1]!['conflict']).not.toBe(pristine['conflict']);
    expect(reference[0.5]!['conflict']).not.toBe(pristine['conflict']);
    expect(reference[0.5]!['conflict']).not.toBe(reference[1]!['conflict']);

    const page = await openPristine({ visionProfile: 'deuteranopia' });
    const ids = await allIds(page);
    await configure({ visionProfile: 'deuteranopia', adaptationStrength: 1 });
    await enable(ext.worker, page);
    for (const strength of [0.5, 0, 1, 0.5, 1, 0]) {
      await configure({ visionProfile: 'deuteranopia', adaptationStrength: strength });
      await refresh(ext.worker, page);
      await settle(page);
      expect(await computedColors(page, ids)).toEqual(reference[strength]);
    }
  });

  test('G. every vision profile reports its model confidence end to end', async () => {
    const expectedConfidence: Record<string, string> = {
      protanopia: 'SUPPORTED_MODEL',
      deuteranopia: 'SUPPORTED_MODEL',
      tritanopia: 'SUPPORTED_MODEL',
      protanomaly: 'MODEL_ASSUMPTION',
      deuteranomaly: 'MODEL_ASSUMPTION',
      tritanomaly: 'APPROXIMATION',
      custom: 'UNSUPPORTED',
    };
    const page = await openPristine({ visionProfile: 'protanopia' });
    for (const [profile, confidence] of Object.entries(expectedConfidence)) {
      await configure({ visionProfile: profile as VisionProfile });
      const plan = await enable(ext.worker, page);
      await settle(page);
      expect(plan.confidence).toBe(confidence);
      for (const change of plan.changes) expect(change.confidence).toBe(confidence);
      if (confidence === 'UNSUPPORTED') {
        expect(plan.changes).toHaveLength(0);
        expect(await hasStylesheet(page)).toBe(false);
      }
    }
  });

  test('H. site settings: disabled site, overridden profile and overridden strength', async () => {
    const host = new URL(server.origin).hostname;
    const site = (overrides: Record<string, unknown>) => ({
      hostname: host,
      enabled: true,
      visionProfile: 'deuteranopia',
      intensity: 1,
      adaptUI: true,
      ...overrides,
    });
    const run = async (settings: Record<string, unknown>): Promise<AdaptationPlan> => {
      await setSettings(ext.worker, { visionProfile: 'normal', ...settings, enabled: true });
      const page = await ext.context.newPage();
      await page.goto(`${server.origin}/basic.html`);
      try {
        return await enable(ext.worker, page);
      } finally {
        await page.close();
      }
    };

    const global = await run({ adaptationStrength: 1, visionProfile: 'deuteranopia' });
    expect(global.changes.length).toBeGreaterThan(0);

    // Site disabled -> nothing, whatever the global settings say.
    const disabledSite = await run({
      visionProfile: 'deuteranopia',
      siteOverrides: { [host]: site({ enabled: false }) },
    });
    expect(disabledSite.changes).toHaveLength(0);

    // Site profile overrides the (normal) global profile.
    const profileOverride = await run({ siteOverrides: { [host]: site({}) } });
    expect(profileOverride.profile).toBe('deuteranopia');
    expect(profileOverride.changes.length).toBeGreaterThan(0);

    // Site strength overrides the global strength.
    const strengthOverride = await run({
      adaptationStrength: 1,
      siteOverrides: { [host]: site({ intensity: 0.5 }) },
    });
    expect(strengthOverride.strength).toBe(0.5);
    expect(strengthOverride.changes.map((c) => c.adaptedValue)).not.toEqual(
      profileOverride.changes.map((c) => c.adaptedValue),
    );
  });

  test('I. reload restores the correct adaptation from stored settings', async () => {
    await setSettings(ext.worker, {
      enabled: true,
      visionProfile: 'deuteranopia',
      adaptationStrength: 1,
    });
    const page = await ext.context.newPage();
    await page.goto(`${server.origin}/basic.html`);
    await expect.poll(() => hasStylesheet(page)).toBe(true);
    const ids = await allIds(page);
    await settle(page);
    const adapted = await computedColors(page, ids);
    expect(adapted['conflict']).not.toBe(hexToRgb('#c0392b'));

    await page.reload();
    await expect.poll(() => hasStylesheet(page)).toBe(true);
    await settle(page);
    expect(await computedColors(page, ids)).toEqual(adapted);

    // Settings changed while the page is closed take effect on the next load.
    await setSettings(ext.worker, { enabled: false, visionProfile: 'deuteranopia' });
    await page.reload();
    await settle(page);
    expect(await hasStylesheet(page)).toBe(false);
    expect((await computedColors(page, ids))['conflict']).toBe(hexToRgb('#c0392b'));
  });
});
