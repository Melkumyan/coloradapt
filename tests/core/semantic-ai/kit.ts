import {
  buildSemanticQuery,
  type BoundQuery,
  type SemanticFacts,
  type SemanticQuery,
} from '@core/semantic-ai';

/** Facts for a state task with nothing known; tests override what matters. */
export function facts(overrides: Partial<SemanticFacts> = {}): SemanticFacts {
  return {
    task: 'CLASSIFY_UI_STATE',
    ruleId: 'CA-SEM-002',
    tag: 'li',
    role: null,
    controlType: null,
    aria: {},
    accessibleName: null,
    title: null,
    isField: false,
    interactive: false,
    hiddenFromAT: false,
    presentational: false,
    nearbyLabels: [],
    peers: [],
    colorRelation: 'color-only-difference',
    signals: [],
    classSegments: [],
    chart: null,
    image: null,
    ...overrides,
  };
}

export function bound(overrides: Partial<SemanticFacts> = {}): BoundQuery {
  const built = buildSemanticQuery(facts(overrides), { findingId: 'CA-SEM-002:0000000000000000' });
  if (!built) throw new Error('facts did not make a packet');
  return built;
}

export function queryOf(overrides: Partial<SemanticFacts> = {}): SemanticQuery {
  return bound(overrides).query;
}

/** A provider answer, as the JSON string a runtime would return. */
export function answer(
  label: string,
  confidence: number,
  refs: readonly string[],
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    outcome: 'SUPPORTED_HYPOTHESIS',
    label,
    confidence,
    evidenceRefs: refs,
    ...extra,
  });
}

/** Ids of the evidence items of a packet that support `label`. */
export function supporters(query: SemanticQuery, label: string): string[] {
  return query.deterministicEvidence.filter((e) => e.supports.includes(label)).map((e) => e.id);
}

/** Two independent kinds of fact for `active`: a class token and a role. */
export const ACTIVE_TAB = {
  tag: 'a',
  role: 'tab',
  signals: [
    { source: 'class-token', value: 'active', strength: 'medium' as const, supports: 'active' },
  ],
};

/** Class name only: the "red-state" case. */
export const CLASS_ONLY_ERROR = {
  tag: 'div',
  signals: [
    { source: 'class-token', value: 'error', strength: 'medium' as const, supports: 'error' },
  ],
};
