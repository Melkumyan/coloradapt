import type { ModelConfidence } from '@domain/models';
import type {
  AuditAdaptationStatus,
  AuditAssessment,
  AuditCategory,
  AuditConfidence,
  AuditCoverageLevel,
  AuditSeverity,
  AuditSummary,
  EvidenceBasis,
} from './types';

/**
 * Every word the audit shows, in one place (UI and HTML report alike). Severity is never carried
 * by color alone: each level has a text label *and* a distinct shape, so the audit UI follows
 * the rule it audits (docs/DEVELOPER_AUDIT.md, "The audit UI").
 */

export const SEVERITY_LABEL: Readonly<Record<AuditSeverity, string>> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

/** A distinct shape per level; the shapes differ in outline, not only in size. */
export const SEVERITY_GLYPH: Readonly<Record<AuditSeverity, string>> = {
  critical: '⬢',
  high: '▲',
  medium: '◆',
  low: '■',
  info: '●',
};

/**
 * The same sentence in the UI and the HTML report: findings split by what they are, so a
 * manual-review prompt or an analysis limitation never inflates the confirmed-issue count.
 */
export function assessmentCountsLine(summary: AuditSummary): string {
  return (
    `Confirmed issues: ${summary.byAssessment.issue} · ` +
    `Manual review: ${summary.byAssessment['manual-review']} · ` +
    `Analysis limitations: ${summary.byAssessment['analysis-limitation']}.`
  );
}

/** Coverage levels are words with a distinct shape, never color alone. */
export const COVERAGE_LEVEL_LABEL: Readonly<Record<AuditCoverageLevel, string>> = {
  complete: '● Complete',
  partial: '◐ Partial',
  disabled: '○ Disabled',
  unsupported: '✕ Not audited',
};

export const CONFIDENCE_LABEL: Readonly<Record<AuditConfidence, string>> = {
  HIGH: 'High confidence',
  MEDIUM: 'Medium confidence',
  LOW: 'Low confidence',
};

export const ASSESSMENT_LABEL: Readonly<Record<AuditAssessment, string>> = {
  issue: 'Issue',
  'manual-review': 'Needs manual review',
  'analysis-limitation': 'Analysis limitation',
};

export const ADAPTATION_LABEL: Readonly<Record<AuditAdaptationStatus, string>> = {
  'not-applicable': 'Not applicable',
  'not-needed': 'Not needed',
  adapted: 'Adapted by ColorAdapt',
  'not-applied': 'Planned, not applied',
  'no-safe-candidate': 'No safe fix found',
  unsupported: 'Unsupported',
  'not-enabled': 'Adaptation off',
};

export const CATEGORY_LABEL: Readonly<Record<AuditCategory, string>> = {
  'color-contrast': 'Color contrast',
  'color-distinguishability': 'Color distinguishability',
  'color-only-information': 'Color-only information',
  'semantic-state': 'Semantic state',
  svg: 'SVG',
  chart: 'Chart',
  image: 'Image',
  'dynamic-content': 'Dynamic content',
  'unsupported-content': 'Unsupported content',
};

export const MODEL_CONFIDENCE_LABEL: Readonly<Record<ModelConfidence, string>> = {
  SUPPORTED_MODEL: 'Supported model',
  MODEL_ASSUMPTION: 'Model assumption',
  APPROXIMATION: 'Approximation',
  UNSUPPORTED: 'Unsupported',
};

export const BASIS_LABEL: Readonly<Record<EvidenceBasis, string>> = {
  'observed-fact': 'Observed',
  inference: 'Inference',
  'engineering-threshold': 'Engineering threshold',
  'model-estimate': 'Model estimate',
};
