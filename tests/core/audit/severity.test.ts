import { describe, expect, it } from 'vitest';
import {
  ADAPTATION_PRECEDENCE,
  AUDIT_ADAPTATION_STATUSES,
  AUDIT_RULES,
  AUDIT_SEVERITIES,
  compareSeverity,
  computeSeverity,
  severityRank,
  worstAdaptation,
  type SeverityInput,
} from '@core/audit';
import { FACTORS } from './builders';

const input = (overrides: Partial<SeverityInput> = {}): SeverityInput => ({
  base: 'medium',
  assessment: 'issue',
  confidence: 'HIGH',
  factors: FACTORS,
  adaptation: 'not-enabled',
  modelConfidence: null,
  ...overrides,
});

const LOUD = {
  ...FACTORS,
  informationLoss: 'total' as const,
  functionalImpact: 'major' as const,
  interactive: true,
};

describe('severity model', () => {
  it('starts from the rule default and explains itself', () => {
    const result = computeSeverity(input());
    expect(result.severity).toBe('medium');
    expect(result.reasons[0]).toContain('Rule default');
  });

  it('never rates an analysis limitation above info, whatever else is true', () => {
    for (const base of AUDIT_SEVERITIES) {
      const result = computeSeverity(
        input({ base, assessment: 'analysis-limitation', factors: LOUD }),
      );
      expect(result.severity).toBe('info');
    }
  });

  it('never rates a manual review above low', () => {
    for (const base of AUDIT_SEVERITIES) {
      const severity = computeSeverity(
        input({ base, assessment: 'manual-review', factors: LOUD }),
      ).severity;
      expect(severityRank(severity)).toBeLessThanOrEqual(severityRank('low'));
    }
  });

  it('is never below low for an issue', () => {
    const result = computeSeverity(
      input({
        base: 'info',
        factors: {
          ...FACTORS,
          informationLoss: 'none',
          functionalImpact: 'none',
          redundancy: 'present',
        },
      }),
    );
    expect(result.severity).toBe('low');
  });

  it('raises for total information loss, major impact and a missing safe fix', () => {
    expect(
      computeSeverity(input({ factors: { ...FACTORS, informationLoss: 'total' } })).severity,
    ).toBe('high');
    expect(
      computeSeverity(input({ factors: { ...FACTORS, functionalImpact: 'major' } })).severity,
    ).toBe('high');
    expect(computeSeverity(input({ adaptation: 'no-safe-candidate' })).severity).toBe('high');
  });

  it('lowers when a non-color redundancy exists', () => {
    expect(
      computeSeverity(input({ factors: { ...FACTORS, redundancy: 'present' } })).severity,
    ).toBe('low');
  });

  it('is critical only with HIGH confidence, total loss and an interactive element', () => {
    expect(computeSeverity(input({ factors: LOUD })).severity).toBe('critical');
    expect(computeSeverity(input({ factors: LOUD, confidence: 'MEDIUM' })).severity).toBe('high');
    expect(computeSeverity(input({ factors: { ...LOUD, interactive: false } })).severity).toBe(
      'high',
    );
    expect(
      computeSeverity(input({ factors: { ...LOUD, informationLoss: 'partial' } })).severity,
    ).not.toBe('critical');
  });

  it('caps by confidence: LOW at medium, MEDIUM at high', () => {
    expect(computeSeverity(input({ factors: LOUD, confidence: 'LOW' })).severity).toBe('medium');
    expect(computeSeverity(input({ factors: LOUD, confidence: 'MEDIUM' })).severity).toBe('high');
  });

  it('caps a finding built on a weaker simulation model at high (no critical on an approximation)', () => {
    expect(
      computeSeverity(input({ factors: LOUD, modelConfidence: 'SUPPORTED_MODEL' })).severity,
    ).toBe('critical');
    for (const model of ['MODEL_ASSUMPTION', 'APPROXIMATION', 'UNSUPPORTED'] as const) {
      expect(computeSeverity(input({ factors: LOUD, modelConfidence: model })).severity).toBe(
        'high',
      );
    }
  });

  it('keeps severity and confidence independent: HIGH severity with MEDIUM confidence exists', () => {
    const result = computeSeverity(
      input({
        confidence: 'MEDIUM',
        factors: { ...FACTORS, informationLoss: 'total', functionalImpact: 'major' },
      }),
    );
    expect(result.severity).toBe('high');
  });

  it('orders severities most severe first', () => {
    expect([...AUDIT_SEVERITIES].sort(compareSeverity)).toEqual([
      'critical',
      'high',
      'medium',
      'low',
      'info',
    ]);
  });

  it('gives every rule a default no higher than high (critical is earned, not assigned)', () => {
    for (const rule of Object.values(AUDIT_RULES)) {
      expect(severityRank(rule.defaultSeverity)).toBeLessThanOrEqual(severityRank('high'));
    }
  });

  it('ranks "least resolved" first when one finding covers elements with different statuses', () => {
    expect(ADAPTATION_PRECEDENCE).toHaveLength(AUDIT_ADAPTATION_STATUSES.length);
    expect(worstAdaptation(['adapted', 'no-safe-candidate', 'not-needed'])).toBe(
      'no-safe-candidate',
    );
    expect(worstAdaptation(['adapted', 'adapted'])).toBe('adapted');
    expect(worstAdaptation([])).toBe('not-applicable');
  });
});

describe('severity calibration (a ranking a developer would agree with)', () => {
  const rank = (i: Partial<SeverityInput>) => severityRank(computeSeverity(input(i)).severity);

  it('a color-only invalid state on a form field outranks an unsupported decorative SVG', () => {
    const invalidField = rank({
      factors: {
        functionalImpact: 'major',
        informationLoss: 'total',
        interactive: true,
        redundancy: 'absent',
      },
    });
    const unsupportedSvg = rank({
      base: 'info',
      assessment: 'manual-review',
      factors: { ...FACTORS, functionalImpact: 'none' },
    });
    expect(invalidField).toBeGreaterThan(unsupportedSvg);
  });

  it('a canvas chart (manual review) never outranks a text contrast issue', () => {
    expect(rank({ base: 'info', assessment: 'manual-review' })).toBeLessThan(rank({}));
  });

  it('a repeated medium stays medium: frequency is not an input', () => {
    expect(computeSeverity(input()).severity).toBe(computeSeverity(input()).severity);
  });
});
