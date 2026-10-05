import { evidence } from './evidence';
import type { AuditCandidate, AuditTargetInput } from './types';

/**
 * CA-GEN-001: the page has more candidates than one audit pass looks at (`reasons` names which
 * budgets ended). A limitation of the audit, never a statement about the page.
 */
export function evaluateCoverage(
  reasons: readonly string[],
  analyzed: number,
  target: AuditTargetInput,
): AuditCandidate[] {
  if (reasons.length === 0) return [];
  return [
    {
      ruleId: 'CA-GEN-001',
      target,
      context: 'budget',
      profile: null,
      confidence: 'HIGH',
      assessment: 'analysis-limitation',
      summary: `The audit stopped at a size budget (${reasons.join(', ')}); part of the page was not audited.`,
      evidence: [
        evidence.number('coverage.analyzed', 'observed-fact', 'Elements analyzed', analyzed),
        evidence.list('coverage.limits', 'observed-fact', 'Budgets that ended the pass', reasons),
      ],
      factors: {
        functionalImpact: 'none',
        informationLoss: 'none',
        interactive: false,
        redundancy: 'unknown',
      },
      adaptation: 'not-applicable',
      simulation: null,
      recommendation: { adaptation: 'not-applicable' },
    },
  ];
}
