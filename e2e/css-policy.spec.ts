import { expect, test, type Page } from '@playwright/test';
import type { AdaptationPlan } from '../src/domain/models';
import {
  allIds,
  computedColors,
  disable,
  enable,
  hexToRgb,
  launchExtension,
  plannedColors,
  sendToPage,
  setSettings,
  settle,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';

/**
 * CSS application policy, verified against the real cascade
 * (docs/ADAPTATION_ENGINE.md, "CSS application policy"). Every case on
 * `css-cases.html` is a red-on-green conflict that deuteranopia adapts.
 */
const ORIGINAL = hexToRgb('#c0392b');

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

interface Loaded {
  readonly page: Page;
  readonly ids: string[];
  readonly pristine: Record<string, string>;
}

async function load(): Promise<Loaded> {
  await setSettings(ext.worker, { enabled: false, visionProfile: 'deuteranopia' });
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/css-cases.html`);
  const ids = await allIds(page);
  const pristine = await computedColors(page, ids);
  await setSettings(ext.worker, {
    enabled: true,
    visionProfile: 'deuteranopia',
    adaptationStrength: 1,
  });
  return { page, ids, pristine };
}

async function adaptAll(): Promise<
  Loaded & { plan: AdaptationPlan; planned: Record<string, string> }
> {
  const loaded = await load();
  const plan = await enable(ext.worker, loaded.page);
  const planned = await plannedColors(loaded.page, plan);
  return { ...loaded, plan, planned };
}

test.describe('real browser: CSS application policy', () => {
  test('the browser shows exactly what the plan says, for every element on the page', async () => {
    const { page, ids, pristine, plan, planned } = await adaptAll();
    await settle(page);
    const actual = await computedColors(page, ids);

    expect(Object.keys(planned).length).toBe(plan.changes.length);
    // Elements with an animated `color` are skipped by design and legitimately keep moving.
    const animated = new Set(['anim', 'anim-child']);
    for (const id of ids.filter((x) => !animated.has(x))) {
      // ADAPTED in the plan <=> that exact color in the browser; otherwise untouched.
      expect(actual[id], id).toBe(planned[id] ?? pristine[id]);
    }
  });

  test('specificity: class, id, selector chains and plain inline styles are all adapted', async () => {
    const { page, plan, planned, pristine } = await adaptAll();
    await settle(page);
    const ids = ['spec-class', 'spec-id', 'spec-chain', 'spec-id-inner', 'spec-inline'];
    const actual = await computedColors(page, ids);

    for (const id of ids) {
      expect(pristine[id], id).toBe(ORIGINAL);
      expect(planned[id], id).toBeDefined();
      expect(actual[id], id).toBe(planned[id]);
    }
    expect(plan.summary.notApplied).toBe(2);
  });

  test('the injected stylesheet carries no blanket rules and only targets tagged elements', async () => {
    const { page } = await adaptAll();
    const css = await page.evaluate(
      () => document.getElementById('coloradapt-stylesheet')?.textContent ?? '',
    );
    const rules = css.split('\n').filter(Boolean);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule).toMatch(
        /^\[data-coloradapt-id="[^"]+"\]:not\(#coloradapt-specificity\) \{ color: #[0-9a-f]{6} !important; \}$/,
      );
    }
    expect(css).not.toContain('transition');
  });

  test('existing !important: adapted when the cascade allows, otherwise reported as not applied', async () => {
    const { page, plan, planned, pristine } = await adaptAll();
    await settle(page);
    const actual = await computedColors(page, [
      'imp-class',
      'imp-id',
      'imp-id-inner',
      'imp-inline',
    ]);

    // A class or single-id !important rule is out-ranked by the adaptation.
    for (const id of ['imp-class', 'imp-id']) {
      expect(planned[id], id).toBeDefined();
      expect(actual[id], id).toBe(planned[id]);
    }
    // An id-chain or inline !important wins the cascade: never reported as adapted.
    for (const id of ['imp-id-inner', 'imp-inline']) {
      expect(planned[id], id).toBeUndefined();
      expect(actual[id], id).toBe(pristine[id]);
    }
    expect(plan.summary.notApplied).toBe(2);
    expect(plan.summary.adapted).toBe(plan.changes.length);
  });

  test('transitions: no fade-in, no fade-out, no flicker on re-analysis, nothing left mutated', async () => {
    const { page, plan, planned, pristine } = await adaptAll();
    expect(plan.changes.length).toBeGreaterThan(0);
    const adapted = planned['trans']!;
    expect(adapted).toBeDefined();

    // Right after ON resolves — no settle — the final color is already in effect.
    expect((await computedColors(page, ['trans']))['trans']).toBe(adapted);

    // Record the color on every frame while re-analysing and refreshing.
    await page.evaluate(() => {
      const el = document.getElementById('trans')!;
      const w = window as unknown as { __rec: { samples: string[]; stop: boolean } };
      w.__rec = { samples: [], stop: false };
      const tick = (): void => {
        w.__rec.samples.push(getComputedStyle(el).color);
        if (!w.__rec.stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    for (let i = 0; i < 3; i += 1) {
      await sendToPage(ext.worker, page, 'ANALYZE_PAGE');
      await sendToPage(ext.worker, page, 'REFRESH_ADAPTATION');
      await settle(page);
    }
    await disable(ext.worker, page);
    // Right after OFF resolves the original is back immediately.
    expect((await computedColors(page, ['trans']))['trans']).toBe(pristine['trans']);
    await settle(page);
    const samples = await page.evaluate(() => {
      const w = window as unknown as { __rec: { samples: string[]; stop: boolean } };
      w.__rec.stop = true;
      return w.__rec.samples;
    });

    expect(samples.length).toBeGreaterThan(5);
    // Only the original and the adapted color ever painted: no intermediate fade value.
    expect([...new Set(samples)].sort()).toEqual([adapted, pristine['trans']!].sort());

    // The page's own transition is unchanged and no transition animation remains.
    const transition = await page.evaluate(() => {
      const style = getComputedStyle(document.getElementById('trans')!);
      return {
        property: style.transitionProperty,
        duration: style.transitionDuration,
        running: document.getAnimations().filter((a) => a instanceof CSSTransition).length,
      };
    });
    expect(transition).toEqual({ property: 'color', duration: '0.4s', running: 0 });
  });

  test('animations: color animations are skipped and keep running; other animations are adapted', async () => {
    const { page, plan, planned } = await adaptAll();
    await settle(page);
    const before = await page.evaluate(() =>
      document
        .getAnimations()
        .map((a) => (a as CSSAnimation).animationName)
        .sort(),
    );

    // Animated `color` (own or inherited): not adapted, so the page's animation is not frozen.
    expect(planned['anim']).toBeUndefined();
    expect(planned['anim-child']).toBeUndefined();
    expect(plan.summary.unresolved).toBeGreaterThanOrEqual(2);
    // An animation that does not touch `color` does not prevent adaptation.
    expect(planned['anim-unrelated']).toBeDefined();
    expect((await computedColors(page, ['anim-unrelated']))['anim-unrelated']).toBe(
      planned['anim-unrelated'],
    );

    // The color animation really is still running and still moving the color.
    expect(before).toContain('pulse');
    const a = (await computedColors(page, ['anim']))['anim'];
    expect(a).toMatch(/^rgb\(192, 57, 4[23]\)$/);

    await disable(ext.worker, page);
    await settle(page);
    const after = await page.evaluate(() =>
      document
        .getAnimations()
        .map((x) => (x as CSSAnimation).animationName)
        .sort(),
    );
    expect(after).toEqual(before);
  });

  test('pseudo-states: the adapted color persists on :hover / :focus / :active; OFF restores them', async () => {
    const { page, planned, pristine } = await adaptAll();
    await settle(page);

    // Documented behavior: the adaptation is !important, so a page's own
    // :hover/:focus/:active `color` rule does not override it.
    await page.hover('#hov-color');
    await settle(page);
    expect((await computedColors(page, ['hov-color']))['hov-color']).toBe(planned['hov-color']);

    await page.focus('#foc-color');
    await settle(page);
    expect((await computedColors(page, ['foc-color']))['foc-color']).toBe(planned['foc-color']);

    await page.hover('#act-color');
    await page.mouse.down();
    await settle(page);
    expect(await page.evaluate(() => document.querySelector('#act-color:active') !== null)).toBe(
      true,
    );
    expect((await computedColors(page, ['act-color']))['act-color']).toBe(planned['act-color']);
    await page.mouse.up();

    // With ColorAdapt OFF the page's own state colors are back, exactly.
    await disable(ext.worker, page);
    await page.hover('#hov-color');
    await settle(page);
    expect((await computedColors(page, ['hov-color']))['hov-color']).toBe(hexToRgb('#0000ff'));
    await page.focus('#foc-color');
    await settle(page);
    expect((await computedColors(page, ['foc-color']))['foc-color']).toBe(hexToRgb('#0000ff'));
    await page.mouse.move(0, 0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await settle(page);
    expect(await computedColors(page, ['hov-color', 'foc-color'])).toEqual({
      'hov-color': pristine['hov-color'],
      'foc-color': pristine['foc-color'],
    });
  });

  test('opacity guard: effective foreground differs from computed color -> skipped, never double-adapted', async () => {
    const { page, planned, pristine } = await adaptAll();
    await settle(page);

    for (const id of ['op-self', 'op-parent', 'op-nested', 'op-rgba']) {
      expect(planned[id], id).toBeUndefined();
      expect((await computedColors(page, [id]))[id], id).toBe(pristine[id]);
    }
    // Fully opaque cases are not falsely skipped.
    for (const id of ['op-one', 'op-rgba-one']) {
      expect(planned[id], id).toBeDefined();
      expect((await computedColors(page, [id]))[id], id).toBe(planned[id]);
    }
  });
});
