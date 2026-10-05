/**
 * The M10 ground-truth judge. It compares what the developer audit said about a real page (CA-COLOR-001, the
 * contrast rule) with the *independent* oracle of `color.ts` (WCAG formula over the colors the browser
 * resolved) and sorts every disagreement into the classes of the M10 plan. It never treats the audit's own
 * answer as correct, and it never labels a disagreement a defect by itself: it produces *candidates* with a
 * cause, which a person then adjudicates (`realworld/data/adjudication.json`).
 *
 * Only the contrast rule has an independent oracle. The color-vision rules (CA-COLOR-002, CA-SVG-001 simulation
 * part, CA-CHART-001) are judged against the M2 simulation itself, which is a regression lock, never an
 * independent validation: they are reported as `ENGINE_REGRESSION_VALIDATION` and nothing here calls them right
 * or wrong in a scientific sense.
 *
 * Matching: the audit prints the last six steps of an element's structural path, and that tail is not unique in
 * a page. Oracle rows are therefore keyed by the tail the audit would print for them; one tail with several
 * rows is *ambiguous*, which can only make the judge more lenient (a finding is confirmed when any candidate is
 * below the target; a false positive needs every candidate to pass), never stricter.
 */
import type { AuditCompact, OracleRow, PageResult } from './page-run';

export type Verdict =
  | 'CONFIRMED'
  | 'FALSE_POSITIVE'
  | 'FALSE_NEGATIVE'
  | 'MANUAL_REVIEW'
  | 'LIMITATION'
  | 'NOT_APPLICABLE';

export type Validation = 'INDEPENDENT_CONTRAST' | 'ENGINE_REGRESSION_VALIDATION';

export interface Candidate {
  readonly page: string;
  readonly kind: 'audit-finding' | 'oracle-only';
  readonly verdict: Verdict;
  readonly validation: Validation;
  readonly rule: string;
  readonly path: string;
  /** Why the verdict is what it is (parser, grouping, landmark, inheritance, pseudo-element, SVG, transparency,
   * gradient, image, state, disabled, hidden, animation, dynamic DOM, unsupported rendering, ...). */
  readonly cause: string;
  readonly oracleRatio: number | null;
  readonly auditRatio: number | null;
  readonly target: number | null;
}

/** Ratios are rounded in evidence (and colors in hex): this much disagreement is rounding, not a finding. */
const TOLERANCE = 0.06;

/** The audit shows the last six steps of an element's structural path, with `…>` in front when it cut some. */
const PATH_SEGMENTS = 6;

export function displayKey(path: string): string {
  const steps = path.split('>');
  return steps.length > PATH_SEGMENTS ? `…>${steps.slice(-PATH_SEGMENTS).join('>')}` : path;
}

/** Oracle rows by what the audit would print for them. */
function byDisplayKey(rows: readonly OracleRow[]): Map<string, OracleRow[]> {
  const map = new Map<string, OracleRow[]>();
  for (const row of rows) {
    const key = displayKey(row.path);
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}

const isBelow = (row: OracleRow): boolean =>
  row.status === 'RESOLVED' && row.ratio !== null && row.ratio < row.target - TOLERANCE;

/** Why an element the oracle calls low-contrast may legitimately be absent from the audit. */
function missingCause(row: OracleRow): { verdict: Verdict; cause: string } {
  const flags = new Set(row.flags.split(',').filter(Boolean));
  const hidden = [...flags].find((f) => f.startsWith('hidden'));
  if (hidden) return { verdict: 'NOT_APPLICABLE', cause: `not rendered (${hidden})` };
  if (flags.has('disabled'))
    return { verdict: 'NOT_APPLICABLE', cause: 'disabled element (the rule skips them)' };
  if (flags.has('svg'))
    return { verdict: 'NOT_APPLICABLE', cause: 'SVG text (judged by the SVG rules)' };
  if (flags.has('shadow'))
    return { verdict: 'LIMITATION', cause: 'Shadow DOM (documented unsupported)' };
  if (flags.has('sensitive'))
    return { verdict: 'NOT_APPLICABLE', cause: 'form control or editable text (never described)' };
  if (flags.has('inert'))
    return { verdict: 'MANUAL_REVIEW', cause: 'aria-hidden or inert subtree' };
  if (flags.has('positioned'))
    return {
      verdict: 'MANUAL_REVIEW',
      cause: 'positioned element: the background behind it may not be its ancestor',
    };
  return {
    verdict: 'FALSE_NEGATIVE',
    cause: 'in scope, visible, solid resolved background, below target: not reported',
  };
}

export interface PageJudgement {
  readonly page: string;
  readonly candidates: Candidate[];
  readonly counts: {
    readonly auditContrastIssues: number;
    readonly oracleLowContrast: number;
    readonly confirmedIndependent: number;
    readonly manualReviewFindings: number;
    readonly analysisLimitationFindings: number;
    readonly colorVisionFindings: number;
    readonly sampleTruncatedGroups: number;
    readonly oracleCapReached: boolean;
  };
}

export function judgePage(result: PageResult): PageJudgement | null {
  const audit: AuditCompact | null = result.auditOff;
  const oracle = result.oracle;
  if (!audit?.ok || !oracle) return null;
  const rowsByKey = byDisplayKey(oracle.rows);
  const candidates: Candidate[] = [];
  const push = (c: Candidate) => candidates.push(c);

  const contrast = audit.findings.filter((f) => f.rule === 'CA-COLOR-001');
  const sampleTruncatedGroups = contrast.filter((f) => f.count > f.sample.length).length;
  const reportedKeys = new Set<string>();
  let auditContrastIssues = 0;
  let confirmedIndependent = 0;

  for (const group of contrast) {
    auditContrastIssues += group.count;
    for (const element of group.sample) {
      reportedKeys.add(element.path);
      const rows = rowsByKey.get(element.path) ?? [];
      const base = {
        page: result.id,
        kind: 'audit-finding' as const,
        validation: 'INDEPENDENT_CONTRAST' as const,
        rule: 'CA-COLOR-001',
        path: element.path,
        auditRatio: element.ratio,
      };
      if (rows.length === 0) {
        push({
          ...base,
          verdict: 'MANUAL_REVIEW',
          cause: oracle.truncated
            ? 'element not in the oracle sample (cap reached)'
            : 'no oracle element at this path (pseudo-element, text read from a descendant, or a path the probe does not reproduce)',
          oracleRatio: null,
          target: null,
        });
        continue;
      }
      const ambiguity = rows.length > 1 ? ` [${rows.length} elements share this printed path]` : '';
      const below = rows.find(isBelow);
      if (below) {
        confirmedIndependent++;
        push({
          ...base,
          verdict: 'CONFIRMED',
          cause: `independent contrast is below the target too${ambiguity}`,
          oracleRatio: below.ratio,
          target: below.target,
        });
        continue;
      }
      const resolved = rows.filter((r) => r.status === 'RESOLVED' && r.ratio !== null);
      if (resolved.length === 0) {
        // the oracle itself cannot say: gradient, image, clipped text or an effect on the stack
        const statuses = [...new Set(rows.map((r) => r.status))];
        const effectOnly = statuses.every((st) => st === 'UNRESOLVED_EFFECT');
        push({
          ...base,
          verdict: effectOnly || rows.length > 1 ? 'MANUAL_REVIEW' : 'FALSE_POSITIVE',
          cause: effectOnly
            ? 'the oracle cannot resolve this background either (blend mode, filter or backdrop-filter on the stack)'
            : `audit resolved a solid background, the oracle sees ${statuses
                .map((st) => st.replace('UNRESOLVED_', '').toLowerCase())
                .join('/')}${ambiguity}`,
          oracleRatio: null,
          target: rows[0]!.target,
        });
        continue;
      }
      // every candidate with this printed path meets the target independently
      const row = resolved[0]!;
      const notRendered = rows.every((r) => r.flags.split(',').some((f) => f.startsWith('hidden')));
      push({
        ...base,
        verdict: notRendered ? 'MANUAL_REVIEW' : 'FALSE_POSITIVE',
        cause: notRendered
          ? `audit reports an element the oracle considers not rendered (${row.flags})`
          : `independent ratio ${row.ratio!.toFixed(2)} meets the target ${row.target}${row.flags ? ` (${row.flags})` : ''}${ambiguity}`,
        oracleRatio: row.ratio,
        target: row.target,
      });
    }
  }

  // oracle-only: below target, in scope, and nothing printed with that path in the audit
  const allListed = sampleTruncatedGroups === 0;
  let oracleLowContrast = 0;
  for (const row of oracle.rows) {
    if (!isBelow(row) || row.chars === 0) continue;
    oracleLowContrast++;
    if (reportedKeys.has(displayKey(row.path))) continue;
    const { verdict, cause } = missingCause(row);
    if (!allListed && verdict === 'FALSE_NEGATIVE') {
      push({
        page: result.id,
        kind: 'oracle-only',
        verdict: 'MANUAL_REVIEW',
        validation: 'INDEPENDENT_CONTRAST',
        rule: 'CA-COLOR-001',
        path: row.path,
        cause: 'cannot decide: some finding groups list only their first 50 elements',
        oracleRatio: row.ratio,
        auditRatio: null,
        target: row.target,
      });
      continue;
    }
    push({
      page: result.id,
      kind: 'oracle-only',
      verdict,
      validation: 'INDEPENDENT_CONTRAST',
      rule: 'CA-COLOR-001',
      path: row.path,
      cause,
      oracleRatio: row.ratio,
      auditRatio: null,
      target: row.target,
    });
  }

  const count = (assessment: string) =>
    audit.findings.filter((f) => f.assessment === assessment).reduce((s, f) => s + f.count, 0);
  const colorVision = audit.findings
    .filter(
      (f) => f.rule === 'CA-COLOR-002' || f.rule === 'CA-SVG-001' || f.rule === 'CA-CHART-001',
    )
    .reduce((s, f) => s + f.count, 0);

  return {
    page: result.id,
    candidates,
    counts: {
      auditContrastIssues,
      oracleLowContrast,
      confirmedIndependent,
      manualReviewFindings: count('manual-review'),
      analysisLimitationFindings: count('analysis-limitation'),
      colorVisionFindings: colorVision,
      sampleTruncatedGroups,
      oracleCapReached: oracle.truncated,
    },
  };
}
