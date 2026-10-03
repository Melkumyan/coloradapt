import type { CueSpec, ElementKind, ExistingCues, OutlineStyle, SemanticState } from './types';

/**
 * The controlled mapping from a state to its non-color cue (docs/SEMANTIC_ACCESSIBILITY.md,
 * "Cue types"). This is an accessibility *presentation choice*, documented and fixed; it is not
 * derived from the page and not configurable by it.
 *
 * Glyphs are drawn by CSS (`::after`/`::before` with an empty alternative text, so assistive
 * technology does not read them), never inserted as text nodes.
 */
export const CUE_GLYPHS: Readonly<Partial<Record<SemanticState, string>>> = {
  error: '×',
  invalid: '×',
  warning: '!',
  success: '✓',
  valid: '✓',
  info: 'ℹ',
  online: '✓',
  offline: '×',
  positive: '+',
  negative: '−',
  increase: '↑',
  decrease: '↓',
  required: '*',
};

/** Outline pattern per state for elements that cannot carry a pseudo-element (inputs, images). */
const OUTLINE_PATTERNS: Readonly<Partial<Record<SemanticState, OutlineStyle>>> = {
  error: 'dashed',
  invalid: 'dashed',
  warning: 'dotted',
  success: 'double',
  valid: 'double',
};

/** Longest label (characters) that gets an underline cue. */
export const MAX_UNDERLINE_TEXT = 48;

/** Selection-like states are shown as an underline, never as a glyph. */
const UNDERLINE_STATES: ReadonlySet<SemanticState> = new Set(['selected', 'active']);

export type CueSelection =
  | { readonly kind: 'cue'; readonly spec: CueSpec }
  /** The state has no cue by policy (unselected, disabled, ...). */
  | { readonly kind: 'none'; readonly reason: 'no-cue-for-state' | 'no-safe-placement' };

/**
 * Picks the cue for a state on an element of this kind, or says why there is none.
 * `existing` only decides between `::after` and `::before` (never over the page's own content).
 */
export function selectCue(
  state: SemanticState,
  kind: ElementKind,
  existing: Pick<ExistingCues, 'afterBusy' | 'beforeBusy'>,
  textLength = 0,
): CueSelection {
  const glyph = CUE_GLYPHS[state];
  const underline = UNDERLINE_STATES.has(state);
  const outline = OUTLINE_PATTERNS[state];
  if (!glyph && !underline) return { kind: 'none', reason: 'no-cue-for-state' };

  switch (kind) {
    case 'control':
      // No pseudo-element can be attached to an input or an image; only a pattern on its own
      // outline is possible, and only for the states that have one.
      return outline
        ? { kind: 'cue', spec: { type: 'border-style', placement: 'outline', outline } }
        : { kind: 'none', reason: 'no-safe-placement' };
    case 'dot':
      return glyph
        ? { kind: 'cue', spec: { type: 'marker', placement: 'inner', glyph } }
        : { kind: 'none', reason: 'no-safe-placement' };
    case 'text':
      if (underline) {
        // An underline under a paragraph is not a state cue; it is only for short labels (tabs, links, items).
        return textLength > 0 && textLength <= MAX_UNDERLINE_TEXT
          ? { kind: 'cue', spec: { type: 'underline', placement: 'underline' } }
          : { kind: 'none', reason: 'no-safe-placement' };
      }
      if (!existing.afterBusy) {
        return { kind: 'cue', spec: { type: 'suffix-symbol', placement: 'after', glyph: glyph! } };
      }
      if (!existing.beforeBusy) {
        return { kind: 'cue', spec: { type: 'prefix-symbol', placement: 'before', glyph: glyph! } };
      }
      return { kind: 'none', reason: 'no-safe-placement' };
    default:
      return { kind: 'none', reason: 'no-safe-placement' };
  }
}
