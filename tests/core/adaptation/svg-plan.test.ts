import { describe, expect, it } from 'vitest';
import {
  createAdaptationPlan,
  createDetailedAdaptationPlan,
  createPlanningContext,
  planElement,
} from '@core/adaptation';
import { parseColor } from '@core/color';
import {
  DEFAULT_USER_SETTINGS,
  VISION_PROFILE_CONFIDENCE,
  type AnalysisResult,
  type ElementDescriptor,
  type SvgUnitInfo,
  type UserSettings,
} from '@domain/models';

const DEUTAN: UserSettings = {
  ...DEFAULT_USER_SETTINGS,
  visionProfile: 'deuteranopia',
  adaptationStrength: 1,
  adaptSVG: true,
};

function unit(
  id: string,
  svg: Partial<SvgUnitInfo> = {},
  overrides: Partial<ElementDescriptor> = {},
): ElementDescriptor {
  return {
    id,
    tagName: 'svg',
    role: 'icon',
    colorPair: { foreground: parseColor('#c0392b')!, background: parseColor('#27ae60')! },
    backgroundKind: 'solid',
    analysisStatus: 'resolved',
    isVisible: true,
    hasTextContent: false,
    svg: {
      kind: 'icon',
      paintCount: 1,
      shapeCount: 1,
      textCount: 0,
      useCount: 0,
      targets: [{ elementId: `${id}-shape`, property: 'fill' }],
      ...svg,
    },
    ...overrides,
  };
}

function analysis(elements: ElementDescriptor[]): AnalysisResult {
  return {
    url: 'https://example.com',
    timestamp: 0,
    elements,
    conflicts: [],
    truncated: false,
    unresolvedCount: 0,
  };
}

const plan = (elements: ElementDescriptor[], settings = DEUTAN) =>
  createAdaptationPlan(analysis(elements), settings);

describe('planning an inline SVG', () => {
  it('a single adaptable paint becomes one rule per owner, all owned by the <svg>', () => {
    const result = plan([
      unit('svg1', {
        targets: [
          { elementId: 'svg1', property: 'color' },
          { elementId: 'shape', property: 'fill' },
          { elementId: 'use', property: 'stroke' },
        ],
      }),
    ]);
    expect(result.changes.map((c) => [c.elementId, c.property, c.ownerId])).toEqual([
      ['svg1', 'color', 'svg1'],
      ['shape', 'fill', 'svg1'],
      ['use', 'stroke', 'svg1'],
    ]);
    // One paint, one answer: the same adapted value in every rule.
    expect(new Set(result.changes.map((c) => c.adaptedValue)).size).toBe(1);
    expect(result.changes[0]?.adaptedValue).not.toBe(result.changes[0]?.originalValue);
    // The unit counts once, however many rules it has.
    expect(result.summary).toMatchObject({ adapted: 1, problemsDetected: 1 });
  });

  it('uses the same optimizer and the same answer as an HTML element with that pair', () => {
    const html: ElementDescriptor = {
      id: 'p',
      tagName: 'p',
      role: 'text',
      colorPair: { foreground: parseColor('#c0392b')!, background: parseColor('#27ae60')! },
      backgroundKind: 'solid',
      analysisStatus: 'resolved',
      isVisible: true,
      hasTextContent: true,
    };
    const result = plan([html, unit('svg1')]);
    const [textChange, svgChange] = result.changes;
    expect(svgChange?.adaptedValue).toBe(textChange?.adaptedValue);
    expect(svgChange?.metrics).toEqual(textChange?.metrics);
  });

  it('keeps the model confidence of the vision profile', () => {
    for (const profile of ['protanopia', 'deuteranopia', 'tritanopia', 'deuteranomaly'] as const) {
      const result = plan([unit('svg1')], { ...DEUTAN, visionProfile: profile });
      expect(result.confidence).toBe(VISION_PROFILE_CONFIDENCE[profile]);
      for (const change of result.changes) {
        expect(change.confidence).toBe(VISION_PROFILE_CONFIDENCE[profile]);
      }
    }
  });

  it('an unsupported SVG is unresolved and gets no rules, whatever the reason', () => {
    for (const unsupportedReason of [
      'paint-gradient',
      'paint-pattern',
      'mask',
      'multi-paint',
      'complex-svg',
      'use-shared-paint',
    ] as const) {
      const result = plan([
        unit('svg1', { unsupportedReason, targets: [] }, { analysisStatus: 'unsupported' }),
      ]);
      expect(result.changes).toEqual([]);
      expect(result.summary).toMatchObject({ unresolved: 1, adapted: 0 });
    }
  });

  it('even an inconsistent descriptor (reason set, targets present) is never adapted', () => {
    const result = plan([unit('svg1', { unsupportedReason: 'multi-paint' })]);
    expect(result.changes).toEqual([]);
    expect(result.summary.unresolved).toBe(1);
  });

  it('a partial analysis (translucent paint, unknown derivation) is unresolved', () => {
    for (const partialReason of ['translucent-paint', 'derivation-unknown'] as const) {
      const result = plan([
        unit('svg1', { partialReason, targets: [] }, { analysisStatus: 'partial' }),
      ]);
      expect(result.changes).toEqual([]);
      expect(result.summary.unresolved).toBe(1);
    }
  });

  it('a background that is not a solid color is unresolved, like any element', () => {
    const result = plan([
      unit('svg1', {}, { analysisStatus: 'unsupported', backgroundKind: 'gradient' }),
    ]);
    expect(result.changes).toEqual([]);
    expect(result.summary.unresolved).toBe(1);
  });

  it('an already distinguishable pair is unchanged', () => {
    const result = plan([
      unit(
        'svg1',
        {},
        {
          colorPair: { foreground: parseColor('#000000')!, background: parseColor('#ffffff')! },
        },
      ),
    ]);
    expect(result.changes).toEqual([]);
    expect(result.summary).toMatchObject({ unchanged: 1, adapted: 0 });
  });

  it('adaptSVG off, improveUIColors off, or the profile being normal: skipped / unchanged', () => {
    expect(plan([unit('s')], { ...DEUTAN, adaptSVG: false }).summary).toMatchObject({
      skipped: 1,
      adapted: 0,
    });
    expect(plan([unit('s')], { ...DEUTAN, improveUIColors: false }).summary).toMatchObject({
      skipped: 1,
    });
    const normal = plan([unit('s')], { ...DEUTAN, visionProfile: 'normal' });
    expect(normal.changes).toEqual([]);
    expect(plan([unit('s')], { ...DEUTAN, enabled: false }).summary.skipped).toBe(0);
  });

  it('no rule targets means nothing to do', () => {
    const result = plan([unit('svg1', { targets: [] })]);
    expect(result.changes).toEqual([]);
    expect(result.summary.skipped).toBe(1);
  });

  it('a descriptor of role svg/icon without unit info stays out of scope (nothing outside M5 changes)', () => {
    const bare: ElementDescriptor = { ...unit('x'), svg: undefined };
    expect(plan([bare]).summary.skipped).toBe(1);
  });

  it('strength 0 adapts nothing', () => {
    expect(plan([unit('svg1')], { ...DEUTAN, adaptationStrength: 0 }).changes).toEqual([]);
  });

  it('planElement reports the unit as one adapted outcome carrying all of its changes', () => {
    const context = createPlanningContext(DEUTAN);
    const outcome = planElement(
      unit('svg1', {
        targets: [
          { elementId: 'a', property: 'fill' },
          { elementId: 'b', property: 'fill' },
        ],
      }),
      context,
      new Map(),
    );
    expect(outcome.kind).toBe('adapted');
    if (outcome.kind === 'adapted') expect(outcome.changes).toHaveLength(2);
  });

  it('createDetailedAdaptationPlan keeps one outcome per unit', () => {
    const detailed = createDetailedAdaptationPlan(
      analysis([unit('svg1'), unit('svg2', { unsupportedReason: 'filter', targets: [] })]),
      DEUTAN,
    );
    expect([...detailed.outcomes.keys()]).toEqual(['svg1', 'svg2']);
    expect(detailed.outcomes.get('svg1')?.kind).toBe('adapted');
    expect(detailed.outcomes.get('svg2')?.kind).toBe('unresolved');
  });
});
