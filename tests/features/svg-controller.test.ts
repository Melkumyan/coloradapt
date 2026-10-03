import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectOwnedIds } from '@core/analysis';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '@domain/models';
import { createContentController } from '@features/page-analysis';
import { createFakeEngine, installFakeComputedStyle, mount } from '../core/svg/fake-engine';

/**
 * The SVG layer through the content controller and the incremental session, in
 * jsdom. jsdom knows no SVG inheritance, so SVG computed styles come from the fake
 * CSS engine (which also honors ColorAdapt's own `<style>` rules); the stylesheet,
 * its verification and the session are real. Real-browser paint behavior is in
 * e2e/svg-paint.spec.ts.
 */
let restoreComputedStyle: () => void = () => undefined;

const SETTINGS: UserSettings = {
  ...DEFAULT_USER_SETTINGS,
  visionProfile: 'deuteranopia',
  adaptationStrength: 1,
  adaptSVG: true,
};

function setup(markup: string) {
  document.head.innerHTML = '';
  mount(markup);
  const engine = createFakeEngine(document);
  restoreComputedStyle();
  restoreComputedStyle = installFakeComputedStyle(engine);
  const controller = createContentController(document, {
    getStyle: engine.getStyle,
    probeStyles: engine.env.probe,
    now: () => 0,
  });
  return { engine, controller };
}

const realColor = (id: string) => getComputedStyle(document.getElementById(id)!).color;
const sheet = () => document.getElementById('coloradapt-stylesheet')?.textContent ?? '';
const rules = () =>
  sheet()
    .split('\n')
    .filter((line) => line.includes('!important'));
const byId = (id: string) => document.getElementById(id)!;

beforeEach(() => {
  restoreComputedStyle = () => undefined;
});

afterEach(() => {
  restoreComputedStyle();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

/**
 * jsdom has no layout/background for the fake engine, so use text on `green` via the engine's
 * own model: the SVG's background is the page (white), so red `currentColor` on white is the pair.
 * #c0392b on white is distinguishable for deuteranopia, so use a pair that is not: a pale grey on white.
 */
const POOR = '#e0e0e0';

describe('currentColor icon through the controller', () => {
  const PAGE = `<div id="host"><svg id="icon" style="color: ${POOR}" width="16" height="16"><path id="p" fill="currentColor"/></svg></div>`;

  it('adapts the <svg>`s color: one rule, owned by the <svg>', () => {
    const { controller } = setup(PAGE);
    const original = realColor('icon');
    const { adaptation } = controller.enableAdaptation('https://example.com', SETTINGS);

    expect(adaptation.changes).toHaveLength(1);
    const [change] = adaptation.changes;
    expect(change).toMatchObject({ property: 'color', ownerId: change?.elementId });
    expect(change?.elementId).toBe(byId('icon').getAttribute('data-coloradapt-id'));
    expect(realColor('icon')).not.toBe(original);
    expect(adaptation.summary).toMatchObject({ adapted: 1, notApplied: 0 });
    expect(rules()).toHaveLength(1);
    expect(controller.incremental.svgDiagnostics()).toEqual({
      svgAnalyzed: 1,
      svgAdapted: 1,
      svgUnsupported: 0,
      svgNotApplied: 0,
      svgPaintServers: 0,
    });
    // The shape is never tagged: nothing but the <svg> carries a rule.
    expect(byId('p').hasAttribute('data-coloradapt-id')).toBe(false);
  });

  it('OFF restores the color and removes the sheet; diagnostics reset', () => {
    const { controller } = setup(PAGE);
    const original = realColor('icon');
    controller.enableAdaptation('https://example.com', SETTINGS);
    controller.disableAdaptation();
    expect(realColor('icon')).toBe(original);
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
    expect(controller.incremental.svgDiagnostics().svgAnalyzed).toBe(0);
  });

  it('refresh does not drift: same rule, same value', () => {
    const { controller } = setup(PAGE);
    controller.enableAdaptation('https://example.com', SETTINGS);
    const first = rules();
    const color = realColor('icon');
    for (let i = 0; i < 3; i += 1) controller.enableAdaptation('https://example.com', SETTINGS);
    expect(rules()).toEqual(first);
    expect(realColor('icon')).toBe(color);
  });

  it('adaptSVG off: analyzed, never adapted', () => {
    const { controller } = setup(PAGE);
    const original = realColor('icon');
    const { adaptation, analysis } = controller.enableAdaptation('https://example.com', {
      ...SETTINGS,
      adaptSVG: false,
    });
    expect(adaptation.changes).toEqual([]);
    expect(adaptation.summary.skipped).toBeGreaterThanOrEqual(1);
    expect(analysis.elements.some((e) => e.svg)).toBe(true);
    expect(realColor('icon')).toBe(original);
  });

  it('a conflict is reported for the unit (the analysis sees the SVG like any element)', () => {
    const { controller } = setup(PAGE);
    const analysis = controller.analyze('https://example.com', SETTINGS);
    const unit = analysis.elements.find((e) => e.svg);
    expect(unit?.analysisStatus).toBe('resolved');
    expect(analysis.conflicts.map((c) => c.elementId)).toContain(unit?.id);
  });
});

describe('incremental updates of an SVG unit', () => {
  const PAGE = `<div id="host"><svg id="icon" style="color: ${POOR}" width="16" height="16"><path id="p" fill="currentColor"/></svg></div>`;

  function adapted() {
    const ctx = setup(PAGE);
    ctx.controller.enableAdaptation('https://example.com', SETTINGS);
    return ctx;
  }

  it('re-analyzing a region inside the SVG changes nothing when nothing changed', () => {
    const { controller } = adapted();
    const before = rules();
    const result = controller.incremental.update({
      roots: [{ element: byId('icon'), scope: 'self' }],
      removedIds: [],
    });
    expect(result.elementsProcessed).toBe(1);
    expect(result.rules).toEqual({ added: 0, updated: 0, removed: 0 });
    expect(rules()).toEqual(before);
  });

  it('a new color source updates the one rule in place (no duplicate, no stale value)', () => {
    const { controller } = adapted();
    const first = rules()[0];
    byId('icon').setAttribute('style', 'color: #d0e8ff');
    const result = controller.incremental.update({
      roots: [{ element: byId('icon'), scope: 'self' }],
      removedIds: [],
    });
    expect(result.rules).toEqual({ added: 0, updated: 1, removed: 0 });
    expect(rules()).toHaveLength(1);
    expect(rules()[0]).not.toBe(first);
  });

  it('the SVG becoming unsupported drops its rules and counts it as unsupported', () => {
    const { controller } = adapted();
    byId('p').setAttribute('filter', 'url(#f)');
    const result = controller.incremental.update({
      roots: [{ element: byId('icon'), scope: 'self' }],
      removedIds: [],
    });
    expect(result.rules.removed).toBe(1);
    expect(rules()).toHaveLength(0);
    expect(controller.incremental.svgDiagnostics()).toMatchObject({
      svgAnalyzed: 1,
      svgAdapted: 0,
      svgUnsupported: 1,
    });
    expect(controller.incremental.summary().unresolved).toBe(1);
    expect(realColor('icon')).toBe('rgb(224, 224, 224)'); // the page's own color is back
  });

  it('the SVG leaving the document forgets the unit and drops its rules', () => {
    const { controller } = adapted();
    const svg = byId('icon');
    svg.remove();
    const result = controller.incremental.update({ roots: [], removedIds: collectOwnedIds(svg) });
    expect(result.rules.removed).toBe(1);
    expect(rules()).toHaveLength(0);
    expect(controller.incremental.trackedCount()).toBe(0);
    expect(controller.incremental.svgDiagnostics().svgAnalyzed).toBe(0);
  });

  it('an SVG inserted later is adapted like one that was there at the start', () => {
    const { controller } = adapted();
    const host = byId('host');
    host.insertAdjacentHTML(
      'beforeend',
      `<svg id="late" style="color: ${POOR}" width="16" height="16"><path fill="currentColor"/></svg>`,
    );
    const result = controller.incremental.update({
      roots: [{ element: byId('late'), scope: 'subtree' }],
      removedIds: [],
    });
    expect(result.rules.added).toBe(1);
    expect(rules()).toHaveLength(2);
    expect(realColor('late')).toBe(realColor('icon'));
    expect(controller.incremental.svgDiagnostics()).toMatchObject({
      svgAnalyzed: 2,
      svgAdapted: 2,
    });
  });

  it('replacing an SVG (old removed, new inserted) leaves exactly one rule', () => {
    const { controller } = adapted();
    const old = byId('icon');
    old.remove();
    byId('host').insertAdjacentHTML(
      'beforeend',
      `<svg id="fresh" style="color: ${POOR}" width="16" height="16"><path fill="currentColor"/></svg>`,
    );
    controller.incremental.update({
      roots: [{ element: byId('fresh'), scope: 'subtree' }],
      removedIds: collectOwnedIds(old),
    });
    expect(rules()).toHaveLength(1);
    expect(controller.incremental.trackedCount()).toBe(1);
    expect(sheet()).toContain(byId('fresh').getAttribute('data-coloradapt-id')!);
    expect(sheet()).not.toContain(old.getAttribute('data-coloradapt-id')!);
  });

  it('a hundred replacements leave one rule and no tracking behind (no stale rules)', () => {
    const { controller } = adapted();
    let current = byId('icon');
    for (let i = 0; i < 100; i += 1) {
      const gone = current;
      gone.remove();
      byId('host').insertAdjacentHTML(
        'beforeend',
        `<svg id="r${i}" style="color: ${POOR}" width="16" height="16"><path fill="currentColor"/></svg>`,
      );
      current = byId(`r${i}`);
      controller.incremental.update({
        roots: [{ element: current, scope: 'subtree' }],
        removedIds: collectOwnedIds(gone),
      });
    }
    expect(rules()).toHaveLength(1);
    expect(controller.incremental.ruleCount).toBe(1);
    expect(controller.incremental.trackedCount()).toBe(1);
    expect(controller.incremental.svgDiagnostics().svgAnalyzed).toBe(1);
  });
});

describe('a plan is only kept when the browser reports the planned paint', () => {
  // An inline !important on the shape out-ranks any rule we can write.
  const PAGE = `<div><svg id="icon" width="16" height="16"><path id="p" style="fill: ${POOR} !important"/></svg></div>`;

  it('an out-ranked unit is reported as not applied and leaves nothing behind', () => {
    const { controller } = setup(PAGE);
    const { adaptation } = controller.enableAdaptation('https://example.com', SETTINGS);
    expect(adaptation.changes).toEqual([]);
    expect(adaptation.summary).toMatchObject({ adapted: 0, notApplied: 1 });
    expect(rules()).toHaveLength(0);
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
    expect(controller.incremental.svgDiagnostics()).toMatchObject({
      svgAnalyzed: 1,
      svgAdapted: 0,
      svgNotApplied: 1,
    });
  });

  it('and again on an incremental pass: still one unit not applied, still no rule', () => {
    const { controller } = setup(PAGE);
    controller.enableAdaptation('https://example.com', SETTINGS);
    const result = controller.incremental.update({
      roots: [{ element: byId('icon'), scope: 'self' }],
      removedIds: [],
    });
    expect(result.delta.notApplied.length).toBeGreaterThan(0);
    expect(rules()).toHaveLength(0);
    expect(controller.incremental.summary().notApplied).toBe(1);
  });

  it('a unit where one shape out-ranks the unit rule is not half-applied', () => {
    // One paint, two owners: the <svg> (inherited fill) and a shape that is out-ranked.
    const { controller } = setup(
      `<svg id="icon" width="16" height="16" fill="${POOR}"><path id="a"/><path id="b" style="fill: ${POOR} !important"/></svg>`,
    );
    const { adaptation } = controller.enableAdaptation('https://example.com', SETTINGS);
    expect(adaptation.changes).toEqual([]);
    expect(adaptation.summary.notApplied).toBe(1);
    expect(rules()).toHaveLength(0);
  });
});

describe('shape-owned paint and the group', () => {
  it('a unit whose paint moves from a shape to the <svg> prunes the shape rule', () => {
    const { controller } = setup(
      `<svg id="icon" width="16" height="16"><path id="p" fill="${POOR}"/></svg>`,
    );
    controller.enableAdaptation('https://example.com', SETTINGS);
    expect(rules()).toHaveLength(1);
    expect(sheet()).toContain(byId('p').getAttribute('data-coloradapt-id')!);

    // The shape now follows currentColor: the <svg>'s color owns the paint.
    byId('p').setAttribute('fill', 'currentColor');
    byId('icon').setAttribute('style', `color: ${POOR}`);
    const result = controller.incremental.update({
      roots: [{ element: byId('icon'), scope: 'self' }],
      removedIds: [],
    });
    expect(rules()).toHaveLength(1);
    expect(sheet()).toContain(`${byId('icon').getAttribute('data-coloradapt-id')}"]`);
    expect(sheet()).not.toContain(`${byId('p').getAttribute('data-coloradapt-id')}"]`);
    expect(sheet()).toMatch(/color: #[0-9a-f]{6} !important/);
    expect(result.rules.removed).toBe(1); // the pruned shape rule
    expect(controller.incremental.ruleCount).toBe(1);
  });
});

describe('integration: what is adapted and what is classified', () => {
  const adaptAll = (markup: string) => {
    const ctx = setup(markup);
    const result = ctx.controller.enableAdaptation('https://example.com', SETTINGS);
    return { ...ctx, ...result };
  };

  it('a monochrome fill icon, a stroke-only icon and SVG text are adapted', () => {
    const { adaptation, controller } = adaptAll(
      `<svg id="fill" width="16" height="16"><path id="f" fill="${POOR}"/></svg>
       <svg id="stroke" width="16" height="16"><path id="s" fill="none" stroke="${POOR}" stroke-width="2"/></svg>
       <svg id="text" width="80" height="16"><text id="t" fill="${POOR}">Label</text></svg>`,
    );
    expect(adaptation.summary).toMatchObject({ adapted: 3, notApplied: 0 });
    expect(adaptation.changes.map((c) => c.property).sort()).toEqual(['fill', 'fill', 'stroke']);
    expect(new Set(adaptation.changes.map((c) => c.adaptedValue)).size).toBe(1);
    expect(controller.incremental.svgDiagnostics()).toMatchObject({
      svgAnalyzed: 3,
      svgAdapted: 3,
      svgUnsupported: 0,
    });
  });

  it('an SVG that is already distinguishable is left unchanged', () => {
    const { adaptation } = adaptAll(
      '<svg id="ok" width="16" height="16"><path fill="#000000"/></svg>',
    );
    expect(adaptation.changes).toEqual([]);
    expect(adaptation.summary).toMatchObject({ adapted: 0, unchanged: 1 });
  });

  it.each([
    ['gradient', '<defs><linearGradient id="g"/></defs><path fill="url(#g)"/>', 'paint-gradient'],
    ['pattern', '<defs><pattern id="g"/></defs><path fill="url(#g)"/>', 'paint-pattern'],
    ['mask', `<path fill="${POOR}" mask="url(#m)"/>`, 'mask'],
    ['filter', `<path fill="${POOR}" filter="url(#f)"/>`, 'filter'],
    ['multi-color', `<circle fill="${POOR}"/><path fill="#000"/>`, 'multi-paint'],
  ])('%s: classified %s-style and never recolored', (_name, inner, reason) => {
    const { adaptation, analysis, controller } = adaptAll(`<svg id="u">${inner}</svg>`);
    expect(adaptation.changes).toEqual([]);
    expect(rules()).toHaveLength(0);
    expect(analysis.elements.find((e) => e.svg)?.svg?.unsupportedReason).toBe(reason);
    expect(adaptation.summary.unresolved).toBe(1);
    expect(controller.incremental.svgDiagnostics().svgUnsupported).toBe(1);
  });

  it('paint servers are counted for diagnostics', () => {
    const { controller } = adaptAll(
      `<svg><defs><linearGradient id="g"/></defs><path fill="url(#g)"/></svg>
       <svg><defs><pattern id="p"/></defs><path fill="url(#p)"/></svg>
       <svg><path fill="${POOR}"/></svg>`,
    );
    expect(controller.incremental.svgDiagnostics()).toMatchObject({
      svgAnalyzed: 3,
      svgUnsupported: 2,
      svgPaintServers: 2,
    });
  });

  it('a complex SVG is unsupported however simple each part is', () => {
    const shapes = Array.from({ length: 40 }, () => '<rect width="2" height="2"/>').join('');
    const { adaptation, analysis } = adaptAll(
      `<svg id="u" fill="${POOR}" width="64" height="64">${shapes}</svg>`,
    );
    expect(adaptation.changes).toEqual([]);
    expect(analysis.elements.find((e) => e.svg)?.svg?.unsupportedReason).toBe('complex-svg');
  });

  it('an <img> is not an SVG unit (M5 never parses or recolors it)', () => {
    const { adaptation, analysis } = adaptAll(
      `<img id="i" alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"/>
       <svg id="s" width="16" height="16"><path fill="${POOR}"/></svg>`,
    );
    expect(analysis.elements.filter((e) => e.svg)).toHaveLength(1);
    expect(adaptation.changes).toHaveLength(1);
  });

  it('a sprite symbol is never touched by an instance`s adaptation', () => {
    const { adaptation } = adaptAll(
      `<svg id="sprite" style="display: none"><defs><symbol id="sym"><path id="sp" fill="currentColor"/></symbol></defs></svg>
       <svg id="a" style="color: ${POOR}" width="16" height="16"><use id="ua" href="#sym"/></svg>
       <svg id="b" style="color: ${POOR}" width="16" height="16"><use id="ub" href="#sym"/></svg>`,
    );
    expect(adaptation.changes.map((c) => c.elementId)).toEqual([
      byId('ua').getAttribute('data-coloradapt-id'),
      byId('ub').getAttribute('data-coloradapt-id'),
    ]);
    expect(adaptation.changes.every((c) => c.property === 'color')).toBe(true);
    expect(
      document.querySelectorAll('symbol[data-coloradapt-id], symbol *[data-coloradapt-id]'),
    ).toHaveLength(0);
    expect(sheet()).not.toContain('sym');
  });
});
