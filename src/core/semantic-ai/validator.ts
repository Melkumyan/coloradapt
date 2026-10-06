import type { DeterministicEvidence, EvidenceStrength, SemanticQuery } from './query';
import type { SemanticHypothesis } from './output';
import { MODEL_CONFIDENCE_THRESHOLD, type ValidatorStatus } from './taxonomy';

/**
 * The deterministic hypothesis validator (docs/AI_SEMANTIC_ENGINE.md, "Validator"). It is the only
 * place that decides whether a model's label may be shown as an interpretation, and it decides from
 * the packet's own deterministic evidence. The model's confidence is one input to a threshold and
 * nothing more: it never raises an unsupported label to an accepted one.
 */

export const VALIDATOR_REASONS = [
  'accepted',
  'model-ambiguous',
  'model-insufficient-context',
  'no-deterministic-case',
  'label-not-allowed',
  'contradicted-by-strong-evidence',
  'contradicts-corroborated-evidence',
  'outranked-by-deterministic-evidence',
  'cites-no-supporting-evidence',
  'insufficient-corroboration',
  'ambiguous-evidence',
  'contradicted-by-evidence',
  'low-model-confidence',
  'high-risk-label-needs-strong-support',
] as const;
export type ValidatorReason = (typeof VALIDATOR_REASONS)[number];

export interface ValidationResult {
  readonly status: ValidatorStatus;
  readonly reason: ValidatorReason;
  /** Evidence ids that support the label (all of them, cited or not). */
  readonly supporting: readonly string[];
  readonly contradicting: readonly string[];
}

const CONTEXT_ONLY: ReadonlySet<string> = new Set(['color', 'context']);

/**
 * Facts corroborate one another only across *independence groups*, the same grouping the deterministic
 * semantic layer (M6) uses for its own confidence: a class, a `data-*` token and an id are one author's
 * naming habit; visible text and an accessible name are one set of words. Two spellings of one habit
 * are one piece of evidence, however many items the packet lists (no evidence laundering).
 */
const INDEPENDENCE_GROUP: Readonly<Record<string, string>> = {
  class: 'token',
  data: 'token',
  id: 'token',
  text: 'words',
  label: 'words',
};
const groupOf = (kind: string): string => INDEPENDENCE_GROUP[kind] ?? kind;

const WEIGHT: Readonly<Record<EvidenceStrength, number>> = { strong: 3, medium: 2, weak: 1 };

/** Labels whose wrong acceptance would send a developer after the wrong problem: they need firmer ground. */
const HIGH_RISK_LABELS: ReadonlySet<string> = new Set(['error', 'unavailable', 'delete']);

interface LabelSupport {
  readonly score: number;
  readonly strong: boolean;
  readonly kinds: number;
  readonly mediums: number;
  readonly ids: readonly string[];
}

function supportFor(label: string, evidence: readonly DeterministicEvidence[]): LabelSupport {
  const bestPerKind = new Map<string, number>();
  const ids: string[] = [];
  for (const item of evidence) {
    if (!item.supports.includes(label)) continue;
    ids.push(item.id);
    // A paint hint, or a word that only says what *family* of component this is (`pill`, a label next to
    // it), is context: it is shown, and it never counts as corroboration.
    const weight = CONTEXT_ONLY.has(item.kind) ? 0 : WEIGHT[item.strength];
    const group = groupOf(item.kind);
    bestPerKind.set(group, Math.max(bestPerKind.get(group) ?? 0, weight));
  }
  const weights = [...bestPerKind.values()].filter((weight) => weight > 0);
  return {
    score: weights.reduce((sum, weight) => sum + weight, 0),
    strong: weights.includes(WEIGHT.strong),
    kinds: weights.length,
    mediums: weights.filter((weight) => weight >= WEIGHT.medium).length,
    ids,
  };
}

/** A label is corroborated by one strong fact, or by two independent kinds of fact, one of them medium or better. */
const corroborated = (support: LabelSupport): boolean =>
  support.strong || (support.kinds >= 2 && support.mediums >= 1);

const result = (
  status: ValidatorStatus,
  reason: ValidatorReason,
  supporting: readonly string[] = [],
  contradicting: readonly string[] = [],
): ValidationResult => ({ status, reason, supporting, contradicting });

export function validateHypothesis(
  query: SemanticQuery,
  hypothesis: SemanticHypothesis,
): ValidationResult {
  if (hypothesis.outcome === 'AMBIGUOUS') return result('UNRESOLVED', 'model-ambiguous');
  if (hypothesis.outcome === 'INSUFFICIENT_CONTEXT')
    return result('UNRESOLVED', 'model-insufficient-context');
  if (query.context.ruleIds.length === 0) return result('REJECTED', 'no-deterministic-case');

  const label = hypothesis.label;
  if (!query.allowedLabels.includes(label)) return result('REJECTED', 'label-not-allowed');

  const evidence = query.deterministicEvidence;
  const own = supportFor(label, evidence);
  const contradicting = evidence.filter((item) => item.contradicts.includes(label));
  const contradictingIds = contradicting.map((item) => item.id);
  if (contradicting.some((item) => item.strength === 'strong'))
    return result('REJECTED', 'contradicted-by-strong-evidence', own.ids, contradictingIds);

  // What the deterministic evidence says on its own, whatever the model said.
  let rival: { label: string; support: LabelSupport } | null = null;
  for (const other of query.allowedLabels) {
    if (other === label) continue;
    const support = supportFor(other, evidence);
    if (!rival || support.score > rival.support.score) rival = { label: other, support };
  }
  const rivalCorroborated = rival !== null && corroborated(rival.support);

  if (!corroborated(own)) {
    return rivalCorroborated
      ? result('REJECTED', 'contradicts-corroborated-evidence', own.ids, rival?.support.ids ?? [])
      : result('UNRESOLVED', 'insufficient-corroboration', own.ids);
  }
  if (rival && rivalCorroborated) {
    // Two firm, different readings of one element are a conflict, not a contest a weak extra can win.
    if (rival.support.strong && own.strong)
      return result('UNRESOLVED', 'ambiguous-evidence', own.ids, rival.support.ids);
    // A firm reading outranks any number of softer ones; otherwise the heavier evidence does.
    const rivalTier = rival.support.strong ? 1 : 0;
    const ownTier = own.strong ? 1 : 0;
    if (rivalTier > ownTier || (rivalTier === ownTier && rival.support.score > own.score))
      return result('REJECTED', 'outranked-by-deterministic-evidence', own.ids, rival.support.ids);
    if (rivalTier === ownTier && rival.support.score === own.score)
      return result('UNRESOLVED', 'ambiguous-evidence', own.ids, rival.support.ids);
  }
  if (contradicting.length > 0)
    return result('UNRESOLVED', 'contradicted-by-evidence', own.ids, contradictingIds);

  // The justification must point at something that really supports the label.
  const cited = new Set(hypothesis.evidenceRefs);
  if (!own.ids.some((id) => cited.has(id)))
    return result('REJECTED', 'cites-no-supporting-evidence', own.ids);

  if (HIGH_RISK_LABELS.has(label) && !own.strong && own.mediums < 2)
    return result('UNRESOLVED', 'high-risk-label-needs-strong-support', own.ids);
  if (hypothesis.confidence < MODEL_CONFIDENCE_THRESHOLD)
    return result('UNRESOLVED', 'low-model-confidence', own.ids);
  return result('ACCEPTED_ADVISORY', 'accepted', own.ids);
}
