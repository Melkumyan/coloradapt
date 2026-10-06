import { EVIDENCE_ID, type SemanticQuery } from './query';
import {
  MODEL_OUTCOMES,
  SEMANTIC_LIMITS,
  SEMANTIC_SCHEMA_VERSION,
  type ModelOutcome,
} from './taxonomy';

/**
 * The only shape of provider output the product accepts (docs/AI_PROVIDER_PROTOCOL.md). Anything
 * else is a `MODEL_ERROR`: no repair, no best-effort reading of prose, no extra fields passed on.
 */

export interface AlternativeLabel {
  readonly label: string;
  readonly confidence: number;
}

export interface SemanticHypothesis {
  readonly schemaVersion: typeof SEMANTIC_SCHEMA_VERSION;
  readonly outcome: ModelOutcome;
  /** A label of the packet's `allowedLabels`, or `unknown` for any outcome but `SUPPORTED_HYPOTHESIS`. */
  readonly label: string;
  /** The model's own confidence, 0..1. Never a finding's confidence; never an authorization. */
  readonly confidence: number;
  readonly evidenceRefs: readonly string[];
  readonly alternatives: readonly AlternativeLabel[];
}

export const PARSE_FAILURES = [
  'too-large',
  'not-json',
  'not-an-object',
  'unknown-field',
  'bad-schema-version',
  'bad-outcome',
  'bad-label',
  'bad-confidence',
  'bad-evidence-refs',
  'unknown-evidence-ref',
  'bad-alternatives',
] as const;
export type ParseFailure = (typeof PARSE_FAILURES)[number];

export type ParsedHypothesis =
  | { readonly ok: true; readonly hypothesis: SemanticHypothesis }
  | { readonly ok: false; readonly failure: ParseFailure };

const FIELDS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'outcome',
  'label',
  'confidence',
  'evidenceRefs',
  'alternatives',
]);
const ALTERNATIVE_FIELDS: ReadonlySet<string> = new Set(['label', 'confidence']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isProbability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** Checks `raw` (a JSON string or an already-parsed value) against `query`; see {@link SemanticHypothesis}. */
export function parseHypothesis(raw: unknown, query: SemanticQuery): ParsedHypothesis {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > SEMANTIC_LIMITS.outputChars) return { ok: false, failure: 'too-large' };
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, failure: 'not-json' };
    }
  } else {
    let size = Number.POSITIVE_INFINITY;
    try {
      size = JSON.stringify(raw)?.length ?? Number.POSITIVE_INFINITY;
    } catch {
      return { ok: false, failure: 'not-json' };
    }
    if (size > SEMANTIC_LIMITS.outputChars) return { ok: false, failure: 'too-large' };
  }
  if (!isRecord(value)) return { ok: false, failure: 'not-an-object' };
  for (const key of Object.keys(value)) {
    if (!FIELDS.has(key)) return { ok: false, failure: 'unknown-field' };
  }
  // The version is the product's to know (it is part of the instructions), so a model need not echo it;
  // one that does must get it right.
  if (value.schemaVersion !== undefined && value.schemaVersion !== SEMANTIC_SCHEMA_VERSION)
    return { ok: false, failure: 'bad-schema-version' };
  const outcome = value.outcome;
  if (typeof outcome !== 'string' || !(MODEL_OUTCOMES as readonly string[]).includes(outcome))
    return { ok: false, failure: 'bad-outcome' };
  const label = value.label;
  const supported = outcome === 'SUPPORTED_HYPOTHESIS';
  if (typeof label !== 'string') return { ok: false, failure: 'bad-label' };
  if (supported ? !query.allowedLabels.includes(label) : label !== 'unknown')
    return { ok: false, failure: 'bad-label' };
  if (!isProbability(value.confidence)) return { ok: false, failure: 'bad-confidence' };

  const refs = value.evidenceRefs;
  if (
    !Array.isArray(refs) ||
    refs.length > SEMANTIC_LIMITS.evidenceRefs ||
    (supported && refs.length === 0)
  )
    return { ok: false, failure: 'bad-evidence-refs' };
  const known = new Set(query.deterministicEvidence.map((item) => item.id));
  const seen = new Set<string>();
  for (const ref of refs as unknown[]) {
    if (typeof ref !== 'string' || !EVIDENCE_ID.test(ref) || seen.has(ref))
      return { ok: false, failure: 'bad-evidence-refs' };
    if (!known.has(ref)) return { ok: false, failure: 'unknown-evidence-ref' };
    seen.add(ref);
  }

  const alternatives: AlternativeLabel[] = [];
  if (value.alternatives !== undefined) {
    if (
      !Array.isArray(value.alternatives) ||
      value.alternatives.length > SEMANTIC_LIMITS.alternatives
    )
      return { ok: false, failure: 'bad-alternatives' };
    for (const entry of value.alternatives as unknown[]) {
      if (
        !isRecord(entry) ||
        !Object.keys(entry).every((key) => ALTERNATIVE_FIELDS.has(key)) ||
        typeof entry.label !== 'string' ||
        !query.allowedLabels.includes(entry.label) ||
        entry.label === label ||
        !isProbability(entry.confidence)
      )
        return { ok: false, failure: 'bad-alternatives' };
      alternatives.push({ label: entry.label, confidence: entry.confidence });
    }
  }
  return {
    ok: true,
    hypothesis: {
      schemaVersion: SEMANTIC_SCHEMA_VERSION,
      outcome: outcome as ModelOutcome,
      label,
      confidence: value.confidence,
      evidenceRefs: [...seen],
      alternatives,
    },
  };
}
