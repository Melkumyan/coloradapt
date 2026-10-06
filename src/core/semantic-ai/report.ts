import {
  ASSIST_NOTE,
  SEMANTIC_ASSIST_SCHEMA_VERSION,
  type AssistCoverage,
  type AssistEvidenceRef,
  type AssistStats,
  type AuditSemanticAssistEntry,
  type AuditSemanticAssistReport,
} from '@core/audit';
import type { AssistOutcome } from './engine';
import { PARSE_FAILURES } from './output';
import { INSTRUCTION_VERSION } from './prompt';
import type { ProviderIdentity } from './provider';
import type { SemanticQuery } from './query';
import { SEMANTIC_SCHEMA_VERSION } from './taxonomy';

/**
 * Turning engine outcomes into what the audit shows and exports. An entry names a finding and
 * carries labels, ids and statuses only: no prompt, no packet, no raw model output, no reasoning.
 */

const EMPTY_STATS: AssistStats = {
  eligible: 0,
  queried: 0,
  deduped: 0,
  cacheHits: 0,
  accepted: 0,
  rejected: 0,
  unresolved: 0,
  modelErrors: 0,
  timeouts: 0,
  notQueued: 0,
};

/** An audit page that has not run the review (or has it off) still says so in its report. */
export function emptyAssistReport(
  coverage: AssistCoverage,
  provider: ProviderIdentity,
): AuditSemanticAssistReport {
  return {
    schemaVersion: SEMANTIC_ASSIST_SCHEMA_VERSION,
    aiAssisted: false,
    coverage,
    provider: { id: provider.provider, model: provider.model },
    semanticSchemaVersion: SEMANTIC_SCHEMA_VERSION,
    instructionVersion: INSTRUCTION_VERSION,
    note: ASSIST_NOTE,
    stats: EMPTY_STATS,
    entries: [],
  };
}

/**
 * The entry of one outcome; `query` is the packet it answered (kept by the caller, never exported).
 * `null` when the model gave no answer at all (the runtime was unreachable, or timed out): there is
 * nothing to say about that finding, and it must not look as if a model had looked at it. An answer
 * that was refused as malformed is an entry (rejected), because a model did answer.
 */
export function entryOf(
  outcome: AssistOutcome,
  query: SemanticQuery,
  group: { readonly instances: number; readonly sampled: number } = { instances: 1, sampled: 1 },
): AuditSemanticAssistEntry | null {
  const { interpreted } = outcome;
  if (
    interpreted.hypothesis === null &&
    !(PARSE_FAILURES as readonly string[]).includes(interpreted.reason)
  )
    return null;
  const byId = new Map(query.deterministicEvidence.map((item) => [item.id, item]));
  const supportingEvidence: AssistEvidenceRef[] = (interpreted.validation?.supporting ?? [])
    .map((id) => byId.get(id))
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .slice(0, 8)
    .map((item) => ({ id: item.id, source: item.source, value: item.value }));
  const hypothesis = interpreted.hypothesis;
  return {
    findingId: outcome.id,
    task: outcome.task,
    modelStatus: interpreted.modelStatus,
    validatorStatus: interpreted.validatorStatus,
    validatorReason: interpreted.reason,
    hypothesis:
      hypothesis && hypothesis.outcome === 'SUPPORTED_HYPOTHESIS' ? hypothesis.label : null,
    modelConfidence: hypothesis ? hypothesis.confidence : null,
    evidenceRefs: hypothesis ? [...hypothesis.evidenceRefs] : [],
    supportingEvidence,
    inputFingerprint: outcome.inputHash,
    instances: group.instances,
    sampled: group.sampled,
  };
}

export function assistReport(args: {
  readonly coverage: AssistCoverage;
  readonly provider: ProviderIdentity;
  readonly stats: AssistStats;
  readonly entries: readonly AuditSemanticAssistEntry[];
}): AuditSemanticAssistReport {
  return {
    schemaVersion: SEMANTIC_ASSIST_SCHEMA_VERSION,
    aiAssisted: args.entries.length > 0,
    coverage: args.coverage,
    provider: { id: args.provider.provider, model: args.provider.model },
    semanticSchemaVersion: SEMANTIC_SCHEMA_VERSION,
    instructionVersion: INSTRUCTION_VERSION,
    note: ASSIST_NOTE,
    stats: args.stats,
    entries: [...args.entries].sort((a, b) =>
      a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : 0,
    ),
  };
}
