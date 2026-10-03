import { describe, expect, it } from 'vitest';
import { createAdaptationPlan } from '@core/adaptation';
import { parseColor } from '@core/color';
import { DEFAULT_USER_SETTINGS } from '@domain/models';
import type {
  AnalysisResult,
  AnalysisStatus,
  ElementDescriptor,
  ElementRole,
  UserSettings,
} from '@domain/models';

const DEUTAN: UserSettings = {
  ...DEFAULT_USER_SETTINGS,
  visionProfile: 'deuteranopia',
  adaptationStrength: 1,
};

function element(id: string, overrides: Partial<ElementDescriptor> = {}): ElementDescriptor {
  return {
    id,
    tagName: 'p',
    role: 'text',
    colorPair: { foreground: parseColor('#c0392b')!, background: parseColor('#27ae60')! },
    backgroundKind: 'solid',
    analysisStatus: 'resolved',
    isVisible: true,
    hasTextContent: true,
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

describe('createAdaptationPlan', () => {
  it('produces a data-only change per adapted element, with provenance and metrics', () => {
    const plan = createAdaptationPlan(analysis([element('a')]), DEUTAN);
    expect(plan.changes).toHaveLength(1);
    const [change] = plan.changes;
    expect(change).toMatchObject({
      elementId: 'a',
      property: 'color',
      originalValue: '#c0392b',
      confidence: 'SUPPORTED_MODEL',
    });
    expect(change?.adaptedValue).toMatch(/^#[0-9a-f]{6}$/);
    expect(change?.reason).toMatch(/estimated distinguishability/i);
    expect(plan.profile).toBe('deuteranopia');
    expect(plan.confidence).toBe('SUPPORTED_MODEL');
    expect(plan.summary).toMatchObject({ adapted: 1, problemsDetected: 1, unresolved: 0 });
  });

  it.each<AnalysisStatus>(['partial', 'unsupported'])(
    'never adapts %s analysis; it is reported as unresolved',
    (status) => {
      const plan = createAdaptationPlan(
        analysis([element('a', { analysisStatus: status })]),
        DEUTAN,
      );
      expect(plan.changes).toHaveLength(0);
      expect(plan.summary.unresolved).toBe(1);
      expect(plan.summary.adapted).toBe(0);
    },
  );

  it.each<ElementRole>(['svg', 'image', 'chart', 'icon'])('skips out-of-scope role %s', (role) => {
    const plan = createAdaptationPlan(analysis([element('a', { role })]), DEUTAN);
    expect(plan.changes).toHaveLength(0);
    expect(plan.summary.skipped).toBe(1);
  });

  it('skips disabled elements and elements without text', () => {
    const plan = createAdaptationPlan(
      analysis([element('a', { disabled: true }), element('b', { hasTextContent: false })]),
      DEUTAN,
    );
    expect(plan.changes).toHaveLength(0);
    expect(plan.summary.skipped).toBe(2);
  });

  it('counts accessible pairs as unchanged, not as problems', () => {
    const plan = createAdaptationPlan(
      analysis([
        element('a', {
          colorPair: { foreground: parseColor('#000')!, background: parseColor('#fff')! },
        }),
      ]),
      DEUTAN,
    );
    expect(plan.changes).toHaveLength(0);
    expect(plan.summary).toMatchObject({ unchanged: 1, problemsDetected: 0 });
  });

  it('reports no-safe-candidate counts instead of forcing a change', () => {
    const plan = createAdaptationPlan(analysis([element('a')]), DEUTAN, {
      constraints: { maxDesignChange: 0.001 },
    });
    expect(plan.changes).toHaveLength(0);
    expect(plan.summary).toMatchObject({ noSafeCandidate: 1, problemsDetected: 1, adapted: 0 });
  });

  it('plans nothing when disabled, at strength 0, for normal vision', () => {
    const els = analysis([element('a')]);
    expect(createAdaptationPlan(els, { ...DEUTAN, enabled: false }).changes).toHaveLength(0);
    expect(createAdaptationPlan(els, { ...DEUTAN, adaptationStrength: 0 }).changes).toHaveLength(0);
    expect(createAdaptationPlan(els, { ...DEUTAN, visionProfile: 'normal' }).changes).toHaveLength(
      0,
    );
  });

  it('treats a non-finite strength as 0 (fail-safe) and clamps out-of-range values', () => {
    const els = analysis([element('a')]);
    expect(
      createAdaptationPlan(els, { ...DEUTAN, adaptationStrength: Number.NaN }).changes,
    ).toHaveLength(0);
    const clamped = createAdaptationPlan(els, { ...DEUTAN, adaptationStrength: 5 });
    expect(clamped.strength).toBe(1);
    expect(clamped.changes).toHaveLength(1);
  });

  it('marks every element of the custom profile unresolved', () => {
    const plan = createAdaptationPlan(analysis([element('a'), element('b')]), {
      ...DEUTAN,
      visionProfile: 'custom',
    });
    expect(plan.changes).toHaveLength(0);
    expect(plan.summary.unresolved).toBe(2);
    expect(plan.confidence).toBe('UNSUPPORTED');
  });

  it('keeps model confidence on every change of an anomalous profile', () => {
    const plan = createAdaptationPlan(
      analysis([
        element('a', {
          colorPair: { foreground: parseColor('#ddd')!, background: parseColor('#fff')! },
        }),
      ]),
      { ...DEUTAN, visionProfile: 'deuteranomaly' },
    );
    expect(plan.changes[0]?.confidence).toBe('MODEL_ASSUMPTION');
    expect(plan.confidence).toBe('MODEL_ASSUMPTION');
  });

  it('respects the per-category settings', () => {
    const els = analysis([
      element('link', { role: 'link' }),
      element('badge', { role: 'badge' }),
      element('text'),
    ]);
    const off = createAdaptationPlan(els, {
      ...DEUTAN,
      improveLinks: false,
      improveStatusIndicators: false,
      improveUIColors: false,
    });
    expect(off.changes).toHaveLength(0);
    expect(off.summary.skipped).toBe(3);

    const linksOnly = createAdaptationPlan(els, {
      ...DEUTAN,
      improveStatusIndicators: false,
      improveUIColors: false,
    });
    expect(linksOnly.changes.map((c) => c.elementId)).toEqual(['link']);
  });

  it('is deterministic and gives identical elements identical colors', () => {
    const els = analysis([element('a'), element('b'), element('c')]);
    const one = createAdaptationPlan(els, DEUTAN);
    const two = createAdaptationPlan(els, DEUTAN);
    expect(two).toEqual(one);
    expect(new Set(one.changes.map((c) => c.adaptedValue)).size).toBe(1);
  });
});
