import { compareProfiles, type AuditInstance } from './finding';
import { stableHash } from './privacy';
import { getRule } from './rules';
import { severityRank, worstAdaptation } from './severity';
import {
  AUDIT_CONFIDENCES,
  AUDIT_LIMITS,
  SOURCE_NOTE,
  type AuditAdaptationStatus,
  type AuditAffected,
  type AuditFinding,
} from './types';

/**
 * Grouping (docs/DEVELOPER_AUDIT.md, "Grouping"): a hundred table rows with the same red/green
 * status dot are one finding that affects a hundred elements, not a hundred findings. Instances
 * group by rule, component signature and context (state, trigger, ...).
 *
 * - the count is exact; the elements listed are the first {@link AUDIT_LIMITS.sampleTargets},
 *   most severe first;
 * - severity is the most severe member's: it is never summed or multiplied by the count (frequency
 *   is `affectedCount`, a separate fact);
 * - confidence is the lowest member's.
 */

const CONFIDENCE_RANK = new Map(AUDIT_CONFIDENCES.map((c, i) => [c, i]));

export function compareInstances(a: AuditInstance, b: AuditInstance): number {
  return (
    severityRank(b.severity) - severityRank(a.severity) ||
    a.target.locator.path.localeCompare(b.target.locator.path) ||
    a.instanceId.localeCompare(b.instanceId)
  );
}

/** Stable finding order: issues before reviews before limitations, then severity, then size. */
const ASSESSMENT_ORDER = { issue: 0, 'manual-review': 1, 'analysis-limitation': 2 } as const;

export function compareFindings(a: AuditFinding, b: AuditFinding): number {
  return (
    severityRank(b.severity) - severityRank(a.severity) ||
    ASSESSMENT_ORDER[a.assessment] - ASSESSMENT_ORDER[b.assessment] ||
    a.ruleId.localeCompare(b.ruleId) ||
    b.affectedCount - a.affectedCount ||
    a.id.localeCompare(b.id)
  );
}

function toAffected(instance: AuditInstance): AuditAffected {
  return {
    instanceId: instance.instanceId,
    locator: instance.target.locator,
    severity: instance.severity,
    adaptationStatus: instance.adaptation,
    evidence: instance.evidence,
  };
}

function toFinding(members: readonly AuditInstance[]): AuditFinding | null {
  const ordered = [...members].sort(compareInstances);
  const lead = ordered[0];
  if (!lead) return null;
  const rule = getRule(lead.ruleId);
  if (!rule) return null;

  const profiles = [...new Set(ordered.flatMap((m) => m.profiles))].sort(compareProfiles);
  const simulation = [
    ...new Map(ordered.flatMap((m) => m.simulations).map((s) => [s.profile, s])).values(),
  ].sort((a, b) => compareProfiles(a.profile, b.profile));
  const breakdown: Partial<Record<AuditAdaptationStatus, number>> = {};
  for (const member of ordered)
    breakdown[member.adaptation] = (breakdown[member.adaptation] ?? 0) + 1;
  const lowest = ordered.reduce(
    (low, m) =>
      (CONFIDENCE_RANK.get(m.confidence) ?? 0) > (CONFIDENCE_RANK.get(low) ?? 0)
        ? m.confidence
        : low,
    lead.confidence,
  );
  const sample = ordered.slice(0, AUDIT_LIMITS.sampleTargets);

  return {
    id: `${lead.ruleId}:${stableHash(lead.groupKey)}`,
    ruleId: lead.ruleId,
    category: rule.category,
    subcategory: rule.subcategory,
    severity: lead.severity,
    severityReasons: lead.severityReasons,
    confidence: lowest,
    assessment: lead.assessment,
    title: lead.title,
    summary: lead.summary,
    evidence: lead.evidence,
    affectedCount: ordered.length,
    affected: sample.map(toAffected),
    recommendation: lead.recommendation,
    source: rule.source,
    visionProfiles: profiles,
    simulation,
    adaptationStatus: worstAdaptation(ordered.map((m) => m.adaptation)),
    adaptationBreakdown: breakdown,
    sourceNote: SOURCE_NOTE,
    wcag: rule.wcag,
  };
}

export interface GroupedInstances {
  readonly findings: AuditFinding[];
  /** Per finding id: every member's instance id, in the order the finding lists its elements. */
  readonly members: ReadonlyMap<string, readonly string[]>;
}

/** Groups deduplicated instances into findings, in {@link compareFindings} order. */
export function groupInstances(instances: readonly AuditInstance[]): GroupedInstances {
  const groups = new Map<string, AuditInstance[]>();
  for (const instance of instances) {
    const list = groups.get(instance.groupKey);
    if (list) list.push(instance);
    else groups.set(instance.groupKey, [instance]);
  }
  const findings: AuditFinding[] = [];
  const members = new Map<string, readonly string[]>();
  for (const group of groups.values()) {
    const finding = toFinding(group);
    if (!finding) continue;
    findings.push(finding);
    members.set(
      finding.id,
      [...group].sort(compareInstances).map((m) => m.instanceId),
    );
  }
  return { findings: findings.sort(compareFindings), members };
}
