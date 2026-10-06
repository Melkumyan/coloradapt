/**
 * Classifies the frozen M10 discrepancies (`docs/validation/m10-discrepancies.json`, 67 false positives and 392
 * misses of the baseline comparison) by *replaying* them: the same pages were measured again with the M10.R1
 * oracle and the in-page trace of ColorAdapt's own decision, and each frozen record is looked up there by its
 * full structural path.
 *
 * A record gets exactly one primary class. The rules read evidence, never the old verdict: the baseline
 * oracle's mistakes are recognized by *reproducing* them (a baseline ratio that equals the contrast against a
 * white canvas, which is what an unreadable background layer was silently turned into), the product's mistakes
 * by the trace of the baseline selector (`traceLegacy`) and the current one (`trace`).
 */
import { contrastRatio } from './color';
import type { OracleRow } from './page-run';

export interface FrozenRecord {
  readonly id: string;
  readonly kind: 'FALSE_POSITIVE' | 'FALSE_NEGATIVE';
  readonly page: string;
  readonly tag: string | null;
  readonly fullPath: string | null;
  readonly sharedLocatorCount: number;
  readonly colorAdapt: {
    readonly reported: boolean;
    readonly foreground?: string | null;
    readonly background?: string | null;
  };
  readonly oracle: {
    readonly status: string;
    readonly ratio: number | null;
    readonly target: number;
    readonly flags: string[];
  } | null;
}

export interface Classification {
  readonly id: string;
  readonly primary: string;
  readonly code: string;
  readonly tier: 'A' | 'B' | 'C';
  /** A ColorAdapt defect that M10.R1 fixed (the regression test is named in the closeout document). */
  readonly fixedInR1: boolean;
  readonly evidence: string;
}

/** Tags the selector had before M10.R1 (the harness replays that selector; this is only the no-replay fallback). */
const LEGACY_TAGS = new Set([
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'svg',
  'img',
  'p',
  'span',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'td',
  'th',
  'strong',
  'em',
  'small',
]);

const hexToRgb = (hex: string | null | undefined) => {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
    a: 1,
  };
};

const lowNow = (row: OracleRow): boolean =>
  row.status === 'RESOLVED' && row.ratio !== null && row.ratio < row.target - 0.001;

export function classifyRecord(
  record: FrozenRecord,
  replay: readonly OracleRow[] | null,
): Classification {
  const make = (
    primary: string,
    code: string,
    tier: 'A' | 'B' | 'C',
    evidence: string,
    fixedInR1 = false,
  ): Classification => ({ id: record.id, primary, code, tier, fixedInR1, evidence });

  const row =
    replay && record.fullPath ? (replay.find((r) => r.full === record.fullPath) ?? null) : null;

  if (record.kind === 'FALSE_NEGATIVE') {
    if (!row) {
      if (record.tag && !LEGACY_TAGS.has(record.tag)) {
        return make(
          'PRODUCT_BUG',
          `TEXT_DISCOVERY/${record.tag}`,
          'B',
          `the element is gone from the replay (dynamic content), but <${record.tag}> was not among the analyzed tags, so the audit could not have seen it`,
          true,
        );
      }
      return make(
        'TIMING_STATE_DIFFERENCE',
        'ELEMENT_GONE',
        'C',
        'the element is not in the replay and its tag was analyzed: page content changed',
      );
    }
    if (lowNow(row) && row.traceLegacy?.reason === 'NOT_A_CANDIDATE') {
      return make(
        'PRODUCT_BUG',
        `TEXT_DISCOVERY/${row.tag}`,
        'A',
        `independent oracle: ${row.ratio?.toFixed(2)}:1 < ${row.target}; the baseline selector never matched <${row.tag}>; the current decision reports it (${row.trace?.reason})`,
        true,
      );
    }
    if (!lowNow(row) && record.oracle?.ratio != null) {
      const fg = hexToRgb(row.fg);
      if (fg) {
        const assumingWhite = contrastRatio(fg, { r: 255, g: 255, b: 255, a: 1 });
        if (
          Math.abs(assumingWhite - record.oracle.ratio) < 0.01 &&
          row.bg &&
          row.bg !== '#ffffff'
        ) {
          return make(
            'ORACLE_BUG',
            'COLOR_FORMAT',
            'A',
            `the baseline oracle's ${record.oracle.ratio} is exactly this text on a white canvas; the browser paints it on ${row.bg} (${row.ratio?.toFixed(2)}:1). The layer was written as color(srgb ...), which the baseline oracle read as transparent`,
          );
        }
      }
      return make(
        'TIMING_STATE_DIFFERENCE',
        'STATE_CHANGED',
        'C',
        `baseline oracle ${record.oracle.ratio}:1, replay ${row.ratio?.toFixed(2)}:1 with ${row.fg}/${row.bg}: the page state differs`,
      );
    }
    return make(
      'AMBIGUOUS',
      'UNCLASSIFIED_MISS',
      'C',
      `replay: ${row.status} ${row.ratio}, legacy ${row.traceLegacy?.reason}, now ${row.trace?.reason}`,
    );
  }

  // --- false positives: the audit said "issue" ------------------------------------------------------------------
  if (!row) return make('AMBIGUOUS', 'NOT_REPRODUCED', 'C', 'the element is not in the replay');
  const legacy = row.traceLegacy;
  const baselineBelow = record.oracle?.ratio != null && record.oracle.ratio < record.oracle.target;
  if (
    row.status === 'UNRESOLVED_TEXT_CLIP' ||
    (row.trace &&
      row.trace.reason !== 'REPORTED' &&
      row.trace.backgroundKind === 'image' &&
      legacy?.reported)
  ) {
    return make(
      'PRODUCT_BUG',
      'BACKGROUND_RESOLUTION/TEXT_CLIP',
      'A',
      "background-clip: text paints the glyphs: the element's background color is the text color, not what it sits on",
      true,
    );
  }
  const notPainted =
    row.flags.split(',').some((f) => f.startsWith('hidden')) ||
    row.trace?.reason === 'SKIP_NOT_RENDERED';
  if (notPainted && record.colorAdapt.reported) {
    return make(
      'PRODUCT_BUG',
      'VISIBILITY/ANCESTOR_DISPLAY_NONE',
      'A',
      `the browser does not paint this element (${row.flags}); the baseline decision looked only at its own style`,
      true,
    );
  }
  if (baselineBelow && legacy?.reported && lowNow(row)) {
    return make(
      'HARNESS_BUG',
      'JUDGE_TOLERANCE',
      'A',
      `oracle ${record.oracle?.ratio} < target ${record.oracle?.target}: the audit was right; the judge's 0.06 tolerance called a real miss a pass`,
    );
  }
  const baselineAtTarget =
    record.oracle?.ratio != null && Math.abs(record.oracle.ratio - record.oracle.target) <= 0.001;
  if (
    (baselineBelow || baselineAtTarget) &&
    row.trace?.reported &&
    row.trace.ratio !== null &&
    row.trace.ratio < row.target &&
    row.status === 'RESOLVED' &&
    row.ratio !== null &&
    row.ratio >= row.target - 0.001
  ) {
    return make(
      'HARNESS_BUG',
      'JUDGE_TOLERANCE',
      'B',
      `oracle ratio ${row.ratio} is the target within rounding; the audit's unrounded value is below it`,
    );
  }
  const pair = { fg: record.colorAdapt.foreground, bg: record.colorAdapt.background };
  if (
    lowNow(row) &&
    pair.fg === row.fg &&
    pair.bg === row.bg &&
    record.oracle?.ratio != null &&
    Math.abs(record.oracle.ratio - (row.ratio ?? 0)) > 0.02
  ) {
    return make(
      'ORACLE_BUG',
      'COLOR_FORMAT',
      'A',
      `the audit measured ${pair.fg} on ${pair.bg}; the corrected oracle now measures the same pair (${row.ratio?.toFixed(3)}:1, below ${row.target}); the baseline oracle's ${record.oracle.ratio} came from a background it could not read`,
    );
  }
  if (
    row.status === 'RESOLVED' &&
    legacy &&
    !legacy.reported &&
    (pair.fg !== legacy.foreground || pair.bg !== legacy.background)
  ) {
    return make(
      'TIMING_STATE_DIFFERENCE',
      'STATE_CHANGED',
      'B',
      `the audit measured ${pair.fg} on ${pair.bg}; the replay's product and oracle both see ${legacy.foreground} on ${legacy.background} (${row.ratio?.toFixed(2)}:1): a transition, hover or load state`,
    );
  }
  if (row.status === 'UNRESOLVED_COLOR_FORMAT') {
    return make(
      'ORACLE_BUG',
      'COLOR_FORMAT',
      'B',
      'the baseline oracle could not read a computed color (lab, oklch, display-p3) and skipped it',
    );
  }
  if (row.status === 'RESOLVED' && legacy?.reported && !lowNow(row)) {
    return make(
      'AMBIGUOUS',
      'COLORS_DIFFER',
      'C',
      `audit ${pair.fg}/${pair.bg}; replay oracle ${row.fg}/${row.bg} ${row.ratio}`,
    );
  }
  return make(
    'AMBIGUOUS',
    'UNCLASSIFIED_FALSE_POSITIVE',
    'C',
    `replay: ${row.status} ${row.ratio}, legacy ${legacy?.reason}`,
  );
}
