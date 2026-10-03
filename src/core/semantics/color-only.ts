import type {
  ColorOnlyInput,
  ColorOnlyVerdict,
  ElementFacts,
  ExistingCueKind,
  ExistingCues,
  SemanticResult,
  SemanticState,
  StyleSnapshot,
} from './types';
import { EQUIVALENCE as EQUIVALENCE_OF } from './classifier';
import { REQUIRED_MARKERS, STATE_SYMBOLS } from './vocabulary';

const POLARITY_STATES: ReadonlySet<SemanticState> = new Set([
  'positive',
  'negative',
  'increase',
  'decrease',
]);

/** A leading sign or arrow, including the ASCII hyphen-minus (which is not in STATE_SYMBOLS: it is also a hyphen). */
const SIGN_PREFIX = /^\s*[+\-−–±↑↓▲▼]/u;

/**
 * What the page already shows on the element besides color (docs/SEMANTIC_ACCESSIBILITY.md,
 * "Existing cue detection"). Adding a second ✓ next to an existing ✓, or an icon next to a
 * warning triangle, is noise; so every one of these means "do nothing".
 */
export function detectExistingCues(facts: ElementFacts, result: SemanticResult): ExistingCues {
  const cues: ExistingCueKind[] = [];
  if (facts.hasIcon) cues.push('icon');
  if (facts.beforeContent || facts.afterContent) cues.push('pseudo-content');
  if (STATE_SYMBOLS.test(facts.text)) cues.push('symbol-text');
  if (
    result.status === 'classified' &&
    POLARITY_STATES.has(result.state) &&
    SIGN_PREFIX.test(facts.text) &&
    !cues.includes('symbol-text')
  ) {
    cues.push('symbol-text'); // "+12%", "-8%", "↑ 3": the sign already says it
  }
  if (result.status === 'classified') {
    if (result.state === 'required' && REQUIRED_MARKERS.test(facts.text)) cues.push('marker-text');
    // The visible text itself names the state ("Success", "Ошибка"): meaning is not color-only.
    const cls = EQUIVALENCE_OF[result.state];
    const namesState = result.evidence.some(
      (item) =>
        item.source === 'text-token' &&
        item.supports !== 'alert' &&
        item.supports !== 'status' &&
        EQUIVALENCE_OF[item.supports] === cls,
    );
    if (namesState) cues.push('state-text');
  }
  return { cues, beforeBusy: facts.beforeContent, afterBusy: facts.afterContent };
}

function firstDifference(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): string | null {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    // A property one side does not report (the focus ring of a focused element) is not comparable.
    if (a[key] === undefined || b[key] === undefined) continue;
    if (a[key] !== b[key]) return key;
  }
  return null;
}

/**
 * Is color the only thing that tells this element's state apart? Decided from DOM/CSS structure,
 * never from pixels:
 *
 * 1. the element itself already carries a non-color cue: not color-only;
 * 2. compared with comparable elements in a *different* state, any non-color difference
 *    (geometry, weight, decoration, border width/style, shadow, icon, text presence):
 *    not color-only;
 * 3. only paint differs: color-only;
 * 4. no comparable element exists: only an empty sized box (a dot) is color-only by
 *    construction - it has nothing but paint to say anything with. Everything else:
 *    `cannot-compare`, which means no cue.
 */
export function assessColorOnly(input: ColorOnlyInput): ColorOnlyVerdict {
  if (input.existing.cues.length > 0) {
    return { colorOnly: false, reason: 'existing-cue', detail: input.existing.cues[0] };
  }

  const peers = input.contrastingPeers;
  if (peers.length === 0) {
    return input.kind === 'dot' && !input.hasText
      ? { colorOnly: true, basis: 'no-content' }
      : { colorOnly: false, reason: 'cannot-compare' };
  }

  let paintDiffers = false;
  for (const peer of peers) {
    if (peer.hasIcon) return { colorOnly: false, reason: 'structural-difference', detail: 'icon' };
    if (peer.hasText !== input.hasText) {
      return { colorOnly: false, reason: 'structural-difference', detail: 'text-presence' };
    }
    const shape = firstDifference(input.style.shape, peer.style.shape);
    if (shape) return { colorOnly: false, reason: 'structural-difference', detail: shape };
    if (firstDifference(input.style.paint, peer.style.paint)) paintDiffers = true;
  }
  return paintDiffers
    ? { colorOnly: true, basis: 'peer-comparison' }
    : { colorOnly: false, reason: 'no-visual-difference' };
}

/** True when two snapshots differ only in paint (exported for tests). */
export function differsOnlyInPaint(a: StyleSnapshot, b: StyleSnapshot): boolean {
  return firstDifference(a.shape, b.shape) === null && firstDifference(a.paint, b.paint) !== null;
}
