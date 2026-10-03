import { describe, expect, it } from 'vitest';
import { analyzeSvgUnits, isOutermostSvg, type SvgUnitResult } from '@core/svg';
import { SVG_BUDGET } from '@shared/constants';
import { createFakeEngine, mount } from './fake-engine';

interface Options {
  probe?: boolean;
  rules?: ReadonlyArray<readonly [string, Record<string, string>]>;
  animated?: string[];
}

function analyze(markup: string, options: Options = {}) {
  mount(markup);
  const engine = createFakeEngine(document, {
    probe: options.probe,
    animated: (options.animated ?? []).map((selector) => document.querySelector(selector)!),
  });
  for (const [selector, declarations] of options.rules ?? [])
    engine.addRule(selector, declarations);
  const roots = [...document.querySelectorAll('svg')].filter(isOutermostSvg);
  const results = analyzeSvgUnits(roots, engine.env);
  const idOf = (selector: string): string => {
    const element = document.querySelector(selector);
    const id = element?.getAttribute('data-coloradapt-id');
    if (!id) throw new Error(`${selector} was not tagged`);
    return id;
  };
  const tagged = (selector: string): boolean =>
    document.querySelector(selector)?.hasAttribute('data-coloradapt-id') ?? false;
  const unit = (index = 0): NonNullable<SvgUnitResult['descriptor']> => {
    const descriptor = results[index]?.descriptor;
    if (!descriptor) throw new Error(`no unit #${index}`);
    return descriptor;
  };
  return { results, engine, unit, idOf, tagged };
}

const RED = { r: 0.752941, g: 0.223529, b: 0.168627 };
const near = (c: { r: number; g: number; b: number }, e: { r: number; g: number; b: number }) => {
  expect(c.r).toBeCloseTo(e.r, 4);
  expect(c.g).toBeCloseTo(e.g, 4);
  expect(c.b).toBeCloseTo(e.b, 4);
};

describe('fill', () => {
  it('an explicit fill is one solid paint owned by the shape', () => {
    const { unit, idOf } = analyze('<svg><path id="p" fill="#c0392b"/></svg>');
    const d = unit();
    expect(d.analysisStatus).toBe('resolved');
    expect(d.role).toBe('icon');
    expect(d.svg).toMatchObject({ paintCount: 1, shapeCount: 1, kind: 'icon' });
    expect(d.svg?.unsupportedReason).toBeUndefined();
    expect(d.svg?.targets).toEqual([{ elementId: idOf('#p'), property: 'fill' }]);
    near(d.colorPair.foreground, RED);
    expect(d.colorPair.foreground.alpha).toBe(1);
  });

  it('computed values are what counts: a class rule is the same paint as an attribute', () => {
    const { unit } = analyze('<svg><path class="a" id="p"/></svg>', {
      rules: [['.a', { fill: '#c0392b' }]],
    });
    near(unit().colorPair.foreground, RED);
    expect(unit().svg?.targets).toHaveLength(1);
  });

  it('a missing fill is not "transparent": the default (black) paints', () => {
    const { unit, idOf } = analyze('<svg><path id="p"/></svg>');
    expect(unit().colorPair.foreground).toMatchObject({ r: 0, g: 0, b: 0 });
    // Black comes from the <svg>'s inheritance chain, so the <svg> owns it.
    expect(unit().svg?.targets).toEqual([{ elementId: idOf('svg'), property: 'fill' }]);
  });

  it('fill: none (and nothing else painting) is not a unit at all', () => {
    const { results } = analyze('<svg><path fill="none"/></svg>');
    expect(results[0]?.descriptor).toBeNull();
  });

  it('rgb() and hex of the same color are the same paint', () => {
    const { unit } = analyze(
      '<svg><rect id="a" fill="#c0392b"/><rect id="b" fill="rgb(192, 57, 43)"/></svg>',
    );
    expect(unit().svg?.paintCount).toBe(1);
    expect(unit().svg?.targets).toHaveLength(2);
  });
});

describe('stroke', () => {
  it('a stroke-only icon is owned by the shape', () => {
    const { unit, idOf } = analyze(
      '<svg><path id="p" fill="none" stroke="#c0392b" stroke-width="2"/></svg>',
    );
    expect(unit().svg?.targets).toEqual([{ elementId: idOf('#p'), property: 'stroke' }]);
    near(unit().colorPair.foreground, RED);
  });

  it('stroke-width 0 is no stroke', () => {
    const { results } = analyze('<svg><path fill="none" stroke="#c0392b" stroke-width="0"/></svg>');
    expect(results[0]?.descriptor).toBeNull();
  });

  it('stroke-opacity 0 and fill-opacity 0 paint nothing, and do not count as paints', () => {
    const { unit } = analyze(
      '<svg><path id="p" fill="#c0392b" stroke="#00ff00" stroke-opacity="0" stroke-width="2"/></svg>',
    );
    expect(unit().svg?.paintCount).toBe(1);
    expect(unit().svg?.unsupportedReason).toBeUndefined();
    const hidden = analyze('<svg><path fill="#c0392b" fill-opacity="0"/></svg>');
    expect(hidden.results[0]?.descriptor).toBeNull();
  });

  it('fill and stroke of the same color are one paint with two rules on the shape', () => {
    const { unit, idOf } = analyze(
      '<svg><path id="p" fill="#c0392b" stroke="#c0392b" stroke-width="2"/></svg>',
    );
    expect(unit().svg?.paintCount).toBe(1);
    expect(unit().svg?.targets).toEqual([
      { elementId: idOf('#p'), property: 'fill' },
      { elementId: idOf('#p'), property: 'stroke' },
    ]);
  });
});

describe('currentColor', () => {
  it('is owned by the <svg>`s color, never materialized as fill', () => {
    const { unit, idOf } = analyze(
      '<svg style="color: #c0392b"><path id="p" fill="currentColor"/></svg>',
    );
    expect(unit().svg?.targets).toEqual([{ elementId: idOf('svg'), property: 'color' }]);
    near(unit().colorPair.foreground, RED);
  });

  it('fill and stroke both currentColor: one rule, not two', () => {
    const { unit } = analyze(
      '<svg style="color: #c0392b"><path fill="currentColor" stroke="currentColor" stroke-width="2"/></svg>',
    );
    expect(unit().svg?.targets).toHaveLength(1);
    expect(unit().svg?.targets[0]?.property).toBe('color');
  });

  it('a color inherited from the page (a button) is still the <svg>`s to set', () => {
    const { unit, idOf } = analyze(
      '<button style="color: #c0392b"><svg><path fill="currentColor"/></svg></button>',
    );
    expect(unit().svg?.targets).toEqual([{ elementId: idOf('svg'), property: 'color' }]);
  });

  it('a shape that sets its own color cannot follow the <svg>: the shape owns fill', () => {
    const { unit, idOf } = analyze(
      '<svg style="color: #000"><path id="p" style="color: #c0392b" fill="currentColor"/></svg>',
    );
    expect(unit().svg?.targets).toEqual([{ elementId: idOf('#p'), property: 'fill' }]);
  });

  it('an explicit color equal to the current color is explicit, not currentColor', () => {
    const { unit, idOf } = analyze(
      '<svg style="color: #c0392b"><path id="p" fill="#c0392b"/></svg>',
    );
    expect(unit().svg?.targets).toEqual([{ elementId: idOf('#p'), property: 'fill' }]);
  });

  it('currentColor shapes and an explicit shape of the same color: two owners, one paint', () => {
    const { unit } = analyze(
      '<svg style="color: #c0392b"><path id="a" fill="currentColor"/><path id="b" fill="#c0392b"/></svg>',
    );
    expect(unit().svg?.paintCount).toBe(1);
    expect(
      unit()
        .svg?.targets.map((t) => t.property)
        .sort(),
    ).toEqual(['color', 'fill']);
  });
});

describe('currentColor declared on the <svg> (the icon-library pattern)', () => {
  it('stroke="currentColor" on the <svg>: the paint is still color`s, not stroke`s', () => {
    const { unit, idOf } = analyze(
      '<svg fill="none" stroke="currentColor" stroke-width="2" style="color: #c0392b"><path id="p"/><circle/></svg>',
    );
    expect(unit().svg?.targets).toEqual([{ elementId: idOf('svg'), property: 'color' }]);
    near(unit().colorPair.foreground, RED);
  });

  it('fill="currentColor" on the <svg>', () => {
    const { unit, idOf } = analyze(
      '<svg fill="currentColor" style="color: #c0392b"><path/><rect/></svg>',
    );
    expect(unit().svg?.targets).toEqual([{ elementId: idOf('svg'), property: 'color' }]);
  });

  it('fill: currentColor from a page rule on the <svg>', () => {
    const { unit, idOf } = analyze('<svg class="icon" style="color: #c0392b"><path/></svg>', {
      rules: [['.icon', { fill: 'currentColor' }]],
    });
    expect(unit().svg?.targets).toEqual([{ elementId: idOf('svg'), property: 'color' }]);
  });

  it('an explicit root fill that merely equals the color stays a fill rule on the <svg>', () => {
    const { unit, idOf } = analyze(
      '<svg fill="#c0392b" style="color: #c0392b"><path/><circle/></svg>',
    );
    expect(unit().svg?.targets).toEqual([{ elementId: idOf('svg'), property: 'fill' }]);
  });

  it('stroke from currentColor and fill from the root: two owners of one paint', () => {
    const { unit } = analyze(
      '<svg fill="#c0392b" stroke="currentColor" stroke-width="2" style="color: #c0392b"><path/></svg>',
    );
    expect(unit().svg?.paintCount).toBe(1);
    expect(
      unit()
        .svg?.targets.map((t) => t.property)
        .sort(),
    ).toEqual(['color', 'fill']);
  });

  it('one extra probe, only when something inherits', () => {
    const inherits = analyze('<svg fill="#c0392b"><path/></svg>');
    expect(inherits.engine.probes).toBe(2);
    const explicit = analyze('<svg><path fill="#c0392b"/></svg>');
    expect(explicit.engine.probes).toBe(1);
  });

  it('a <use> whose fill is currentColor follows the <use>`s color', () => {
    const { results, idOf } = analyze(
      `<svg style="display: none"><defs><symbol id="s"><path/></symbol></defs></svg>
       <svg style="color: #c0392b"><use id="u" href="#s" fill="currentColor"/></svg>`,
    );
    expect(results[1]!.descriptor!.svg?.targets).toEqual([
      { elementId: idOf('#u'), property: 'color' },
    ]);
  });
});

describe('inheritance', () => {
  it('fill on the <svg>, shapes below inherit: the <svg> owns it, once', () => {
    const { unit, idOf } = analyze(
      '<svg fill="#c0392b"><g><path id="a"/><path id="b"/></g><circle id="c"/></svg>',
    );
    expect(unit().svg?.targets).toEqual([{ elementId: idOf('svg'), property: 'fill' }]);
    expect(unit().svg?.shapeCount).toBe(3);
  });

  it('fill declared on a group: each shape is the owner (the group is not an <svg>)', () => {
    const { unit, idOf } = analyze('<svg><g fill="#c0392b"><path id="a"/><path id="b"/></g></svg>');
    expect(unit().svg?.targets).toEqual([
      { elementId: idOf('#a'), property: 'fill' },
      { elementId: idOf('#b'), property: 'fill' },
    ]);
  });

  it('a shape that overrides an inherited fill is its own owner', () => {
    const { unit } = analyze(
      '<svg fill="#c0392b"><path id="a"/><path id="b" fill="rgb(192, 57, 43)"/></svg>',
    );
    expect(unit().svg?.paintCount).toBe(1);
    expect(unit().svg?.targets).toHaveLength(2);
  });

  it('fill: none inherited from the <svg> with a stroking child: only the stroke is a paint', () => {
    const { unit, idOf } = analyze(
      '<svg fill="none" stroke="#c0392b" stroke-width="2"><path id="p"/></svg>',
    );
    expect(unit().svg?.targets).toEqual([{ elementId: idOf('svg'), property: 'stroke' }]);
  });

  it('CSS inheritance is not background inheritance: the unit background is the page behind it', () => {
    const { unit } = analyze('<div style="opacity: 1"><svg fill="#c0392b"><path/></svg></div>');
    expect(unit().backgroundKind).toBe('solid');
    expect(unit().colorPair.background).toMatchObject({ r: 1, g: 1, b: 1, alpha: 1 });
  });
});

describe('opacity: analyzed, never reproduced by a single value', () => {
  const effective = (markup: string) => {
    const { unit } = analyze(markup);
    return unit();
  };

  it('opacity on a shape composites over the page (not double-applied)', () => {
    const d = effective('<svg><path fill="#ff0000" opacity="0.5"/></svg>');
    near(d.colorPair.foreground, { r: 1, g: 0.5, b: 0.5 });
    expect(d.svg?.partialReason).toBe('translucent-paint');
    expect(d.analysisStatus).toBe('partial');
    expect(d.svg?.targets).toEqual([]);
  });

  it('fill-opacity and opacity multiply once', () => {
    const d = effective('<svg><path fill="#ff0000" fill-opacity="0.5" opacity="0.5"/></svg>');
    near(d.colorPair.foreground, { r: 1, g: 0.75, b: 0.75 });
  });

  it('stroke-opacity applies to the stroke', () => {
    const d = effective(
      '<svg><path fill="none" stroke="#ff0000" stroke-width="2" stroke-opacity="0.5"/></svg>',
    );
    near(d.colorPair.foreground, { r: 1, g: 0.5, b: 0.5 });
    expect(d.svg?.partialReason).toBe('translucent-paint');
  });

  it('an alpha color is the same as fill-opacity', () => {
    const d = effective('<svg><path fill="rgba(255, 0, 0, 0.5)"/></svg>');
    near(d.colorPair.foreground, { r: 1, g: 0.5, b: 0.5 });
    expect(d.svg?.partialReason).toBe('translucent-paint');
  });

  it('opacity on a group inside the <svg> counts, nested groups multiply', () => {
    const d = effective(
      '<svg><g opacity="0.5"><g opacity="0.5"><path fill="#ff0000"/></g></g></svg>',
    );
    near(d.colorPair.foreground, { r: 1, g: 0.75, b: 0.75 });
  });

  it('opacity on the <svg> and on a page ancestor counts once through the page chain', () => {
    const own = effective('<svg style="opacity: 0.5"><path fill="#ff0000"/></svg>');
    near(own.colorPair.foreground, { r: 1, g: 0.5, b: 0.5 });
    const parent = effective('<div style="opacity: 0.5"><svg><path fill="#ff0000"/></svg></div>');
    near(parent.colorPair.foreground, { r: 1, g: 0.5, b: 0.5 });
    expect(own.svg?.partialReason).toBe('translucent-paint');
    expect(parent.svg?.partialReason).toBe('translucent-paint');
  });

  it('fully opaque paint stays resolved with the plain color', () => {
    const d = effective('<svg><path fill="#ff0000" opacity="1" fill-opacity="1"/></svg>');
    expect(d.analysisStatus).toBe('resolved');
    expect(d.svg?.partialReason).toBeUndefined();
  });

  it('opacity: 0 hides the shape (no paint); hidden shapes do not count', () => {
    const d = effective(
      '<svg><path fill="#ff0000"/><path fill="#00ff00" opacity="0"/><path fill="#0000ff" visibility="hidden"/></svg>',
    );
    expect(d.svg?.paintCount).toBe(1);
  });
});

describe('SVG text', () => {
  it('text is a paint like any other, and the unit is text, not an icon', () => {
    const { unit, idOf } = analyze('<svg><text id="t" fill="#c0392b">Label</text></svg>');
    expect(unit().role).toBe('text');
    expect(unit().hasTextContent).toBe(true);
    expect(unit().svg).toMatchObject({ kind: 'text', textCount: 1, shapeCount: 0 });
    expect(unit().svg?.targets).toEqual([{ elementId: idOf('#t'), property: 'fill' }]);
  });

  it('tspan with its own fill is its own owner; the empty parent is not painted', () => {
    const { unit, idOf } = analyze(
      '<svg><text id="t"><tspan id="s" fill="#c0392b">Label</tspan></text></svg>',
    );
    expect(unit().svg?.targets).toEqual([{ elementId: idOf('#s'), property: 'fill' }]);
    expect(unit().svg?.textCount).toBe(1);
  });

  it('text and a shape in one unit is an icon', () => {
    const { unit } = analyze(
      '<svg fill="#c0392b"><rect width="4" height="4"/><text>Label</text></svg>',
    );
    expect(unit().role).toBe('icon');
    expect(unit().svg?.kind).toBe('icon');
  });

  it('text with currentColor follows color', () => {
    const { unit, idOf } = analyze(
      '<svg style="color: #c0392b"><text fill="currentColor">Label</text></svg>',
    );
    expect(unit().svg?.targets).toEqual([{ elementId: idOf('svg'), property: 'color' }]);
  });

  it('whitespace-only text paints nothing', () => {
    const { results } = analyze('<svg><text fill="#c0392b">   </text></svg>');
    expect(results[0]?.descriptor).toBeNull();
  });
});

describe('paint servers, filters, masks, blends: classified, never adapted', () => {
  const reason = (markup: string, options?: Options) =>
    analyze(markup, options).unit().svg?.unsupportedReason;

  it('gradients (fill and stroke, with or without fallback)', () => {
    const defs = '<defs><linearGradient id="g"/><radialGradient id="r"/></defs>';
    expect(reason(`<svg>${defs}<path fill="url(#g)"/></svg>`)).toBe('paint-gradient');
    expect(reason(`<svg>${defs}<path fill="none" stroke="url(#r)" stroke-width="2"/></svg>`)).toBe(
      'paint-gradient',
    );
    expect(reason(`<svg>${defs}<path fill="url(#g) red"/></svg>`)).toBe('paint-gradient');
    const d = analyze(`<svg>${defs}<path fill="url(#g)"/></svg>`).unit();
    expect(d.svg?.paintServer).toBe('gradient');
    expect(d.analysisStatus).toBe('unsupported');
    expect(d.svg?.targets).toEqual([]);
  });

  it('patterns', () => {
    const d = analyze('<svg><defs><pattern id="p"/></defs><path fill="url(#p)"/></svg>').unit();
    expect(d.svg?.unsupportedReason).toBe('paint-pattern');
    expect(d.svg?.paintServer).toBe('pattern');
  });

  it('other paint servers and broken references', () => {
    expect(reason('<svg><path fill="url(#nowhere)"/></svg>')).toBe('paint-server');
    expect(reason('<svg><path fill="url(icons.svg#x)"/></svg>')).toBe('paint-server');
  });

  it('a gradient makes the whole unit unsupported even next to solid shapes', () => {
    const d = analyze(
      '<svg><defs><linearGradient id="g"/></defs><path fill="#c0392b"/><path fill="url(#g)"/></svg>',
    ).unit();
    expect(d.svg?.unsupportedReason).toBe('paint-gradient');
    expect(d.svg?.targets).toEqual([]);
  });

  it('context-fill / context-stroke', () => {
    expect(reason('<svg><path fill="context-fill"/></svg>')).toBe('paint-context');
  });

  it.each([
    ['filter', 'filter="url(#f)"', 'filter'],
    ['mask', 'mask="url(#m)"', 'mask'],
    ['mix-blend-mode', 'mix-blend-mode="multiply"', 'blend-mode'],
    ['marker', 'marker-start="url(#mk)"', 'marker'],
  ] as const)('%s on a shape', (_name, attribute, expected) => {
    expect(reason(`<svg><path fill="#c0392b" ${attribute}/></svg>`)).toBe(expected);
  });

  it('a filter on the <svg> itself or on a group counts too', () => {
    expect(reason('<svg filter="url(#f)"><path fill="#c0392b"/></svg>')).toBe('filter');
    expect(reason('<svg><g filter="url(#f)"><path fill="#c0392b"/></g></svg>')).toBe('filter');
  });

  it('clipPath alone does not alter color: the paint stays adaptable', () => {
    const d = analyze(
      '<svg><defs><clipPath id="c"><rect/></clipPath></defs><path fill="#c0392b" clip-path="url(#c)"/></svg>',
    ).unit();
    expect(d.svg?.unsupportedReason).toBeUndefined();
    expect(d.svg?.targets).toHaveLength(1);
  });

  it('foreignObject, embedded images and animation', () => {
    expect(
      reason('<svg><foreignObject><span>x</span></foreignObject><path fill="#c0392b"/></svg>'),
    ).toBe('foreign-object');
    expect(reason('<svg><image href="x.png"/><path fill="#c0392b"/></svg>')).toBe('embedded-image');
    expect(reason('<svg><path fill="#c0392b"><animate attributeName="fill"/></path></svg>')).toBe(
      'animated',
    );
    expect(reason('<svg><set attributeName="fill"/><path fill="#c0392b"/></svg>')).toBe('animated');
  });

  it('a CSS/Web animation on a paint property anywhere in the unit', () => {
    const d = analyze('<svg><path id="p" fill="#c0392b"/></svg>', { animated: ['#p'] }).unit();
    expect(d.svg?.unsupportedReason).toBe('animated');
    const parent = analyze('<div id="d"><svg><path fill="#c0392b"/></svg></div>', {
      animated: ['#d'],
    }).unit();
    expect(parent.svg?.unsupportedReason).toBe('animated');
  });

  it('definitions that nothing paints are not blockers (a mask element inside <defs> alone)', () => {
    const d = analyze(
      '<svg><defs><mask id="m"><rect fill="#fff"/></mask><filter id="f"/></defs><path fill="#c0392b"/></svg>',
    ).unit();
    expect(d.svg?.unsupportedReason).toBeUndefined();
  });

  it('priority: the first applicable reason wins, deterministically', () => {
    const d = analyze(
      '<svg><defs><linearGradient id="g"/></defs><path fill="url(#g)" filter="url(#f)"/><path fill="#00f"/></svg>',
    ).unit();
    expect(d.svg?.unsupportedReason).toBe('filter');
  });
});

describe('multi-paint and complexity policy', () => {
  it('two distinct paints: multi-paint, never adapted', () => {
    const d = analyze('<svg><circle fill="#c0392b"/><path fill="#ffffff"/></svg>').unit();
    expect(d.svg?.paintCount).toBe(2);
    expect(d.svg?.unsupportedReason).toBe('multi-paint');
    expect(d.analysisStatus).toBe('unsupported');
    expect(d.svg?.targets).toEqual([]);
  });

  it('different fill and stroke on one shape is two paints', () => {
    const d = analyze('<svg><path fill="#c0392b" stroke="#000" stroke-width="2"/></svg>').unit();
    expect(d.svg?.unsupportedReason).toBe('multi-paint');
  });

  it('paints that become distinct only through opacity are distinct', () => {
    const d = analyze(
      '<svg><path fill="#c0392b"/><path fill="#c0392b" opacity="0.5"/></svg>',
    ).unit();
    expect(d.svg?.paintCount).toBe(2);
  });

  it('more distinct paints than the threshold: complex-svg', () => {
    const shapes = Array.from(
      { length: SVG_BUDGET.maxDistinctPaints + 1 },
      (_, i) => `<rect fill="rgb(${i * 40}, 10, 10)"/>`,
    ).join('');
    expect(analyze(`<svg>${shapes}</svg>`).unit().svg?.unsupportedReason).toBe('complex-svg');
  });

  it('more painted elements than the threshold: complex-svg, even when they share one paint', () => {
    const shapes = Array.from(
      { length: SVG_BUDGET.maxPaintedElements + 1 },
      () => '<rect fill="#c0392b"/>',
    ).join('');
    const d = analyze(`<svg>${shapes}</svg>`).unit();
    expect(d.svg?.unsupportedReason).toBe('complex-svg');
    expect(d.svg?.targets).toEqual([]);
  });

  it('exactly the painted-element threshold is still fine', () => {
    const shapes = Array.from(
      { length: SVG_BUDGET.maxPaintedElements },
      () => '<rect fill="#c0392b"/>',
    ).join('');
    expect(analyze(`<svg>${shapes}</svg>`).unit().svg?.unsupportedReason).toBeUndefined();
  });

  it('more elements than the visit budget: complex-svg (structural, never partial)', () => {
    const empty = Array.from({ length: SVG_BUDGET.maxDescendants + 1 }, () => '<g></g>').join('');
    expect(analyze(`<svg><path fill="#c0392b"/>${empty}</svg>`).unit().svg?.unsupportedReason).toBe(
      'complex-svg',
    );
  });

  it('too deep a nesting: complex-svg', () => {
    const open = '<g>'.repeat(SVG_BUDGET.maxDepth + 2);
    const close = '</g>'.repeat(SVG_BUDGET.maxDepth + 2);
    expect(
      analyze(`<svg>${open}<path fill="#c0392b"/>${close}</svg>`).unit().svg?.unsupportedReason,
    ).toBe('complex-svg');
  });

  it('chart-like: several paints with several labels and shapes is named as such', () => {
    const d = analyze(`
      <svg>
        <rect fill="#c0392b"/><rect fill="#1b1b1b"/><rect fill="#2980b9"/>
        <text fill="#1b1b1b">A</text><text fill="#1b1b1b">B</text><text fill="#1b1b1b">C</text>
      </svg>`).unit();
    expect(d.svg?.unsupportedReason).toBe('chart-like');
  });

  it('labels with one paint are not a chart', () => {
    const d = analyze(`
      <svg fill="#c0392b"><rect/><rect/><rect/><text>A</text><text>B</text><text>C</text></svg>`).unit();
    expect(d.svg?.unsupportedReason).toBeUndefined();
    expect(d.svg?.paintCount).toBe(1);
  });
});

describe('<use> / <symbol>', () => {
  const sprite = (symbols: string) =>
    `<svg id="sprite" style="display: none"><defs>${symbols}</defs></svg>`;

  it('currentColor inside the symbol is the instance`s color: the <use> owns it, the symbol is untouched', () => {
    const { results, idOf, tagged } = analyze(
      `${sprite('<symbol id="s"><path id="sp" fill="currentColor"/></symbol>')}
       <svg id="a" style="color: #c0392b"><use id="u" href="#s"/></svg>`,
    );
    const d = results[1]!.descriptor!;
    expect(d.svg?.useCount).toBe(1);
    expect(d.svg?.targets).toEqual([{ elementId: idOf('#u'), property: 'color' }]);
    near(d.colorPair.foreground, RED);
    expect(tagged('#sp')).toBe(false);
    expect(tagged('#s')).toBe(false);
  });

  it('content that inherits fill takes it from the <use>', () => {
    const { results, idOf } = analyze(
      `${sprite('<symbol id="s"><path/></symbol>')}
       <svg><use id="u" href="#s" fill="#c0392b"/></svg>`,
    );
    expect(results[1]!.descriptor!.svg?.targets).toEqual([
      { elementId: idOf('#u'), property: 'fill' },
    ]);
    near(results[1]!.descriptor!.colorPair.foreground, RED);
  });

  it('a stroke through currentColor', () => {
    const { results, idOf } = analyze(
      `${sprite('<symbol id="s"><path fill="none" stroke="currentColor" stroke-width="3"/></symbol>')}
       <svg style="color: #c0392b"><use id="u" href="#s"/></svg>`,
    );
    expect(results[1]!.descriptor!.svg?.targets).toEqual([
      { elementId: idOf('#u'), property: 'color' },
    ]);
  });

  it('content that declares its own fill is shared by every instance: use-shared-paint', () => {
    const { results, tagged } = analyze(
      `${sprite('<symbol id="s"><path id="sp" fill="#c0392b"/></symbol>')}
       <svg><use id="u" href="#s"/></svg>`,
    );
    const d = results[1]!.descriptor!;
    expect(d.svg?.unsupportedReason).toBe('use-shared-paint');
    expect(d.analysisStatus).toBe('unsupported');
    expect(d.svg?.targets).toEqual([]);
    expect(tagged('#sp')).toBe(false);
  });

  it('a class rule inside the symbol is also the content declaring its paint', () => {
    const { results } = analyze(
      `${sprite('<symbol id="s"><path class="decl"/></symbol>')}<svg><use id="u" href="#s"/></svg>`,
      { rules: [['.decl', { fill: '#c0392b' }]] },
    );
    expect(results[1]!.descriptor!.svg?.unsupportedReason).toBe('use-shared-paint');
  });

  it('two instances of one symbol are independent units with independent owners', () => {
    const { results, idOf } = analyze(
      `${sprite('<symbol id="s"><path fill="currentColor"/></symbol>')}
       <svg id="a" style="color: #c0392b"><use id="u1" href="#s"/></svg>
       <svg id="b" style="color: #2980b9"><use id="u2" href="#s"/></svg>`,
    );
    const a = results[1]!.descriptor!;
    const b = results[2]!.descriptor!;
    expect(a.svg?.targets).toEqual([{ elementId: idOf('#u1'), property: 'color' }]);
    expect(b.svg?.targets).toEqual([{ elementId: idOf('#u2'), property: 'color' }]);
    near(a.colorPair.foreground, RED);
    expect(b.colorPair.foreground.b).toBeGreaterThan(b.colorPair.foreground.r);
  });

  it('two paints inside one instance are not adapted', () => {
    const { results } = analyze(
      `${sprite('<symbol id="s"><rect fill="currentColor"/><rect fill="#1b1b1b"/></symbol>')}
       <svg style="color: #c0392b"><use href="#s"/></svg>`,
    );
    expect(results[1]!.descriptor!.svg?.unsupportedReason).toBe('use-shared-paint');
  });

  it('use of a shape directly (not a symbol) works the same', () => {
    const { results, idOf } = analyze(
      `<svg style="display: none"><defs><path id="shape"/></defs></svg>
       <svg><use id="u" href="#shape" fill="#c0392b"/></svg>`,
    );
    expect(results[1]!.descriptor!.svg?.targets).toEqual([
      { elementId: idOf('#u'), property: 'fill' },
    ]);
  });

  it('external, data: and missing targets are unsupported', () => {
    expect(analyze('<svg><use href="icons.svg#search"/></svg>').unit().svg?.unsupportedReason).toBe(
      'use-external',
    );
    expect(
      analyze('<svg><use href="data:image/svg+xml,x#a"/></svg>').unit().svg?.unsupportedReason,
    ).toBe('use-external');
    expect(analyze('<svg><use href="#nope"/></svg>').unit().svg?.unsupportedReason).toBe(
      'use-unresolved',
    );
    expect(analyze('<svg><use/></svg>').unit().svg?.unsupportedReason).toBe('use-unresolved');
  });

  it('legacy xlink:href resolves like href', () => {
    const { results } = analyze(
      `${sprite('<symbol id="s"><path fill="currentColor"/></symbol>')}
       <svg style="color: #c0392b"><use xlink:href="#s"/></svg>`,
    );
    expect(results[1]!.descriptor!.svg?.useCount).toBe(1);
    expect(results[1]!.descriptor!.svg?.unsupportedReason).toBeUndefined();
  });

  it('a target that is not SVG content (an HTML element with that id) is unresolved', () => {
    const d = analyze('<div id="box"></div><svg><use href="#box"/></svg>').results[0]?.descriptor;
    expect(d?.svg?.unsupportedReason).toBe('use-unresolved');
  });

  it('a reference cycle is unresolved, not followed', () => {
    const d = analyze('<svg><g id="g"><use href="#g"/></g></svg>').unit();
    expect(d.svg?.unsupportedReason).toBe('use-unresolved');
  });

  it('a <use> nested inside referenced content is unsupported (bounded reference depth)', () => {
    const { results } = analyze(
      `${sprite('<symbol id="a"><use href="#b"/></symbol><symbol id="b"><path/></symbol>')}
       <svg style="color: #c0392b"><use href="#a"/></svg>`,
    );
    expect(results[1]!.descriptor!.svg?.unsupportedReason).toBe('use-unresolved');
  });

  it('opacity declared on the referenced content makes the instance translucent', () => {
    const { results } = analyze(
      `${sprite('<symbol id="s"><path fill="currentColor" opacity="0.5"/></symbol>')}
       <svg style="color: #ff0000"><use href="#s"/></svg>`,
    );
    const d = results[1]!.descriptor!;
    expect(d.svg?.partialReason).toBe('translucent-paint');
    near(d.colorPair.foreground, { r: 1, g: 0.5, b: 0.5 });
  });
});

describe('probe availability and batching', () => {
  it('without a probe nothing can be told apart: analyzed as partial, never adapted', () => {
    const { unit } = analyze('<svg><path fill="#c0392b"/></svg>', { probe: false });
    expect(unit().analysisStatus).toBe('partial');
    expect(unit().svg?.partialReason).toBe('derivation-unknown');
    expect(unit().svg?.targets).toEqual([]);
  });

  it('one probe serves a whole batch of SVGs', () => {
    const { engine, results } = analyze(
      Array.from({ length: 25 }, () => '<svg><path fill="#c0392b"/></svg>').join(''),
    );
    expect(results).toHaveLength(25);
    expect(engine.probes).toBe(1);
  });

  it('no probe is applied when nothing can use one', () => {
    const { engine } = analyze('<svg><path fill="none"/></svg><svg><foreignObject/></svg>');
    expect(engine.probes).toBe(0);
  });

  it('units that are already unsupported are not probed', () => {
    const { engine } = analyze('<svg><path fill="#c0392b" filter="url(#f)"/></svg>');
    expect(engine.probes).toBe(0);
  });
});

describe('visibility and ids', () => {
  it('a hidden <svg> is not a unit', () => {
    const { results } = analyze('<svg style="display: none"><path fill="#c0392b"/></svg>');
    expect(results[0]?.descriptor).toBeNull();
    const invisible = analyze('<svg style="visibility: hidden"><path fill="#c0392b"/></svg>');
    expect(invisible.results[0]?.descriptor).toBeNull();
  });

  it('display: none inside the unit hides the subtree', () => {
    const d = analyze(
      '<svg><g style="display: none"><path fill="#00ff00"/></g><path fill="#c0392b"/></svg>',
    ).unit();
    expect(d.svg?.paintCount).toBe(1);
  });

  it('shapes are tagged only when they are rule targets of an adaptable unit', () => {
    const adaptable = analyze(
      '<svg><path id="a" fill="#c0392b"/><path id="b" fill="#c0392b"/></svg>',
    );
    expect(adaptable.tagged('#a')).toBe(true);
    const multi = analyze('<svg><path id="a" fill="#c0392b"/><path id="b" fill="#fff"/></svg>');
    expect(multi.tagged('#a')).toBe(false);
    expect(multi.tagged('svg')).toBe(true); // the unit itself is always tagged
  });

  it('nodes of a unit are returned by id, so callers need no document-wide lookup', () => {
    const { results, idOf } = analyze('<svg><path id="a" fill="#c0392b"/></svg>');
    const nodes = results[0]!.nodes;
    expect(nodes.get(idOf('svg'))).toBe(document.querySelector('svg'));
    expect(nodes.get(idOf('#a'))).toBe(document.querySelector('#a'));
  });

  it('repeated analysis is idempotent: same ids, same targets', () => {
    mount('<svg style="color: #c0392b"><path id="p" fill="currentColor"/></svg>');
    const engine = createFakeEngine(document);
    const svg = document.querySelector('svg')!;
    const first = analyzeSvgUnits([svg], engine.env)[0]!.descriptor!;
    const second = analyzeSvgUnits([svg], engine.env)[0]!.descriptor!;
    expect(second).toEqual(first);
  });
});
