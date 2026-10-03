import { hintApplies, rateConfidence } from './confidence';
import { addContextEvidence, collectEvidence } from './evidence';
import {
  SEMANTIC_STATES,
  type ElementFacts,
  type EvidenceStrength,
  type SemanticEvidence,
  type SemanticResult,
  type SemanticState,
} from './types';

/**
 * States that can be true of an element at the same time live in different *dimensions*
 * (a selected tab can also be disabled); two different answers within one dimension
 * contradict each other. States within a dimension that mean the same thing form one
 * *equivalence class* (`invalid` and `error` are one answer, `selected` and `active` are one).
 */
type Dimension = 'status' | 'presence' | 'polarity' | 'highlight' | 'requirement' | 'availability';

const DIMENSION: Readonly<Record<SemanticState, Dimension>> = {
  success: 'status',
  error: 'status',
  warning: 'status',
  info: 'status',
  valid: 'status',
  invalid: 'status',
  online: 'presence',
  offline: 'presence',
  positive: 'polarity',
  negative: 'polarity',
  increase: 'polarity',
  decrease: 'polarity',
  selected: 'highlight',
  unselected: 'highlight',
  active: 'highlight',
  inactive: 'highlight',
  required: 'requirement',
  enabled: 'availability',
  disabled: 'availability',
};

export const EQUIVALENCE: Readonly<Record<SemanticState, string>> = {
  success: 'good',
  valid: 'good',
  error: 'bad',
  invalid: 'bad',
  warning: 'warning',
  info: 'info',
  online: 'online',
  offline: 'offline',
  positive: 'up',
  increase: 'up',
  negative: 'down',
  decrease: 'down',
  selected: 'on',
  active: 'on',
  unselected: 'off',
  inactive: 'off',
  required: 'required',
  enabled: 'enabled',
  disabled: 'disabled',
};

/** When strengths tie across dimensions, the earlier dimension is the more informative answer. */
const DIMENSION_PRIORITY: readonly Dimension[] = [
  'status',
  'presence',
  'polarity',
  'highlight',
  'requirement',
  'availability',
];

const STRENGTH_RANK: Readonly<Record<EvidenceStrength, number>> = { strong: 2, medium: 1, weak: 0 };

function isConcrete(
  item: SemanticEvidence,
): item is SemanticEvidence & { supports: SemanticState } {
  return item.supports !== 'alert' && item.supports !== 'status';
}

/** Evidence that decides (medium and strong, never color): weak items only corroborate. */
function decides(item: SemanticEvidence): boolean {
  return item.strength !== 'weak' && item.source !== 'color' && isConcrete(item);
}

/**
 * Turns evidence into one answer:
 *
 * - contradicting evidence in one dimension: `conflict` (nothing is guessed);
 * - otherwise the strongest answer wins (ties: dimension priority, then declaration order);
 * - no deciding evidence: `unknown`. Color is weak evidence and never decides.
 */
export function resolveSemantics(evidence: readonly SemanticEvidence[]): SemanticResult {
  const deciding = evidence.filter(decides) as (SemanticEvidence & { supports: SemanticState })[];

  if (deciding.length === 0) {
    const reason = evidence.some(isConcrete)
      ? 'weak-evidence-only'
      : evidence.length > 0
        ? 'family-only'
        : 'no-evidence';
    return { status: 'unknown', reason, evidence };
  }

  // Per dimension: equivalence classes seen.
  const classes = new Map<Dimension, Map<string, SemanticState[]>>();
  for (const item of deciding) {
    const dimension = DIMENSION[item.supports];
    const byClass = classes.get(dimension) ?? new Map<string, SemanticState[]>();
    classes.set(dimension, byClass);
    const members = byClass.get(EQUIVALENCE[item.supports]) ?? [];
    if (!members.includes(item.supports)) members.push(item.supports);
    byClass.set(EQUIVALENCE[item.supports], members);
  }

  const conflicting: SemanticState[] = [];
  for (const byClass of classes.values()) {
    if (byClass.size > 1) for (const members of byClass.values()) conflicting.push(members[0]!);
  }
  if (conflicting.length > 0) {
    return { status: 'conflict', states: conflicting, evidence };
  }

  // The best (dimension, class): strongest evidence first, then dimension priority.
  let best: { dimension: Dimension; cls: string; strength: number } | null = null;
  for (const [dimension, byClass] of classes) {
    for (const cls of byClass.keys()) {
      const strength = Math.max(
        ...deciding
          .filter((item) => EQUIVALENCE[item.supports] === cls)
          .map((item) => STRENGTH_RANK[item.strength]),
      );
      const better =
        !best ||
        strength > best.strength ||
        (strength === best.strength &&
          DIMENSION_PRIORITY.indexOf(dimension) < DIMENSION_PRIORITY.indexOf(best.dimension));
      if (better) best = { dimension, cls, strength };
    }
  }
  const winner = best!;
  const supporting = deciding.filter((item) => EQUIVALENCE[item.supports] === winner.cls);

  // Within the class: strongest evidence's state, then declaration order.
  const state = [...supporting].sort(
    (a, b) =>
      STRENGTH_RANK[b.strength] - STRENGTH_RANK[a.strength] ||
      SEMANTIC_STATES.indexOf(a.supports) - SEMANTIC_STATES.indexOf(b.supports),
  )[0]!.supports;

  const hints = evidence.filter((item) => !isConcrete(item) && hintApplies(item, state));
  const corroboration = evidence.filter(
    (item) =>
      item.strength === 'weak' && isConcrete(item) && EQUIVALENCE[item.supports] === winner.cls,
  );
  const confidence = rateConfidence({ supporting, hints, corroboration });
  if (confidence === null) return { status: 'unknown', reason: 'weak-evidence-only', evidence };
  return { status: 'classified', state, confidence, evidence };
}

/** Facts in, answer out: the whole classification step. */
export function classifyElement(facts: ElementFacts): SemanticResult {
  return resolveSemantics(addContextEvidence(facts, collectEvidence(facts)));
}
