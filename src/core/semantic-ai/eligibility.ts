import type { AuditFinding, AuditSeverity } from '@core/audit';
import { taskForState } from './evidence-rules';
import type { SemanticTask } from './taxonomy';

/**
 * Which findings may be put to the model at all (docs/AI_SEMANTIC_ENGINE.md, "Eligibility").
 * Exactly the cases the deterministic layers left to a human: `manual-review` findings of a
 * handful of rules. A confirmed `issue`, an analysis limitation and anything clean are never
 * eligible, so they cost no request and can never be influenced by one.
 */
export const ELIGIBLE_RULES: readonly string[] = [
  /** A state guessed from class names or words, carried by color only. */
  'CA-SEM-002',
  /** An inline SVG ColorAdapt cannot analyze. */
  'CA-SVG-002',
  /** A chart legend that cannot be paired with its series. */
  'CA-CHART-002',
  /** A chart type or paint the chart layer does not audit. */
  'CA-CHART-003',
  /** A canvas that looks like a chart. */
  'CA-CHART-004',
  /** A raster chart. */
  'CA-IMG-002',
  /** A functional image that could not be read. */
  'CA-IMG-003',
];

export function isEligibleFinding(finding: Pick<AuditFinding, 'ruleId' | 'assessment'>): boolean {
  return finding.assessment === 'manual-review' && ELIGIBLE_RULES.includes(finding.ruleId);
}

export interface TaskChoice {
  /** The M6 state the semantic layer inferred (CA-SEM-002). */
  readonly state?: string;
  readonly interactive: boolean;
}

/** The task a rule's case becomes; `null` when the rule has none. */
export function chooseTask(ruleId: string, choice: TaskChoice): SemanticTask | null {
  switch (ruleId) {
    case 'CA-SEM-002':
      return choice.state ? taskForState(choice.state) : null;
    case 'CA-SVG-002':
      return choice.interactive ? 'CLASSIFY_CONTROL_ICON' : 'ASSESS_COLOR_DEPENDENCE';
    case 'CA-CHART-002':
      return 'MAP_CHART_LABEL';
    case 'CA-CHART-003':
    case 'CA-CHART-004':
    case 'CA-IMG-002':
      return 'ASSESS_MANUAL_REVIEW_CASE';
    case 'CA-IMG-003':
      return choice.interactive ? 'CLASSIFY_CONTROL_ICON' : 'ASSESS_MANUAL_REVIEW_CASE';
    default:
      return null;
  }
}

const SEVERITY_WEIGHT: Readonly<Record<AuditSeverity, number>> = {
  critical: 50,
  high: 40,
  medium: 30,
  low: 20,
  info: 10,
};

/** Severity first, then controls a user operates, then how many elements share the case. */
export function priorityOf(
  finding: Pick<AuditFinding, 'severity' | 'affectedCount'>,
  interactive: boolean,
): number {
  return (
    SEVERITY_WEIGHT[finding.severity] + (interactive ? 5 : 0) + Math.min(finding.affectedCount, 4)
  );
}
