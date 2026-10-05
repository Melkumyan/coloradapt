import { VISION_PROFILES, type VisionProfile } from '@domain/models';
import { buildRecommendation } from './recommendation';
import { getRule } from './rules';
import { stableHash } from './privacy';
import { computeSeverity } from './severity';
import type {
  AuditAdaptationStatus,
  AuditAssessment,
  AuditCandidate,
  AuditConfidence,
  AuditEvidence,
  AuditRecommendation,
  AuditSeverity,
  AuditSimulation,
  AuditTargetInput,
} from './types';

/**
 * One problem on one element, after the rule registry and the severity model have been applied
 * but before elements of one component are grouped. Instances are what deduplication works on.
 */
export interface AuditInstance {
  /** `<ruleId>/<hash of rule, element identity, context>`: the same problem on the same element, every run. */
  readonly instanceId: string;
  /** What instances of one finding have in common (rule, component, context, assessment). */
  readonly groupKey: string;
  readonly ruleId: string;
  readonly target: AuditTargetInput;
  readonly context: string;
  readonly profiles: readonly VisionProfile[];
  readonly confidence: AuditConfidence;
  readonly assessment: AuditAssessment;
  readonly title: string;
  readonly summary: string;
  readonly evidence: readonly AuditEvidence[];
  readonly severity: AuditSeverity;
  readonly severityReasons: readonly string[];
  readonly adaptation: AuditAdaptationStatus;
  readonly simulations: readonly AuditSimulation[];
  readonly recommendation: AuditRecommendation;
}

const PROFILE_ORDER = new Map(VISION_PROFILES.map((profile, index) => [profile, index]));

export function compareProfiles(a: VisionProfile, b: VisionProfile): number {
  return (PROFILE_ORDER.get(a) ?? 99) - (PROFILE_ORDER.get(b) ?? 99);
}

/** The identity of a problem on an element. Profiles are *attributes*, not identity (see docs). */
export function instanceKey(
  candidate: Pick<AuditCandidate, 'ruleId' | 'context'> & { target: AuditTargetInput },
): string {
  return `${candidate.ruleId}|${candidate.target.key}|${candidate.context}`;
}

/** The id of one problem on one element: what `AuditAffected.instanceId` carries. */
export function instanceIdFor(
  candidate: Pick<AuditCandidate, 'ruleId' | 'context'> & { target: AuditTargetInput },
): string {
  return `${candidate.ruleId}/${stableHash(instanceKey(candidate))}`;
}

export function groupKeyOf(candidate: AuditCandidate): string {
  return `${candidate.ruleId}|${candidate.target.component}|${candidate.context}|${candidate.assessment}`;
}

/** Applies the registry and the severity model to a candidate. `null` for a rule that does not exist. */
export function toInstance(candidate: AuditCandidate): AuditInstance | null {
  const rule = getRule(candidate.ruleId);
  if (!rule) return null;
  const severity = computeSeverity({
    base: rule.defaultSeverity,
    assessment: candidate.assessment,
    confidence: candidate.confidence,
    factors: candidate.factors,
    adaptation: candidate.adaptation,
    modelConfidence: candidate.simulation?.modelConfidence ?? null,
  });
  return {
    instanceId: instanceIdFor(candidate),
    groupKey: groupKeyOf(candidate),
    ruleId: candidate.ruleId,
    target: candidate.target,
    context: candidate.context,
    profiles: candidate.profile === null ? [] : [candidate.profile],
    confidence: candidate.confidence,
    assessment: candidate.assessment,
    title: candidate.title ?? rule.title,
    summary: candidate.summary,
    evidence: candidate.evidence,
    severity: severity.severity,
    severityReasons: severity.reasons,
    adaptation: candidate.adaptation,
    simulations: candidate.simulation ? [candidate.simulation] : [],
    recommendation: buildRecommendation(candidate.ruleId, candidate.recommendation),
  };
}
