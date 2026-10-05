import { useId, type JSX } from 'react';
import {
  ADAPTATION_LABEL,
  ASSESSMENT_LABEL,
  AUDIT_ADAPTATION_STATUSES,
  AUDIT_ASSESSMENTS,
  AUDIT_CATEGORIES,
  AUDIT_CONFIDENCES,
  AUDIT_SEVERITIES,
  assessmentCountsLine,
  BASIS_LABEL,
  CATEGORY_LABEL,
  CONFIDENCE_LABEL,
  COVERAGE_LEVEL_LABEL,
  MODEL_CONFIDENCE_LABEL,
  SEVERITY_GLYPH,
  SEVERITY_LABEL,
  describeEvidence,
  type AuditCoverage,
  type AuditEvidence,
  type AuditFilters,
  type AuditFinding,
  type AuditSeverity,
  type AuditSummary,
} from '@core/audit';
import { VISION_PROFILES, VISION_PROFILE_INFO } from '@domain/models';

/** Severity as a shape *and* a word: never a color alone (the audit follows the rule it audits). */
export function SeverityBadge({ severity }: { severity: AuditSeverity }): JSX.Element {
  return (
    <span className={`badge badge--${severity}`}>
      <span aria-hidden="true" className="badge__glyph">
        {SEVERITY_GLYPH[severity]}
      </span>
      <span>{SEVERITY_LABEL[severity]}</span>
    </span>
  );
}

export function SummaryBar({ summary }: { summary: AuditSummary }): JSX.Element {
  return (
    <section aria-labelledby="summary-heading" className="summary">
      <h2 id="summary-heading">Summary</h2>
      <p className="summary__line" data-testid="summary-line">
        <strong>{summary.findings}</strong> finding{summary.findings === 1 ? '' : 's'} affecting{' '}
        <strong>{summary.affectedElements}</strong> element
        {summary.affectedElements === 1 ? '' : 's'}. {summary.adapted} compensated by ColorAdapt ·{' '}
        {summary.unresolved} not · {summary.manualReview} need manual review.
      </p>
      <p data-testid="assessment-line">{assessmentCountsLine(summary)}</p>
      <ul className="summary__severity" aria-label="Findings by severity">
        {AUDIT_SEVERITIES.map((severity) => (
          <li key={severity}>
            <SeverityBadge severity={severity} />{' '}
            <span data-testid={`count-${severity}`}>{summary.bySeverity[severity]}</span>
          </li>
        ))}
      </ul>
      <p className="muted">
        Counts only: ColorAdapt has no basis for a single accessibility score. Measured on the
        original page, not on ColorAdapt’s adapted appearance.
      </p>
    </section>
  );
}

/** What was and was not audited: a clean result is only about the part that was looked at. */
export function CoveragePanel({ coverage }: { coverage: AuditCoverage }): JSX.Element {
  const limited =
    coverage.analysisTruncated ||
    coverage.truncatedFindings > 0 ||
    coverage.subsystems.some((s) => s.level === 'partial' && /truncated/i.test(s.note));
  return (
    <section aria-labelledby="coverage-heading" className="coverage">
      <h2 id="coverage-heading">Coverage</h2>
      {limited && (
        <p role="status" className="notice" data-testid="coverage-truncated">
          <strong>Audit truncated: coverage limited.</strong> Parts of this page were not audited; a
          clean result there says nothing.
        </p>
      )}
      <p className="muted">
        {coverage.elementsAnalyzed} elements analyzed. “No findings” means nothing was found in what
        was audited, never that the page is free of problems.
      </p>
      <table data-testid="coverage-table">
        <thead>
          <tr>
            <th scope="col">Area</th>
            <th scope="col">Coverage</th>
            <th scope="col">What was and was not looked at</th>
          </tr>
        </thead>
        <tbody>
          {coverage.subsystems.map((s) => (
            <tr key={s.id} data-coverage={s.id} data-level={s.level}>
              <th scope="row">{s.name}</th>
              <td>{COVERAGE_LEVEL_LABEL[s.level]}</td>
              <td>{s.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

type FilterKey = 'severity' | 'category' | 'confidence' | 'adaptation' | 'assessment' | 'profile';

interface FilterGroup {
  readonly key: FilterKey;
  readonly legend: string;
  readonly options: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
    readonly count: number;
  }>;
}

function groups(findings: readonly AuditFinding[]): FilterGroup[] {
  const count = (pick: (finding: AuditFinding) => string, value: string): number =>
    findings.filter((finding) => pick(finding) === value).length;
  return [
    {
      key: 'severity',
      legend: 'Severity',
      options: AUDIT_SEVERITIES.map((value) => ({
        value,
        label: `${SEVERITY_GLYPH[value]} ${SEVERITY_LABEL[value]}`,
        count: count((f) => f.severity, value),
      })),
    },
    {
      key: 'category',
      legend: 'Category',
      options: AUDIT_CATEGORIES.map((value) => ({
        value,
        label: CATEGORY_LABEL[value],
        count: count((f) => f.category, value),
      })),
    },
    {
      key: 'confidence',
      legend: 'Confidence',
      options: AUDIT_CONFIDENCES.map((value) => ({
        value,
        label: CONFIDENCE_LABEL[value],
        count: count((f) => f.confidence, value),
      })),
    },
    {
      key: 'adaptation',
      legend: 'ColorAdapt',
      options: AUDIT_ADAPTATION_STATUSES.map((value) => ({
        value,
        label: ADAPTATION_LABEL[value],
        count: count((f) => f.adaptationStatus, value),
      })),
    },
    {
      key: 'profile',
      legend: 'Vision profile',
      options: VISION_PROFILES.filter((value) => value !== 'normal' && value !== 'custom').map(
        (value) => ({
          value,
          label: VISION_PROFILE_INFO[value].label,
          count: findings.filter((finding) => finding.visionProfiles.includes(value)).length,
        }),
      ),
    },
    {
      key: 'assessment',
      legend: 'Kind',
      options: AUDIT_ASSESSMENTS.map((value) => ({
        value,
        label: ASSESSMENT_LABEL[value],
        count: count((f) => f.assessment, value),
      })),
    },
  ];
}

export interface FilterPanelProps {
  readonly findings: readonly AuditFinding[];
  readonly filters: AuditFilters;
  readonly onChange: (next: AuditFilters) => void;
  readonly onClear: () => void;
  readonly filtering: boolean;
}

export function FilterPanel({
  findings,
  filters,
  onChange,
  onClear,
  filtering,
}: FilterPanelProps): JSX.Element {
  const searchId = useId();
  const toggle = (key: FilterKey, value: string, on: boolean): void => {
    const current = filters[key] as readonly string[];
    const next = on ? [...current, value] : current.filter((entry) => entry !== value);
    onChange({ ...filters, [key]: next });
  };
  return (
    <section aria-labelledby="filters-heading" className="filters">
      <h2 id="filters-heading">Filters</h2>
      <div className="filters__search">
        <label htmlFor={searchId}>Search rule, title or element</label>
        <input
          id={searchId}
          type="search"
          value={filters.query}
          onChange={(event) => onChange({ ...filters, query: event.target.value })}
        />
      </div>
      <div className="filters__groups">
        {groups(findings).map((group) => (
          <fieldset key={group.key} className="filters__group">
            <legend>{group.legend}</legend>
            {group.options.map((option) => (
              <label key={option.value} className="filters__option">
                <input
                  type="checkbox"
                  checked={(filters[group.key] as readonly string[]).includes(option.value)}
                  onChange={(event) => toggle(group.key, option.value, event.target.checked)}
                  disabled={
                    option.count === 0 &&
                    !(filters[group.key] as readonly string[]).includes(option.value)
                  }
                />
                {option.label} <span className="muted">({option.count})</span>
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      <button type="button" onClick={onClear} disabled={!filtering}>
        Clear filters
      </button>
    </section>
  );
}

function EvidenceTable({ evidence }: { evidence: readonly AuditEvidence[] }): JSX.Element | null {
  if (evidence.length === 0) return null;
  return (
    <table className="evidence">
      <thead>
        <tr>
          <th scope="col">Evidence</th>
          <th scope="col">Value</th>
          <th scope="col">Basis</th>
        </tr>
      </thead>
      <tbody>
        {evidence.map((item) => (
          <tr key={item.key}>
            <td>{item.label}</td>
            <td>
              <code>{describeEvidence(item)}</code>
            </td>
            <td>{BASIS_LABEL[item.basis]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface FindingCardProps {
  readonly finding: AuditFinding;
  readonly expanded: boolean;
  /** Index (over all affected elements) currently highlighted on the page, when this card is selected. */
  readonly highlighted: number | null;
  readonly onToggle: () => void;
  readonly onHighlight: (index: number, scroll: boolean) => void;
}

export function FindingCard({
  finding,
  expanded,
  highlighted,
  onToggle,
  onHighlight,
}: FindingCardProps): JSX.Element {
  const panelId = useId();
  const profiles = finding.visionProfiles.map((p) => VISION_PROFILE_INFO[p].label).join(', ');
  const plural = finding.affectedCount === 1 ? '' : 's';
  const recommendation = finding.recommendation;
  return (
    <article
      className="card"
      data-testid="finding"
      data-rule={finding.ruleId}
      data-finding-id={finding.id}
    >
      <h3 className="card__title">
        <button
          type="button"
          className="card__toggle"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggle}
        >
          <SeverityBadge severity={finding.severity} />
          <span className="card__name">{finding.title}</span>
        </button>
      </h3>
      <p className="card__meta">
        <span>{CATEGORY_LABEL[finding.category]}</span>
        <span>
          {finding.affectedCount} element{plural}
        </span>
        <span>{CONFIDENCE_LABEL[finding.confidence]}</span>
        <span>{ASSESSMENT_LABEL[finding.assessment]}</span>
        <span>ColorAdapt: {ADAPTATION_LABEL[finding.adaptationStatus]}</span>
        <span>{profiles === '' ? 'Not profile-specific' : `Profiles: ${profiles}`}</span>
        <span>
          <code>{finding.ruleId}</code>
        </span>
      </p>
      <div id={panelId} hidden={!expanded} className="card__panel">
        {expanded && (
          <>
            <p>{finding.summary}</p>
            <EvidenceTable evidence={finding.evidence} />
            <h4>Recommendation</h4>
            <p>{recommendation.summary}</p>
            <ul>
              {recommendation.actions.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ul>
            {recommendation.observed && (
              <p className="muted">
                Observed: <code>{recommendation.observed}</code>
              </p>
            )}
            {recommendation.coloradapt && <p className="muted">{recommendation.coloradapt}</p>}
            {recommendation.suggestedColor && (
              <p className="muted">
                Suggested color: <code>{recommendation.suggestedColor.hex}</code>.{' '}
                {recommendation.suggestedColor.note}
              </p>
            )}
            <h4>How sure, and why</h4>
            <ul>
              <li>
                Finding confidence: {CONFIDENCE_LABEL[finding.confidence]} (separate from severity).
              </li>
              {finding.simulation.map((sim) => (
                <li key={sim.profile}>
                  Simulation model, {VISION_PROFILE_INFO[sim.profile].label}: {sim.model} —{' '}
                  {MODEL_CONFIDENCE_LABEL[sim.modelConfidence]} ({sim.fidelity}).
                </li>
              ))}
              <li>
                Source: {finding.source.primary} {finding.source.subsystem}
                {finding.source.contributing.length > 0
                  ? ` (with ${finding.source.contributing.join(', ')})`
                  : ''}
                .
              </li>
              {finding.wcag.length > 0 && (
                <li>
                  Related to {finding.wcag.map((w) => `WCAG ${w.criterion} ${w.name}`).join('; ')} —
                  not a conformance statement.
                </li>
              )}
            </ul>
            <h4>
              Affected elements ({finding.affectedCount}
              {finding.affectedCount > finding.affected.length
                ? `, first ${finding.affected.length} listed`
                : ''}
              )
            </h4>
            <div className="card__nav">
              <button
                type="button"
                onClick={() =>
                  onHighlight(
                    ((highlighted ?? 0) - 1 + finding.affectedCount) % finding.affectedCount,
                    true,
                  )
                }
                disabled={finding.affectedCount < 2}
              >
                Previous element
              </button>
              <span role="status" data-testid="element-position">
                {highlighted === null
                  ? 'No element highlighted'
                  : `Element ${highlighted + 1} of ${finding.affectedCount}`}
              </span>
              <button
                type="button"
                onClick={() => onHighlight(((highlighted ?? -1) + 1) % finding.affectedCount, true)}
                disabled={finding.affectedCount < 2}
              >
                Next element
              </button>
            </div>
            <ol className="card__targets">
              {finding.affected.map((target, index) => (
                <li
                  key={target.instanceId}
                  aria-current={highlighted === index ? 'true' : undefined}
                >
                  <button type="button" onClick={() => onHighlight(index, true)}>
                    Show on page
                  </button>{' '}
                  <code>{target.locator.path}</code>
                  {target.locator.text && <span> “{target.locator.text}”</span>}
                  <span className="muted"> — {ADAPTATION_LABEL[target.adaptationStatus]}</span>
                </li>
              ))}
            </ol>
            <details className="card__details">
              <summary>Technical details</summary>
              <p className="muted">
                Finding id: <code>{finding.id}</code>
              </p>
              <ul>
                {finding.severityReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              <p className="muted">{finding.sourceNote}</p>
            </details>
          </>
        )}
      </div>
    </article>
  );
}
