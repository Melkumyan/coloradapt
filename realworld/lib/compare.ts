/**
 * The M10.R1 row-level comparison: for every text element the independent oracle saw, what does the oracle
 * say about its contrast, what does ColorAdapt's own decision say (the in-page trace of the audit's decision
 * functions, `features/audit/trace.ts`), and when they disagree, *why*.
 *
 * Every disagreement gets exactly one primary class of the closeout taxonomy and a reason code; nothing is
 * counted as a ColorAdapt defect unless the trace shows the product's own decision is the one that is wrong.
 * `tier` says how sure the class is: A = confirmed against browser pixels or a deterministic code fact, B =
 * the independent oracle strongly supports it, C = rendered-state dependent or not reproducible.
 *
 * Contrast values are compared strictly (the oracle keeps six decimals and both sides use the same WCAG
 * formula): a ratio within `BORDERLINE` of the target is not a disagreement about the page, only about
 * floating-point rounding, and is counted separately instead of being tolerated into a verdict.
 */
import type { OracleRow } from './page-run';

export type PrimaryClass =
  | 'PRODUCT_BUG'
  | 'ORACLE_BUG'
  | 'HARNESS_BUG'
  | 'TIMING_STATE_DIFFERENCE'
  | 'SCOPE_DIFFERENCE'
  | 'INTENTIONAL_EXCLUSION'
  | 'UNSUPPORTED_RENDERING'
  | 'BROWSER_DIFFERENCE'
  | 'PRECISION_BOUNDARY'
  | 'AMBIGUOUS';

export type Side = 'FALSE_POSITIVE' | 'FALSE_NEGATIVE';
export type Tier = 'A' | 'B' | 'C';

export interface RowDiscrepancy {
  readonly side: Side;
  readonly primary: PrimaryClass;
  readonly code: string;
  readonly tier: Tier;
  readonly note: string;
}

/** A ratio this close to the target is rounding, not a verdict (both sides compute the same formula). */
export const BORDERLINE = 0.001;

export function flagsOf(row: OracleRow): Set<string> {
  return new Set(row.flags.split(',').filter(Boolean));
}

export const isHidden = (row: OracleRow): boolean =>
  [...flagsOf(row)].some((f) => f.startsWith('hidden'));

export function oracleLow(row: OracleRow): boolean {
  return row.status === 'RESOLVED' && row.ratio !== null && row.ratio < row.target - BORDERLINE;
}

export function isBorderline(row: OracleRow): boolean {
  return (
    row.status === 'RESOLVED' &&
    row.ratio !== null &&
    Math.abs(row.ratio - row.target) <= BORDERLINE
  );
}

/** Rows the comparison is about: text of the page's own HTML (SVG text is judged by the SVG rules; shadow DOM is excluded). */
export function inScope(row: OracleRow): boolean {
  const flags = flagsOf(row);
  return row.chars > 0 && !flags.has('svg') && !flags.has('shadow');
}

/**
 * The same two colors (hex) and a ratio within 1% of the target on both sides: the colors came from a source with
 * more than 8 bits (display-p3, oklch, lab, color-mix) which the oracle quantizes the way the browser paints
 * them and ColorAdapt keeps exact. Neither is wrong; the target falls between them.
 */
function isPrecisionBoundary(row: OracleRow): boolean {
  const t = row.trace;
  return (
    t !== null &&
    t !== undefined &&
    row.status === 'RESOLVED' &&
    row.ratio !== null &&
    t.ratio !== null &&
    row.fg === t.foreground &&
    row.bg === t.background &&
    Math.abs(row.ratio - row.target) / row.target <= 0.01 &&
    Math.abs(t.ratio - row.target) / row.target <= 0.01
  );
}

export function compareRow(row: OracleRow): RowDiscrepancy | null {
  if (!inScope(row)) return null;
  const trace = row.trace;
  if (!trace) return null; // only rows worth a trace were traced: neither side was near the target
  const flags = flagsOf(row);
  const reported = trace.reported;
  const hidden = isHidden(row);

  // --- the audit says "issue" -------------------------------------------------------------------------------
  if (reported && hidden && flags.has('sensitive') && flags.has('hidden:zero-size')) {
    return {
      side: 'FALSE_POSITIVE',
      primary: 'ORACLE_BUG',
      code: 'FORM_CONTROL_TEXT_RECT',
      tier: 'B',
      note: 'the text of a textarea is painted by the browser, not as a DOM text box: the oracle Range has no rectangle for it',
    };
  }
  if (reported && hidden) {
    return {
      side: 'FALSE_POSITIVE',
      primary: 'PRODUCT_BUG',
      code: `VISIBILITY/${[...flags].find((f) => f.startsWith('hidden'))}`,
      tier: 'A',
      note: 'ColorAdapt reports contrast for text the browser does not paint',
    };
  }
  if (reported && !hidden) {
    if (oracleLow(row)) return null; // agreement
    if (isBorderline(row)) return null;
    if (isPrecisionBoundary(row)) {
      return {
        side: 'FALSE_POSITIVE',
        primary: 'PRECISION_BOUNDARY',
        code: 'WIDE_GAMUT_8BIT',
        tier: 'B',
        note: `same colors ${row.fg}/${row.bg}; oracle ${row.ratio} vs product ${trace.ratio}, target ${row.target}`,
      };
    }
    switch (row.status) {
      case 'UNRESOLVED_COLOR_FORMAT':
        return {
          side: 'FALSE_POSITIVE',
          primary: 'ORACLE_BUG',
          code: 'COLOR_FORMAT',
          tier: 'B',
          note: 'the oracle could not read a computed color; ColorAdapt can',
        };
      case 'UNRESOLVED_EFFECT':
        return {
          side: 'FALSE_POSITIVE',
          primary: 'UNSUPPORTED_RENDERING',
          code: 'EFFECT_ON_STACK',
          tier: 'B',
          note: 'a filter, blend mode or backdrop filter is on the stack: the oracle refuses, ColorAdapt claims a ratio',
        };
      case 'UNRESOLVED_TEXT_CLIP':
      case 'UNRESOLVED_GRADIENT':
      case 'UNRESOLVED_IMAGE':
        return {
          side: 'FALSE_POSITIVE',
          primary: 'PRODUCT_BUG',
          code: `BACKGROUND_RESOLUTION/${row.status.replace('UNRESOLVED_', '')}`,
          tier: 'A',
          note: 'the oracle sees a background ColorAdapt treated as a solid color',
        };
      default:
        return {
          side: 'FALSE_POSITIVE',
          primary:
            row.opacity !== undefined && row.opacity < 1 ? 'TIMING_STATE_DIFFERENCE' : 'AMBIGUOUS',
          code:
            row.opacity !== undefined && row.opacity < 1 ? 'OPACITY_OR_ANIMATION' : 'COLORS_DIFFER',
          tier: 'C',
          note: `oracle ${row.fg}/${row.bg} ${row.ratio} vs product ${trace.foreground}/${trace.background} ${trace.ratio}`,
        };
    }
  }

  // --- the audit is silent ----------------------------------------------------------------------------------
  if (!oracleLow(row) || hidden) return null;
  switch (trace.reason) {
    case 'NOT_A_CANDIDATE':
      if (flags.has('sensitive')) {
        return {
          side: 'FALSE_NEGATIVE',
          primary: 'SCOPE_DIFFERENCE',
          code: 'FORM_CONTROL_TEXT',
          tier: 'B',
          note: 'text of a textarea, option or editable region: never described by the audit',
        };
      }
      return {
        side: 'FALSE_NEGATIVE',
        primary: 'PRODUCT_BUG',
        code: `TEXT_DISCOVERY/${row.tag}`,
        tier: 'A',
        note: 'the element holds text of its own but is not among the analyzed tags',
      };
    case 'SKIP_DISABLED':
      return {
        side: 'FALSE_NEGATIVE',
        primary: 'SCOPE_DIFFERENCE',
        code: 'DISABLED_ELEMENT',
        tier: 'B',
        note: 'disabled controls are out of scope for CA-COLOR-001 (the browser, not the author, styles them)',
      };
    case 'PARTIAL_BACKGROUND':
    case 'UNRESOLVED_BACKGROUND':
      return {
        side: 'FALSE_NEGATIVE',
        primary: 'INTENTIONAL_EXCLUSION',
        code:
          trace.reason === 'PARTIAL_BACKGROUND'
            ? 'BACKGROUND_APPROXIMATE'
            : 'BACKGROUND_UNRESOLVED',
        tier: 'B',
        note: 'listed by the audit as an analysis limitation (CA-COLOR-003), not judged',
      };
    case 'SKIP_NOT_RENDERED':
    case 'SKIP_HIDDEN':
      return {
        side: 'FALSE_NEGATIVE',
        primary: 'AMBIGUOUS',
        code: 'RENDERED_FOR_ORACLE_HIDDEN_FOR_PRODUCT',
        tier: 'C',
        note: 'the oracle paints it, the product does not: needs inspection',
      };
    case 'PASS_CONTRAST':
      if (isPrecisionBoundary(row)) {
        return {
          side: 'FALSE_NEGATIVE',
          primary: 'PRECISION_BOUNDARY',
          code: 'WIDE_GAMUT_8BIT',
          tier: 'B',
          note: `same colors ${row.fg}/${row.bg}; oracle ${row.ratio} vs product ${trace.ratio}, target ${row.target}`,
        };
      }
      return {
        side: 'FALSE_NEGATIVE',
        primary:
          row.opacity !== undefined && row.opacity < 1 ? 'TIMING_STATE_DIFFERENCE' : 'AMBIGUOUS',
        code:
          row.opacity !== undefined && row.opacity < 1 ? 'OPACITY_OR_ANIMATION' : 'COLORS_DIFFER',
        tier: 'C',
        note: `oracle ${row.fg}/${row.bg} ${row.ratio} vs product ${trace.foreground}/${trace.background} ${trace.ratio}`,
      };
    default:
      return {
        side: 'FALSE_NEGATIVE',
        primary: 'AMBIGUOUS',
        code: trace.reason,
        tier: 'C',
        note: 'unexpected product decision for a low-contrast row',
      };
  }
}

export interface PageComparison {
  readonly page: string;
  readonly rowsInScope: number;
  readonly renderedRows: number;
  readonly oracleLow: number;
  readonly productReported: number;
  readonly agreeLow: number;
  readonly borderline: number;
  readonly discrepancies: Array<RowDiscrepancy & { readonly full: string; readonly tag: string }>;
}

export function comparePage(page: string, rows: readonly OracleRow[]): PageComparison {
  let rowsInScope = 0;
  let renderedRows = 0;
  let low = 0;
  let reported = 0;
  let agreeLow = 0;
  let borderline = 0;
  const discrepancies: PageComparison['discrepancies'] = [];
  for (const row of rows) {
    if (!inScope(row)) continue;
    rowsInScope++;
    const hidden = isHidden(row);
    if (!hidden) {
      renderedRows++;
      if (oracleLow(row)) low++;
      if (isBorderline(row)) borderline++;
    }
    if (row.trace?.reported) reported++;
    const d = compareRow(row);
    if (d) discrepancies.push({ ...d, full: row.full, tag: row.tag });
    else if (!hidden && oracleLow(row) && row.trace?.reported) agreeLow++;
  }
  return {
    page,
    rowsInScope,
    renderedRows,
    oracleLow: low,
    productReported: reported,
    agreeLow,
    borderline,
    discrepancies,
  };
}
