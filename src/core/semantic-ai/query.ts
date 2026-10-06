import {
  MAX_CHART_SERIES,
  SEMANTIC_LIMITS,
  SEMANTIC_SCHEMA_VERSION,
  labelsForTask,
  type SemanticTask,
} from './taxonomy';

/**
 * The semantic packet: the only thing a provider ever sees (docs/AI_PRIVACY.md). It is built from
 * allowlisted, bounded, redacted facts, never from the DOM. A packet has no field that could hold
 * a form value, a URL, a cookie or a page-wide text dump, because the type has no place for one.
 */

export type EvidenceStrength = 'strong' | 'medium' | 'weak';

/**
 * Independent *kinds* of evidence. Two pieces of evidence corroborate each other only when they
 * come from different kinds (a class and a `data-state` are two spellings of one author habit).
 * `color` is a paint hint and never corroborates anything.
 */
export type SemanticEvidenceKind =
  | 'aria'
  | 'native'
  | 'role'
  | 'class'
  | 'data'
  | 'id'
  | 'text'
  | 'label'
  | 'context'
  | 'structure'
  | 'swatch'
  | 'order'
  | 'color';

/** A fact the deterministic layers established. Ids are assigned by the builder, never by page text. */
export interface DeterministicEvidence {
  /** `e1`, `e2`, ...: the only references a model may cite. */
  readonly id: string;
  readonly kind: SemanticEvidenceKind;
  /** Which allowlisted signal this is (`aria-selected`, `role`, `legend-title`). */
  readonly source: string;
  /** What was read, bounded and redacted. Page-derived text lives only here and in names. */
  readonly value: string;
  readonly strength: EvidenceStrength;
  /** Labels this fact is consistent with. Computed by ColorAdapt, never by the model. */
  readonly supports: readonly string[];
  /** Labels this fact rules out. */
  readonly contradicts: readonly string[];
}

export interface SemanticTarget {
  readonly tag: string;
  readonly role: string | null;
  /** `type` of an input (`email`); never a value. */
  readonly controlType: string | null;
  /** Names of the allowlisted ARIA attributes that are present, with their token value (`aria-selected=true`). */
  readonly aria: readonly string[];
  /** Bounded, redacted. Always `null` for a form field: its text is its value. */
  readonly accessibleName: string | null;
  readonly interactive: boolean;
}

export interface PeerDescriptor {
  readonly tag: string;
  readonly role: string | null;
  readonly name: string | null;
  /** The label an earlier deterministic pass gave the peer, when it gave one. */
  readonly label: string | null;
}

export type ColorRelation = 'color-only-difference' | 'no-difference-found' | 'not-compared';

export interface ChartSummary {
  readonly chartType: string;
  readonly legendEntry: string | null;
  readonly legendIndex: number | null;
  readonly legendCount: number;
  readonly seriesCount: number;
}

export interface ImageSummary {
  readonly classification: string;
  readonly small: boolean;
}

export interface SemanticContext {
  readonly nearbyLabels: readonly string[];
  readonly peers: readonly PeerDescriptor[];
  readonly colorRelation: ColorRelation;
  readonly chart: ChartSummary | null;
  readonly image: ImageSummary | null;
  /** Ids of the deterministic rules that put the case in front of a human. */
  readonly ruleIds: readonly string[];
}

export interface SemanticQuery {
  readonly schemaVersion: typeof SEMANTIC_SCHEMA_VERSION;
  readonly task: SemanticTask;
  readonly target: SemanticTarget;
  readonly context: SemanticContext;
  readonly deterministicEvidence: readonly DeterministicEvidence[];
  readonly allowedLabels: readonly string[];
}

/** A query plus what the product needs to bind a late answer to its question. Never sent to a provider. */
export interface BoundQuery {
  readonly query: SemanticQuery;
  /** Fingerprint of the sanitized packet: equal packets share one answer. */
  readonly inputHash: string;
  /** What the caller binds the answer to (finding id, snapshot generation); opaque here. */
  readonly bindings: Readonly<Record<string, string>>;
}

export const EVIDENCE_ID = /^e[1-9]\d?$/;

/** Bytes of the serialized packet (UTF-8). */
export function packetBytes(query: SemanticQuery): number {
  return new TextEncoder().encode(JSON.stringify(query)).length;
}

/**
 * The packet of a query, in the exact form a provider receives it. Keys are sorted so equal packets
 * are byte-equal (the cache and the deduplication key on it).
 */
export function canonicalPacket(query: SemanticQuery): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, sort(v)]),
      );
    }
    return input;
  };
  return JSON.stringify(sort(query));
}

/** Evidence of one kind is kept in this order when a packet has to be cut: facts before hints. */
const KEEP_ORDER: Readonly<Record<EvidenceStrength, number>> = { strong: 0, medium: 1, weak: 2 };

/** Cuts a packet to its budget: weakest evidence and the longest tail of peers go first. */
export function fitToBudget(query: SemanticQuery): SemanticQuery {
  let current = query;
  const smaller = (): SemanticQuery | null => {
    if (current.context.peers.length > 4) {
      return {
        ...current,
        context: { ...current.context, peers: current.context.peers.slice(0, -2) },
      };
    }
    if (current.context.nearbyLabels.length > 2) {
      return {
        ...current,
        context: { ...current.context, nearbyLabels: current.context.nearbyLabels.slice(0, -1) },
      };
    }
    if (current.deterministicEvidence.length > 4) {
      // Drop the weakest, latest item; ids stay (a reference must keep naming the same fact).
      const items = [...current.deterministicEvidence];
      let worst = items.length - 1;
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const item = items[i];
        const best = items[worst];
        if (item && best && KEEP_ORDER[item.strength] > KEEP_ORDER[best.strength]) worst = i;
      }
      items.splice(worst, 1);
      return { ...current, deterministicEvidence: items };
    }
    return null;
  };
  while (packetBytes(current) > SEMANTIC_LIMITS.packetBytes) {
    const next = smaller();
    if (!next) break;
    current = next;
  }
  return current;
}

/** Whether a packet respects every structural budget (used by the builder's own tests and the engine). */
export function packetWithinLimits(query: SemanticQuery): boolean {
  const limits = SEMANTIC_LIMITS;
  const allowed = new Set(query.allowedLabels);
  const labels = labelsForTask(query.task, MAX_CHART_SERIES);
  return (
    query.schemaVersion === SEMANTIC_SCHEMA_VERSION &&
    packetBytes(query) <= limits.packetBytes &&
    query.context.nearbyLabels.length <= limits.nearbyLabels &&
    query.context.peers.length <= limits.peerDescriptors &&
    query.deterministicEvidence.length <= limits.evidenceEntries &&
    query.allowedLabels.length > 0 &&
    query.allowedLabels.every((label) => labels.includes(label)) &&
    query.deterministicEvidence.every(
      (item) =>
        EVIDENCE_ID.test(item.id) &&
        item.value.length <= limits.textLength &&
        item.supports.every((label) => allowed.has(label)) &&
        item.contradicts.every((label) => allowed.has(label)),
    )
  );
}
