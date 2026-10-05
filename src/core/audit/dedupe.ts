import { compareProfiles, type AuditInstance } from './finding';
import { severityRank, worstAdaptation } from './severity';
import { AUDIT_CONFIDENCES, type AuditConfidence, type AuditEvidence } from './types';

/**
 * Deduplication (docs/DEVELOPER_AUDIT.md, "Identity and deduplication"): one problem on one
 * element is one instance, however many times the page was analyzed and however many vision
 * profiles it shows up under. Instances with the same id are merged:
 *
 * - profiles and simulations are united (sorted in profile order);
 * - evidence is united by key (the first one wins), in a fixed order;
 * - severity and its reasons come from the most severe of them;
 * - confidence is the lowest (the audit claims no more than its weakest observation);
 * - the adaptation status is the least resolved one, ignoring `not-applicable` entries (a
 *   profile ColorAdapt does not adapt for says nothing about what it did for the active one).
 */

function lowestConfidence(a: AuditConfidence, b: AuditConfidence): AuditConfidence {
  return AUDIT_CONFIDENCES.indexOf(a) >= AUDIT_CONFIDENCES.indexOf(b) ? a : b;
}

function uniqueEvidence(lists: readonly (readonly AuditEvidence[])[]): AuditEvidence[] {
  const seen = new Set<string>();
  const merged: AuditEvidence[] = [];
  for (const list of lists) {
    for (const item of list) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      merged.push(item);
    }
  }
  return merged;
}

function mergeGroup(group: readonly AuditInstance[]): AuditInstance {
  const first = group[0] as AuditInstance;
  if (group.length === 1) return first;
  const ordered = [...group].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      compareProfiles(a.profiles[0] ?? 'normal', b.profiles[0] ?? 'normal'),
  );
  const lead = ordered[0] as AuditInstance;
  const profiles = [...new Set(group.flatMap((instance) => instance.profiles))].sort(
    compareProfiles,
  );
  const simulations = [
    ...new Map(
      group.flatMap((instance) => instance.simulations).map((s) => [s.profile, s]),
    ).values(),
  ].sort((a, b) => compareProfiles(a.profile, b.profile));
  const real = group
    .map((instance) => instance.adaptation)
    .filter((status) => status !== 'not-applicable');
  return {
    ...lead,
    profiles,
    simulations,
    evidence: uniqueEvidence(ordered.map((instance) => instance.evidence)),
    confidence: group.map((instance) => instance.confidence).reduce(lowestConfidence),
    adaptation: real.length > 0 ? worstAdaptation(real) : 'not-applicable',
  };
}

/** Merges instances with the same id. Output order follows the first appearance of each id. */
export function dedupeInstances(instances: readonly AuditInstance[]): AuditInstance[] {
  const byId = new Map<string, AuditInstance[]>();
  for (const instance of instances) {
    const list = byId.get(instance.instanceId);
    if (list) list.push(instance);
    else byId.set(instance.instanceId, [instance]);
  }
  return [...byId.values()].map(mergeGroup);
}
