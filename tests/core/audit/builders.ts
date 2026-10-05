import {
  type AuditCandidate,
  type AuditLocator,
  type AuditTargetInput,
  type SeverityFactors,
} from '@core/audit';

export const FACTORS: SeverityFactors = {
  functionalImpact: 'moderate',
  informationLoss: 'partial',
  interactive: false,
  redundancy: 'unknown',
};

export function locator(path: string, extra: Partial<AuditLocator> = {}): AuditLocator {
  const tag = path.split('>').pop()?.split(':')[0]?.replace('#', '') ?? 'div';
  return { tag, id: null, classes: [], role: null, inputType: null, text: null, path, ...extra };
}

export function target(
  path: string,
  component = 'div',
  extra: Partial<AuditLocator> = {},
): AuditTargetInput {
  return { key: path, locator: locator(path, extra), component };
}

export function candidate(overrides: Partial<AuditCandidate> = {}): AuditCandidate {
  return {
    ruleId: 'CA-COLOR-001',
    target: target('html>body>p:nth-of-type(1)', 'p'),
    context: '',
    profile: null,
    confidence: 'HIGH',
    assessment: 'issue',
    summary: 'Text contrast is 2.00:1; target 4.5:1.',
    evidence: [
      {
        key: 'contrast.ratio',
        basis: 'observed-fact',
        label: 'Contrast ratio',
        value: { kind: 'number', value: 2, unit: ':1' },
      },
    ],
    factors: FACTORS,
    adaptation: 'not-enabled',
    simulation: null,
    recommendation: { adaptation: 'not-enabled' },
    ...overrides,
  };
}
