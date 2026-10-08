import { expect, test, type Page } from '@playwright/test';
import type { AdaptationPlan, SvgUnsupportedReason } from '../src/domain/models';
import {
  computedColors,
  disable,
  enable,
  launchExtension,
  refresh,
  settle,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';
import {
  RED,
  adapt,
  expectOnlyOwnRules,
  openPristine,
  paints,
  pixelAt,
  plannedByOwner,
  sheetRules,
  sheetText,
  svgUnits,
} from './svg-kit';

/**
 * M5 in a real browser: every claim is read back from `getComputedStyle` or from
 * rendered pixels, never from the plan alone (docs/SVG_ANALYSIS.md).
 */
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
  readonly plan: AdaptationPlan;
  readonly planned: Awaited<ReturnType<typeof plannedByOwner>>;
}

async function loadCases(): Promise<Loaded> {
  const page = await openPristine(ext, server, 'svg-cases.html');
  const plan = await adapt(ext, page);
  return { page, plan, planned: await plannedByOwner(page, plan) };
}

/** `[svg id, shape ids, property]` — one single-paint SVG each, red on green. */
const ADAPTED: ReadonlyArray<readonly [string, readonly string[], 'fill' | 'stroke']> = [
  ['fill-attr', ['fill-attr-p'], 'fill'],
  ['stroke-attr', ['stroke-attr-p'], 'stroke'],
  ['fill-stroke', ['fill-stroke-p'], 'fill'],
  ['fill-stroke', ['fill-stroke-p'], 'stroke'],
  ['inherit-svg', ['inherit-p'], 'fill'],
  ['group-svg', ['group-p1', 'group-p2'], 'fill'],
  ['two-shapes-same', ['two-a', 'two-b'], 'fill'],
  ['cc-fill', ['cc-fill-p'], 'fill'],
  ['cc-stroke', ['cc-stroke-p'], 'stroke'],
  ['cc-only', ['cc-only-p'], 'fill'],
  ['cc-css', ['cc-css-p'], 'fill'],
  ['cc-root-stroke', ['cc-root-stroke-p'], 'stroke'],
  ['cc-root-fill', ['cc-root-fill-p'], 'fill'],
  ['cc-ancestor-svg', ['cc-ancestor-p'], 'fill'],
  ['cc-both', ['cc-both-p'], 'fill'],
  ['cc-both', ['cc-both-p'], 'stroke'],
  ['cc-local', ['cc-local-p'], 'fill'],
  ['svg-text', ['svg-text-t'], 'fill'],
  ['svg-tspan', ['svg-tspan-s'], 'fill'],
  ['svg-text-cc', ['svg-text-cc-t'], 'fill'],
  ['decorative', ['decorative-p'], 'fill'],
  ['labelled', ['labelled-p'], 'fill'],
  ['u-clip', ['u-clip-p'], 'fill'],
  ['sp-class-svg', ['sp-class-p'], 'fill'],
  ['sp-id-svg', ['sp-id-p'], 'fill'],
  ['sp-chain-svg', ['sp-chain-p'], 'fill'],
  ['sp-inline-svg', ['sp-inline-p'], 'fill'],
  ['sp-stroke-class-svg', ['sp-stroke-class-p'], 'stroke'],
  ['sp-stroke-id-svg', ['sp-stroke-id-p'], 'stroke'],
  ['imp-class-svg', ['imp-class-p'], 'fill'],
  ['imp-id-svg', ['imp-id-p'], 'fill'],
  ['imp-stroke-class-svg', ['imp-stroke-class-p'], 'stroke'],
  ['inline-stroke-svg', ['inline-stroke-p'], 'stroke'],
];

/** SVGs that are classified and left exactly as they were, with the reason. */
const UNSUPPORTED: ReadonlyArray<
  readonly [string, string, 'fill' | 'stroke', SvgUnsupportedReason]
> = [
  ['u-gradient', 'u-gradient-p', 'fill', 'paint-gradient'],
  ['u-radial', 'u-radial-p', 'stroke', 'paint-gradient'],
  ['u-pattern', 'u-pattern-p', 'fill', 'paint-pattern'],
  ['u-mask', 'u-mask-p', 'fill', 'mask'],
  ['u-filter', 'u-filter-p', 'fill', 'filter'],
  ['u-blend', 'u-blend-p', 'fill', 'blend-mode'],
  ['u-multi', 'u-multi-a', 'fill', 'multi-paint'],
  ['u-fill-stroke-diff', 'u-fill-stroke-diff-p', 'fill', 'multi-paint'],
  ['u-chart', 'u-chart-a', 'fill', 'chart-like'],
  ['u-complex', 'u-complex', 'fill', 'complex-svg'],
  ['u-foreign', 'u-foreign-p', 'fill', 'foreign-object'],
  ['u-smil', 'u-smil-p', 'fill', 'animated'],
  ['u-extuse', 'u-extuse-u', 'fill', 'use-external'],
  ['u-missing', 'u-missing-u', 'fill', 'use-unresolved'],
];

const TRANSLUCENT = ['op-svg', 'op-fill', 'op-stroke', 'op-group', 'op-alpha', 'op-parent'];

test.describe('real browser: inline SVG adaptation', () => {
  test('fill, stroke, inheritance, groups and text: the browser paints exactly the planned color', async () => {
    const { page, planned } = await loadCases();
    for (const [svg, shapes, property] of ADAPTED) {
      const owner = planned[svg];
      expect(owner, `${svg} has changes`).toBeDefined();
      // One paint => one adapted value, used by every rule of the SVG.
      const values = new Set(owner!.map((paint) => paint.rgb));
      expect(values.size, `${svg} single value`).toBe(1);
      const [expected] = [...values];
      const actual = await (property === 'fill' ? paints.fill : paints.stroke)(page, shapes);
      for (const shape of shapes)
        expect(actual[shape], `${svg}/${shape} ${property}`).toBe(expected);
      expect(expected, svg).not.toBe(RED);
    }
    await expectOnlyOwnRules(page);
  });

  test('plan == browser for every changed rule target', async () => {
    const { page, planned } = await loadCases();
    for (const [owner, list] of Object.entries(planned)) {
      for (const paint of list) {
        const [actual] = Object.values(await computedColors(page, [paint.target], paint.property));
        expect(actual, `${owner}: ${paint.target}.${paint.property}`).toBe(paint.rgb);
      }
    }
  });

  test('a single-paint SVG already distinguishable is left alone', async () => {
    const { page, planned } = await loadCases();
    expect(planned['good']).toBeUndefined();
    expect((await paints.fill(page, ['good-p']))['good-p']).toBe('rgb(0, 0, 0)');
    const units = await svgUnits(ext, page);
    expect(units['good']?.analysisStatus).toBe('resolved');
  });

  test('classified and never recolored: gradients, patterns, masks, filters, blend modes, multi-paint, charts, ...', async () => {
    const { page, planned } = await loadCases();
    const units = await svgUnits(ext, page);
    for (const [svg, , , reason] of UNSUPPORTED) {
      expect(units[svg]?.svg?.unsupportedReason, svg).toBe(reason);
      expect(units[svg]?.analysisStatus, svg).toBe('unsupported');
      expect(planned[svg], `${svg} has no rules`).toBeUndefined();
    }
    expect((await paints.fill(page, ['u-gradient-p']))['u-gradient-p']).toBe('url("#lg")');
    expect((await paints.fill(page, ['u-pattern-p']))['u-pattern-p']).toBe('url("#pt")');
    expect((await paints.stroke(page, ['u-radial-p']))['u-radial-p']).toBe('url("#rg")');
  });

  test('clipPath alone does not block an otherwise simple paint', async () => {
    const { planned, page } = await loadCases();
    expect(planned['u-clip']).toBeDefined();
    const units = await svgUnits(ext, page);
    expect(units['u-clip']?.svg?.unsupportedReason).toBeUndefined();
  });

  test('opacity, fill-opacity, stroke-opacity, group opacity and alpha colors: analyzed, never rewritten', async () => {
    const { page, planned, plan } = await loadCases();
    const units = await svgUnits(ext, page);
    for (const svg of TRANSLUCENT) {
      expect(units[svg]?.svg?.partialReason, svg).toBe('translucent-paint');
      expect(units[svg]?.analysisStatus, svg).toBe('partial');
      expect(planned[svg], svg).toBeUndefined();
      // The effective color is a composite, not the plain paint (opacity is not double-applied).
      const fg = units[svg]!.colorPair.foreground;
      expect(fg.alpha).toBe(1);
      expect(fg.r).toBeGreaterThan(0.4); // lighter than #c0392b over green, not #c0392b itself
    }
    expect((await paints.fill(page, ['op-fill-p']))['op-fill-p']).toBe(RED);
    expect(plan.summary.unresolved).toBeGreaterThanOrEqual(TRANSLUCENT.length);
  });

  test('an <img> pointing at an SVG file is not inline SVG: never parsed, never recolored', async () => {
    const page = await openPristine(ext, server, 'svg-cases.html');
    const before = await pixelAt(page, 'img-svg', 12, 12);
    expect(before).toBe(RED);
    const plan = await adapt(ext, page);
    const units = await svgUnits(ext, page);
    const planned = await plannedByOwner(page, plan);
    expect(units['img-svg']).toBeUndefined();
    expect(planned['img-svg']).toBeUndefined();
    expect(await pixelAt(page, 'img-svg', 12, 12)).toBe(RED);
    // no rule reaches it: the <img> carries no token (one rule is shared per declaration, M12.5)
    expect(
      await page.evaluate(() =>
        document.getElementById('img-svg')?.hasAttribute('data-coloradapt-s'),
      ),
    ).toBe(false);
  });

  test('aria-hidden, role=img and <title> are only metadata: icons adapt either way', async () => {
    const { planned } = await loadCases();
    expect(planned['decorative']).toBeDefined();
    expect(planned['labelled']).toBeDefined();
  });

  test('every rule is ours; no probe or suppression is ever left in the sheet', async () => {
    const { page } = await loadCases();
    await expectOnlyOwnRules(page);
    const rules = await sheetRules(page);
    expect(rules.length).toBeGreaterThan(30);
    // no rule is declared twice
    expect(new Set(rules.map(([id, prop]) => `${id}|${prop}`)).size).toBe(rules.length);
  });

  test('OFF restores every fill, stroke and color exactly; the sheet is gone', async () => {
    const page = await openPristine(ext, server, 'svg-cases.html');
    const ids = await page.evaluate(() =>
      [...document.querySelectorAll('body [id]')]
        .filter((e) => e.closest('svg') !== null || e.tagName === 'BUTTON' || e.tagName === 'SPAN')
        .map((e) => e.id),
    );
    const pristine = {
      fill: await paints.fill(page, ids),
      stroke: await paints.stroke(page, ids),
      color: await paints.color(page, ids),
    };
    await adapt(ext, page);
    expect(await sheetText(page)).not.toBe('');
    await disable(ext.worker, page);
    await settle(page);
    expect({
      fill: await paints.fill(page, ids),
      stroke: await paints.stroke(page, ids),
      color: await paints.color(page, ids),
    }).toEqual(pristine);
    expect(await sheetText(page)).toBe('');
  });

  test('analyze/refresh/analyze/refresh does not drift: same plan, same paints, same rules', async () => {
    const { page, plan } = await loadCases();
    const ids = ADAPTED.flatMap(([, shapes]) => shapes);
    const first = {
      fill: await paints.fill(page, ids),
      stroke: await paints.stroke(page, ids),
      rules: await sheetRules(page),
    };
    for (let i = 0; i < 3; i += 1) {
      const again = await refresh(ext.worker, page);
      await settle(page);
      expect(again.changes.map((c) => [c.property, c.adaptedValue])).toEqual(
        plan.changes.map((c) => [c.property, c.adaptedValue]),
      );
      expect({
        fill: await paints.fill(page, ids),
        stroke: await paints.stroke(page, ids),
        rules: await sheetRules(page),
      }).toEqual(first);
    }
  });

  test('summary counts one SVG once, however many rules it has', async () => {
    const { plan, planned } = await loadCases();
    const owners = Object.keys(planned);
    expect(plan.summary.notApplied).toBe(2);
    // Every owner counts once in `adapted` (an HTML element is its own owner); rules outnumber owners.
    expect(plan.summary.adapted).toBe(owners.length);
    expect(plan.changes.length).toBeGreaterThan(owners.length);
  });
});

test.describe('real browser: SVG and the CSS cascade', () => {
  test('presentation attribute, class, id, chain, inline: every declaration site is out-ranked', async () => {
    const { page, planned } = await loadCases();
    for (const shape of [
      'fill-attr-p',
      'sp-class-p',
      'sp-id-p',
      'sp-chain-p',
      'sp-inline-p',
      'imp-class-p',
      'imp-id-p',
    ]) {
      const [actual] = Object.values(await paints.fill(page, [shape]));
      const owner = Object.values(planned).find((list) => list.some((p) => p.target === shape));
      expect(owner, shape).toBeDefined();
      expect(actual, shape).toBe(owner![0]!.rgb);
    }
    for (const shape of [
      'stroke-attr-p',
      'sp-stroke-class-p',
      'sp-stroke-id-p',
      'imp-stroke-class-p',
      'inline-stroke-p',
    ]) {
      const [actual] = Object.values(await paints.stroke(page, [shape]));
      const owner = Object.values(planned).find((list) => list.some((p) => p.target === shape));
      expect(owner, shape).toBeDefined();
      expect(actual, shape).toBe(owner![0]!.rgb);
    }
  });

  test('inline !important is out of reach: reported as not applied, nothing half-applied', async () => {
    const { page, plan, planned } = await loadCases();
    expect(plan.summary.notApplied).toBe(2);
    for (const svg of ['imp-inline-svg', 'imp-inline-stroke-svg']) {
      expect(planned[svg], svg).toBeUndefined();
    }
    expect((await paints.fill(page, ['imp-inline-p']))['imp-inline-p']).toBe(RED);
    expect((await paints.stroke(page, ['imp-inline-stroke-p']))['imp-inline-stroke-p']).toBe(RED);
    const rules = await sheetRules(page);
    const ids = await page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll('[data-coloradapt-id]')].map((e) => [
          e.getAttribute('data-coloradapt-id') ?? '',
          e.id,
        ]),
      ),
    );
    for (const [id] of rules) {
      expect(ids[id], `rule for ${id}`).not.toMatch(/^imp-inline/);
    }
  });

  test('a plan that said "adapted" is only ever kept when the browser agrees (AdaptationPlan.changes are the applied ones)', async () => {
    const { page, plan } = await loadCases();
    const ids = await page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll('[data-coloradapt-id]')].map((e) => [
          e.getAttribute('data-coloradapt-id') ?? '',
          e.id,
        ]),
      ),
    );
    for (const change of plan.changes) {
      const dom = ids[change.elementId]!;
      const [actual] = Object.values(await computedColors(page, [dom], change.property));
      expect(actual, `${dom}.${change.property}`).toBe(
        `rgb(${Number.parseInt(change.adaptedValue.slice(1, 3), 16)}, ${Number.parseInt(change.adaptedValue.slice(3, 5), 16)}, ${Number.parseInt(change.adaptedValue.slice(5, 7), 16)})`,
      );
    }
  });
});

test.describe('real browser: currentColor ownership', () => {
  test('an icon button: the <svg> follows the one adapted color; fill is never materialized', async () => {
    const { page, planned } = await loadCases();
    const button = planned['cc-btn'];
    const icon = planned['cc-fill'];
    expect(button, 'the button text is adapted').toBeDefined();
    expect(icon).toEqual([{ target: 'cc-fill', property: 'color', rgb: button![0]!.rgb }]);
    // The icon's paint follows `color`; no `fill` rule exists for it.
    const rules = await sheetRules(page);
    const fills = rules.filter(([, property]) => property === 'fill').map(([id]) => id);
    const ids = await page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll('[data-coloradapt-id]')].map((e) => [
          e.getAttribute('data-coloradapt-id') ?? '',
          e.id,
        ]),
      ),
    );
    expect(fills.map((id) => ids[id])).not.toContain('cc-fill-p');
    const [buttonColor] = Object.values(await paints.color(page, ['cc-btn']));
    const [svgColor] = Object.values(await paints.color(page, ['cc-fill']));
    const [fill] = Object.values(await paints.fill(page, ['cc-fill-p']));
    expect(svgColor).toBe(buttonColor);
    expect(fill).toBe(buttonColor);
  });

  test('currentColor on both fill and stroke: one `color` rule, not two paints', async () => {
    const { planned } = await loadCases();
    expect(planned['cc-both']).toEqual([
      { target: 'cc-both', property: 'color', rgb: planned['cc-both']![0]!.rgb },
    ]);
  });

  test('currentColor owned by a page rule (`.owner svg path { fill: currentColor }`) is adapted through `color`', async () => {
    const { planned, page } = await loadCases();
    expect(planned['cc-css']?.map((p) => [p.target, p.property])).toEqual([['cc-css', 'color']]);
    const [fill] = Object.values(await paints.fill(page, ['cc-css-p']));
    expect(fill).toBe(planned['cc-css']![0]!.rgb);
  });

  test('currentColor declared on the <svg> (stroke="currentColor", fill="currentColor") is still color`s', async () => {
    const { planned } = await loadCases();
    for (const svg of ['cc-root-stroke', 'cc-root-fill']) {
      expect(
        planned[svg]?.map((p) => [p.target, p.property]),
        svg,
      ).toEqual([[svg, 'color']]);
    }
  });

  test('a shape with its own `color` is adapted on the shape: the <svg> rule cannot reach it', async () => {
    const { planned } = await loadCases();
    expect(planned['cc-local']?.map((p) => [p.target, p.property])).toEqual([
      ['cc-local-p', 'fill'],
    ]);
  });

  test('changing the color source later re-derives the icon (no stale paint, no double adaptation)', async () => {
    const { page } = await loadCases();
    await page.evaluate(() => {
      document.getElementById('cc-btn')!.style.color = '#2c3e50';
    });
    await refresh(ext.worker, page);
    await settle(page);
    const [buttonColor] = Object.values(await paints.color(page, ['cc-btn']));
    const [fill] = Object.values(await paints.fill(page, ['cc-fill-p']));
    expect(fill).toBe(buttonColor);
  });
});

test.describe('real browser: pseudo-states (documented limitation)', () => {
  test('an adapted icon keeps its adapted color on :hover; OFF gives the page its hover color back', async () => {
    const { page } = await loadCases();
    const resting = (await paints.fill(page, ['hover-icon-p']))['hover-icon-p'];
    expect(resting).not.toBe(RED);
    await page.hover('#hover-host');
    await settle(page);
    // The page's own `:hover { color }` is overridden by the (!important) adaptation, as for M3 text.
    expect((await paints.fill(page, ['hover-icon-p']))['hover-icon-p']).toBe(resting);
    await disable(ext.worker, page);
    await settle(page);
    // ...and with ColorAdapt OFF the page's own hover color is back, exactly.
    expect((await paints.fill(page, ['hover-icon-p']))['hover-icon-p']).toBe('rgb(41, 128, 185)');
  });
});

test.describe('real browser: <use> / <symbol>', () => {
  async function loadUse(): Promise<Loaded> {
    const page = await openPristine(ext, server, 'svg-use.html');
    const plan = await adapt(ext, page);
    return { page, plan, planned: await plannedByOwner(page, plan) };
  }

  test('one symbol, three backgrounds: each instance is adapted for its own, the shared symbol is never touched', async () => {
    const page = await openPristine(ext, server, 'svg-use.html');
    const symbolBefore = await paints.fill(page, ['sym-cc-r', 'sym-inherit-r', 'sym-explicit-r']);
    const symbolColorBefore = await paints.color(page, ['sym-cc-r']);
    const originalA = await pixelAt(page, 'cc-a', 12, 12);
    const originalB = await pixelAt(page, 'cc-b', 12, 12);
    const originalC = await pixelAt(page, 'cc-c', 12, 12);
    expect([originalA, originalB, originalC]).toEqual([RED, RED, RED]);

    const plan = await adapt(ext, page);
    const planned = await plannedByOwner(page, plan);

    const a = planned['cc-a']!;
    const b = planned['cc-b']!;
    expect(a).toEqual([{ target: 'cc-a-u', property: 'color', rgb: a[0]!.rgb }]);
    expect(b).toEqual([{ target: 'cc-b-u', property: 'color', rgb: b[0]!.rgb }]);
    expect(a[0]!.rgb).not.toBe(b[0]!.rgb); // different backgrounds, different best answers
    expect(planned['cc-c']).toBeUndefined(); // red on white is fine

    // What is *rendered* — read from pixels, since instance trees are not in the DOM.
    expect(await pixelAt(page, 'cc-a', 12, 12)).toBe(a[0]!.rgb);
    expect(await pixelAt(page, 'cc-b', 12, 12)).toBe(b[0]!.rgb);
    expect(await pixelAt(page, 'cc-c', 12, 12)).toBe(RED);

    // The shared symbol content is exactly as before, and no rule targets it.
    expect(await paints.fill(page, ['sym-cc-r', 'sym-inherit-r', 'sym-explicit-r'])).toEqual(
      symbolBefore,
    );
    expect(await paints.color(page, ['sym-cc-r'])).toEqual(symbolColorBefore);
    const tagged = await page.evaluate(
      () =>
        [...document.querySelectorAll('symbol, symbol *')].filter(
          (e) => e.hasAttribute('data-coloradapt-id') || e.hasAttribute('data-coloradapt-s'),
        ).length,
    );
    expect(tagged).toBe(0);
    const css = await sheetText(page);
    expect(css).not.toContain('sym-');
  });

  test('symbol content that inherits fill from the <use>: per-instance `fill` on the <use>', async () => {
    const { page, planned } = await loadUse();
    const a = planned['inh-a']!;
    const b = planned['inh-b']!;
    expect(a).toEqual([{ target: 'inh-a-u', property: 'fill', rgb: a[0]!.rgb }]);
    expect(b).toEqual([{ target: 'inh-b-u', property: 'fill', rgb: b[0]!.rgb }]);
    expect(await pixelAt(page, 'inh-a', 12, 12)).toBe(a[0]!.rgb);
    expect(await pixelAt(page, 'inh-b', 12, 12)).toBe(b[0]!.rgb);
  });

  test('a <use> whose fill is currentColor is owned by the <use>`s color', async () => {
    const { page, planned } = await loadUse();
    const a = planned['ucc-a']!;
    expect(a).toEqual([{ target: 'ucc-a-u', property: 'color', rgb: a[0]!.rgb }]);
    expect(await pixelAt(page, 'ucc-a', 12, 12)).toBe(a[0]!.rgb);
  });

  test('a stroke that follows currentColor through a <use>', async () => {
    const { page, planned } = await loadUse();
    const a = planned['str-a']!;
    expect(a).toEqual([{ target: 'str-a-u', property: 'color', rgb: a[0]!.rgb }]);
    // stroke band of the 24px symbol: x in [0,6]
    expect(await pixelAt(page, 'str-a', 4, 12)).toBe(a[0]!.rgb);
  });

  test('content that declares its own paint is shared by every instance: unsupported, pixels untouched', async () => {
    const page = await openPristine(ext, server, 'svg-use.html');
    const before = [
      await pixelAt(page, 'exp-a', 12, 12),
      await pixelAt(page, 'exp-b', 12, 12),
      await pixelAt(page, 'css-a', 12, 12),
    ];
    const plan = await adapt(ext, page);
    const planned = await plannedByOwner(page, plan);
    const units = await svgUnits(ext, page);
    for (const svg of ['exp-a', 'exp-b', 'css-a', 'two-a']) {
      expect(units[svg]?.svg?.unsupportedReason, svg).toBe('use-shared-paint');
      expect(planned[svg], svg).toBeUndefined();
    }
    expect([
      await pixelAt(page, 'exp-a', 12, 12),
      await pixelAt(page, 'exp-b', 12, 12),
      await pixelAt(page, 'css-a', 12, 12),
    ]).toEqual(before);
  });

  test('external and missing targets are unsupported; no host permission is involved', async () => {
    const { page, planned } = await loadUse();
    const units = await svgUnits(ext, page);
    expect(units['ext-a']?.svg?.unsupportedReason).toBe('use-external');
    expect(units['miss-a']?.svg?.unsupportedReason).toBe('use-unresolved');
    expect(planned['ext-a']).toBeUndefined();
    expect(planned['miss-a']).toBeUndefined();
    await expectOnlyOwnRules(page);
  });

  test('OFF restores every instance pixel; refresh does not drift', async () => {
    const page = await openPristine(ext, server, 'svg-use.html');
    const ids = ['cc-a', 'cc-b', 'cc-c', 'inh-a', 'inh-b'];
    const before = await Promise.all(ids.map((id) => pixelAt(page, id, 12, 12)));
    const plan = await adapt(ext, page);
    const adapted = await Promise.all(ids.map((id) => pixelAt(page, id, 12, 12)));
    expect(adapted).not.toEqual(before);
    for (let i = 0; i < 3; i += 1) {
      await refresh(ext.worker, page);
      await settle(page);
      expect(await Promise.all(ids.map((id) => pixelAt(page, id, 12, 12)))).toEqual(adapted);
    }
    expect(plan.changes.length).toBeGreaterThan(0);
    await disable(ext.worker, page);
    await settle(page);
    expect(await Promise.all(ids.map((id) => pixelAt(page, id, 12, 12)))).toEqual(before);
  });
});

test.describe('real browser: settings', () => {
  test('adaptSVG off: SVGs are analyzed but never adapted; HTML still is', async () => {
    const page = await openPristine(ext, server, 'svg-cases.html', {
      enabled: true,
      visionProfile: 'deuteranopia',
      adaptationStrength: 1,
      adaptSVG: false,
    });
    const plan = await enable(ext.worker, page);
    await settle(page);
    const planned = await plannedByOwner(page, plan);
    expect(planned['fill-attr']).toBeUndefined();
    expect(planned['cc-fill']).toBeUndefined();
    expect((await paints.fill(page, ['fill-attr-p']))['fill-attr-p']).toBe(RED);
    expect(planned['cc-btn']).toBeDefined(); // the button's own text still adapts
  });
});
