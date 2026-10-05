import type { ModelConfidence } from '@domain/models';
import {
  AUDIT_ADAPTATION_STATUSES,
  AUDIT_SEVERITIES,
  type AuditAdaptationStatus,
  type AuditAssessment,
  type AuditConfidence,
  type AuditSeverity,
  type SeverityFactors,
} from './types';

/**
 * The severity model (docs/DEVELOPER_AUDIT.md, "Severity"): the only place a severity is decided.
 *
 * Severity answers "how much would this hurt a user who cannot rely on the color", never "how
 * sure is the audit" (that is confidence) and never "how many elements" (that is the affected
 * count: ten repeated mediums are not a critical). It starts from the rule's default and moves
 * with documented, centralized steps; every step is returned as a reason, so a developer can
 * see why.
 *
 * ```
 * analysis-limitation               -> info, always
 * manual-review                     -> at most low
 * issue:
 *   information loss total          +1        none  -1
 *   functional impact major         +1        none  -1
 *   non-color redundancy present    -1
 *   ColorAdapt found no safe fix    +1
 *   confidence LOW  -> at most medium     MEDIUM -> at most high
 *   estimate from a model other than SUPPORTED_MODEL -> at most high
 *   critical only when: confidence HIGH, information loss total, element is interactive
 *   an issue is never below low
 * ```
 */

const RANK: Readonly<Record<AuditSeverity, number>> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function severityRank(severity: AuditSeverity): number {
  return RANK[severity];
}

/** Compares for sorting: most severe first. */
export function compareSeverity(a: AuditSeverity, b: AuditSeverity): number {
  return RANK[b] - RANK[a];
}

function fromRank(rank: number): AuditSeverity {
  return AUDIT_SEVERITIES[AUDIT_SEVERITIES.length - 1 - Math.max(0, Math.min(4, rank))] ?? 'info';
}

export interface SeverityInput {
  readonly base: AuditSeverity;
  readonly assessment: AuditAssessment;
  readonly confidence: AuditConfidence;
  readonly factors: SeverityFactors;
  readonly adaptation: AuditAdaptationStatus;
  /** The model confidence of the simulation behind the finding, or null when it uses none. */
  readonly modelConfidence: ModelConfidence | null;
}

export interface SeverityResult {
  readonly severity: AuditSeverity;
  readonly reasons: readonly string[];
}

export function computeSeverity(input: SeverityInput): SeverityResult {
  const { assessment, confidence, factors, adaptation, modelConfidence } = input;
  if (assessment === 'analysis-limitation') {
    return {
      severity: 'info',
      reasons: ['An analysis limitation says nothing about the page: informational only.'],
    };
  }
  if (assessment === 'manual-review') {
    const capped = fromRank(Math.min(RANK[input.base], RANK.low));
    return {
      severity: capped,
      reasons: [`Needs a human decision, so it is never above low (rule default ${input.base}).`],
    };
  }

  const reasons: string[] = [`Rule default: ${input.base}.`];
  let rank = RANK[input.base];
  if (factors.informationLoss === 'total') {
    rank += 1;
    reasons.push('+1: the information the element carries is lost entirely without the color.');
  } else if (factors.informationLoss === 'none') {
    rank -= 1;
    reasons.push('-1: no information is lost.');
  }
  if (factors.functionalImpact === 'major') {
    rank += 1;
    reasons.push('+1: a user cannot operate or understand an important part of the page.');
  } else if (factors.functionalImpact === 'none') {
    rank -= 1;
    reasons.push('-1: no functional impact.');
  }
  if (factors.redundancy === 'present') {
    rank -= 1;
    reasons.push('-1: another, non-color way to tell things apart already exists.');
  }
  if (adaptation === 'no-safe-candidate') {
    rank += 1;
    reasons.push('+1: ColorAdapt searched and found no change it can make safely.');
  }

  const caps: Array<[number, string]> = [];
  if (confidence === 'LOW') caps.push([RANK.medium, 'Capped at medium: confidence is LOW.']);
  if (confidence === 'MEDIUM') caps.push([RANK.high, 'Capped at high: confidence is MEDIUM.']);
  if (modelConfidence !== null && modelConfidence !== 'SUPPORTED_MODEL') {
    caps.push([RANK.high, `Capped at high: the simulation model is ${modelConfidence}.`]);
  }
  // A non-color way to tell things apart contradicts "total" loss; it can never be critical.
  const criticalAllowed =
    confidence === 'HIGH' &&
    factors.informationLoss === 'total' &&
    factors.interactive &&
    factors.redundancy !== 'present';
  if (!criticalAllowed) {
    caps.push([
      RANK.high,
      'Not critical: critical needs HIGH confidence, total information loss and an interactive element with no non-color redundancy.',
    ]);
  }
  for (const [limit, reason] of caps) {
    if (rank > limit) {
      rank = limit;
      reasons.push(reason);
    }
  }
  if (rank < RANK.low) {
    rank = RANK.low;
    reasons.push('An issue is never below low.');
  }
  return { severity: fromRank(rank), reasons };
}

/**
 * Which status wins when one finding covers elements with different ones: the least resolved.
 * A finding is `adapted` only when every element it covers is.
 */
export const ADAPTATION_PRECEDENCE: readonly AuditAdaptationStatus[] = [
  'no-safe-candidate',
  'not-applied',
  'unsupported',
  'not-enabled',
  'not-applicable',
  'adapted',
  'not-needed',
];

if (ADAPTATION_PRECEDENCE.length !== AUDIT_ADAPTATION_STATUSES.length) {
  throw new Error('ADAPTATION_PRECEDENCE must list every adaptation status');
}

export function worstAdaptation(statuses: Iterable<AuditAdaptationStatus>): AuditAdaptationStatus {
  let best = ADAPTATION_PRECEDENCE.length;
  for (const status of statuses) best = Math.min(best, ADAPTATION_PRECEDENCE.indexOf(status));
  return ADAPTATION_PRECEDENCE[best] ?? 'not-applicable';
}
