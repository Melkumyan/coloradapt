import type { SemanticConfidence, SemanticEvidence, SemanticState } from './types';
import { SOURCE_KIND } from './evidence';

/**
 * The one place where evidence becomes a confidence level (docs/SEMANTIC_ACCESSIBILITY.md,
 * "Confidence model"). No other file compares scores or invents thresholds.
 *
 * ```
 * HIGH    any strong evidence for the state, or medium evidence from two independent groups
 * MEDIUM  one group of token evidence (class / data-*), or text-only evidence plus corroboration
 * LOW     text / accessible-name / title evidence alone (language dependent, uncorroborated)
 * ```
 *
 * Color never lifts a result into HIGH, and a result with no non-color evidence is not a
 * result at all (`unknown`).
 */

/** What may insert a cue on its own. Everything below is detected and reported, not applied. */
export const AUTO_CUE_MIN_CONFIDENCE: SemanticConfidence = 'high';

const RANK: Readonly<Record<SemanticConfidence, number>> = { low: 0, medium: 1, high: 2 };

export function confidenceRank(confidence: SemanticConfidence): number {
  return RANK[confidence];
}

export function meetsAutoCueThreshold(confidence: SemanticConfidence): boolean {
  return RANK[confidence] >= RANK[AUTO_CUE_MIN_CONFIDENCE];
}

/** Evidence groups: two spellings of one author habit count once. */
type Group = 'token' | 'words' | 'role' | 'context' | 'aria' | 'native';

function groupOf(evidence: SemanticEvidence): Group | null {
  switch (SOURCE_KIND[evidence.source]) {
    case 'class':
    case 'data':
      return 'token';
    case 'text':
    case 'label':
      return 'words';
    case 'role':
      return 'role';
    case 'context':
      return 'context';
    case 'aria':
      return 'aria';
    case 'native':
      return 'native';
    default:
      return null;
  }
}

/** Family hints (`role="alert"`) that corroborate a state of their family. */
const ALERT_STATES: ReadonlySet<SemanticState> = new Set(['error', 'warning', 'invalid']);
const STATUS_STATES: ReadonlySet<SemanticState> = new Set(['success', 'info', 'valid']);

/** Whether a family-level hint applies to the winning state. */
export function hintApplies(hint: SemanticEvidence, state: SemanticState): boolean {
  if (hint.supports === 'alert') return ALERT_STATES.has(state);
  if (hint.supports === 'status') return STATUS_STATES.has(state);
  return false;
}

export interface ConfidenceInput {
  /** Non-weak evidence for the winning state (and the states compatible with it). */
  readonly supporting: readonly SemanticEvidence[];
  /** Family-level hints that apply to it. */
  readonly hints: readonly SemanticEvidence[];
  /** Weak evidence (id tokens, color) that agrees with it. */
  readonly corroboration: readonly SemanticEvidence[];
}

/** `null`: nothing here is strong enough to say anything. */
export function rateConfidence(input: ConfidenceInput): SemanticConfidence | null {
  const { supporting, hints, corroboration } = input;
  if (supporting.some((item) => item.strength === 'strong')) return 'high';

  const groups = new Set<Group>();
  for (const item of supporting) {
    const group = groupOf(item);
    if (group) groups.add(group);
  }
  if (hints.length > 0) groups.add('role');
  if (groups.size >= 2) return 'high';
  if (groups.size === 0) return null;

  const [only] = [...groups];
  const base: SemanticConfidence = only === 'token' ? 'medium' : 'low';
  if (base === 'low' && corroboration.length > 0) return 'medium';
  return base;
}
