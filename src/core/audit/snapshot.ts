import { buildSubsystemCoverage } from './coverage';
import { dedupeInstances } from './dedupe';
import { toInstance, type AuditInstance } from './finding';
import { groupInstances } from './grouping';
import {
  AUDIT_ADAPTATION_STATUSES,
  AUDIT_ASSESSMENTS,
  AUDIT_CATEGORIES,
  AUDIT_CONFIDENCES,
  AUDIT_LIMITS,
  AUDIT_SCHEMA_VERSION,
  AUDIT_SEVERITIES,
  type AuditCandidate,
  type AuditCoverage,
  type AuditFinding,
  type AuditPageInfo,
  type AuditSettingsInfo,
  type AuditSnapshot,
  type AuditSummary,
} from './types';

function zeroed<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

/**
 * Counts, never a score. A single "accessibility score" would hide exactly what a developer
 * needs (which problems, how bad, how sure) behind a number ColorAdapt has no basis for
 * (docs/DEVELOPER_AUDIT.md, "No score").
 */
export function summarize(findings: readonly AuditFinding[]): AuditSummary {
  const bySeverity = zeroed(AUDIT_SEVERITIES);
  const byCategory = zeroed(AUDIT_CATEGORIES);
  const byConfidence = zeroed(AUDIT_CONFIDENCES);
  const byAssessment = zeroed(AUDIT_ASSESSMENTS);
  const byAdaptation = zeroed(AUDIT_ADAPTATION_STATUSES);
  let affectedElements = 0;
  let adapted = 0;
  let unresolved = 0;
  let manualReview = 0;
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
    byCategory[finding.category] += 1;
    byConfidence[finding.confidence] += 1;
    byAssessment[finding.assessment] += 1;
    byAdaptation[finding.adaptationStatus] += 1;
    affectedElements += finding.affectedCount;
    if (finding.assessment === 'manual-review') manualReview += 1;
    if (finding.assessment === 'issue') {
      if (finding.adaptationStatus === 'adapted') adapted += 1;
      else unresolved += 1;
    }
  }
  return {
    findings: findings.length,
    affectedElements,
    bySeverity,
    byCategory,
    byConfidence,
    byAssessment,
    byAdaptation,
    adapted,
    unresolved,
    manualReview,
  };
}

export interface SnapshotInput {
  readonly candidates: readonly AuditCandidate[];
  readonly generation: number;
  readonly timestamp: number;
  readonly page: AuditPageInfo;
  readonly extensionVersion: string;
  readonly settings: AuditSettingsInfo;
  /**
   * What the collector measured. `budgetsReached` (default none) and `imagePixelAudit` (default
   * false: the conservative answer) are optional so a caller that knows neither still discloses
   * the limited case.
   */
  readonly coverage: Omit<AuditCoverage, 'truncatedFindings' | 'subsystems' | 'budgetsReached'> & {
    readonly budgetsReached?: readonly string[];
    readonly imagePixelAudit?: boolean;
  };
}

export interface BuiltSnapshot {
  readonly snapshot: AuditSnapshot;
  /** Per finding id: every covered element's instance id, in listing order (for navigation and highlighting). */
  readonly members: ReadonlyMap<string, readonly string[]>;
}

/**
 * The whole pipeline in one pure function: candidates -> severity and registry -> deduplication
 * -> grouping -> summary. The same candidates always give the same snapshot (apart from the
 * `generation` and `timestamp` the caller passes in).
 */
export function buildSnapshot(input: SnapshotInput): BuiltSnapshot {
  const instances: AuditInstance[] = [];
  for (const candidate of input.candidates) {
    const instance = toInstance(candidate);
    if (instance) instances.push(instance);
  }
  const grouped = groupInstances(dedupeInstances(instances));
  // Findings beyond the cap are counted, never silently dropped: the least severe are the ones cut.
  const kept = grouped.findings.slice(0, AUDIT_LIMITS.maxFindings);
  const members = new Map<string, readonly string[]>();
  for (const finding of kept) members.set(finding.id, grouped.members.get(finding.id) ?? []);
  const truncatedFindings = grouped.findings.length - kept.length;
  const { imagePixelAudit, budgetsReached, ...measured } = input.coverage;
  const budgets = [...(budgetsReached ?? [])].sort();
  const snapshot: AuditSnapshot = {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    generation: input.generation,
    timestamp: input.timestamp,
    page: input.page,
    extensionVersion: input.extensionVersion,
    settings: input.settings,
    coverage: {
      ...measured,
      budgetsReached: budgets,
      truncatedFindings,
      subsystems: buildSubsystemCoverage({
        analysisTruncated: measured.analysisTruncated,
        elementsAnalyzed: measured.elementsAnalyzed,
        budgetsReached: budgets,
        imagePixelAudit: imagePixelAudit ?? false,
        truncatedFindings,
      }),
    },
    findings: kept,
    summary: summarize(kept),
  };
  return { snapshot, members };
}
