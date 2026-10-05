import type { VisionProfile } from '@domain/models';
import type {
  AuditAdaptationStatus,
  AuditAssessment,
  AuditCategory,
  AuditConfidence,
  AuditFinding,
  AuditSeverity,
} from './types';

/** An empty list means "do not filter on this". Pure and local: no remote search of any kind. */
export interface AuditFilters {
  readonly severity: readonly AuditSeverity[];
  readonly category: readonly AuditCategory[];
  readonly confidence: readonly AuditConfidence[];
  readonly adaptation: readonly AuditAdaptationStatus[];
  readonly assessment: readonly AuditAssessment[];
  readonly profile: readonly VisionProfile[];
  /** Case-insensitive; matches rule id, title and the locators of the listed elements. */
  readonly query: string;
}

export const NO_FILTERS: AuditFilters = {
  severity: [],
  category: [],
  confidence: [],
  adaptation: [],
  assessment: [],
  profile: [],
  query: '',
};

function allows<T>(selected: readonly T[], value: T): boolean {
  return selected.length === 0 || selected.includes(value);
}

function haystack(finding: AuditFinding): string {
  const parts = [finding.ruleId, finding.title, finding.id];
  for (const affected of finding.affected) {
    const { locator } = affected;
    parts.push(
      locator.path,
      locator.tag,
      locator.id ?? '',
      locator.classes.join(' '),
      locator.text ?? '',
    );
  }
  return parts.join('\n').toLowerCase();
}

export function matchesFilters(finding: AuditFinding, filters: AuditFilters): boolean {
  if (!allows(filters.severity, finding.severity)) return false;
  if (!allows(filters.category, finding.category)) return false;
  if (!allows(filters.confidence, finding.confidence)) return false;
  if (!allows(filters.adaptation, finding.adaptationStatus)) return false;
  if (!allows(filters.assessment, finding.assessment)) return false;
  if (
    filters.profile.length > 0 &&
    !finding.visionProfiles.some((profile) => filters.profile.includes(profile))
  ) {
    return false;
  }
  const query = filters.query.trim().toLowerCase();
  return query === '' || haystack(finding).includes(query);
}

export function filterFindings(
  findings: readonly AuditFinding[],
  filters: AuditFilters,
): AuditFinding[] {
  return findings.filter((finding) => matchesFilters(finding, filters));
}

/** True when any filter is set. */
export function isFiltering(filters: AuditFilters): boolean {
  return (
    filters.severity.length +
      filters.category.length +
      filters.confidence.length +
      filters.adaptation.length +
      filters.assessment.length +
      filters.profile.length >
      0 || filters.query.trim() !== ''
  );
}
