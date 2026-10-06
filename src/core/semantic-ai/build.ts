import { redactSnippet, safeName, stableHash } from '@core/audit';
import { SEMANTIC_ARIA_ATTRIBUTES, deriveEvidence, type RawEvidence } from './evidence-rules';
import type { SemanticFacts } from './facts';
import {
  canonicalPacket,
  fitToBudget,
  packetWithinLimits,
  type BoundQuery,
  type DeterministicEvidence,
  type EvidenceStrength,
  type PeerDescriptor,
  type SemanticQuery,
} from './query';
import {
  MAX_CHART_SERIES,
  SEMANTIC_LIMITS,
  SEMANTIC_SCHEMA_VERSION,
  labelsForTask,
} from './taxonomy';

/**
 * Facts in, packet out (docs/AI_PRIVACY.md, "What enters a packet"). Everything free-form passes
 * `redactSnippet` (whitespace collapsed, invisible characters stripped, e-mail addresses, numbers
 * and opaque tokens replaced, length cut); every name passes `safeName`; ARIA values are matched
 * against a fixed list. No URL is ever copied, so none has to be sanitized.
 */

const STRENGTH_ORDER: Readonly<Record<EvidenceStrength, number>> = {
  strong: 0,
  medium: 1,
  weak: 2,
};
const ARIA_VALUE =
  /^(?:true|false|mixed|page|step|location|date|time|polite|assertive|off|grammar|spelling)$/;
const TAG = /^[a-z][a-z0-9-]{0,23}$/;
const ROLE = /^[a-z]{2,30}$/;
const INPUT_TYPE = /^[a-z]{1,16}$/;

function text(value: string | null | undefined, max: number): string | null {
  return value ? redactSnippet(value, max) : null;
}

function tag(value: string): string {
  const lower = value.toLowerCase();
  return TAG.test(lower) ? lower : 'unknown';
}

function role(value: string | null): string | null {
  const lower = value?.toLowerCase() ?? null;
  return lower !== null && ROLE.test(lower) ? lower : null;
}

function peers(facts: SemanticFacts): PeerDescriptor[] {
  return facts.peers.slice(0, SEMANTIC_LIMITS.peerDescriptors).map((peer) => ({
    tag: tag(peer.tag),
    role: role(peer.role),
    name: facts.isField ? null : text(peer.name, SEMANTIC_LIMITS.shortTextLength),
    label: safeName(peer.state),
  }));
}

function ordered(items: readonly RawEvidence[], allowed: ReadonlySet<string>): RawEvidence[] {
  const seen = new Set<string>();
  const kept: RawEvidence[] = [];
  for (const item of items) {
    const supports = item.supports.filter((label) => allowed.has(label)).sort();
    const contradicts = item.contradicts.filter((label) => allowed.has(label)).sort();
    // A fact that points at no label of this task is context at most; the packet's other fields hold that.
    if (supports.length === 0 && contradicts.length === 0) continue;
    const key = `${item.kind}|${item.source}|${item.value}|${supports.join(',')}|${contradicts.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({
      ...item,
      value: text(item.value, SEMANTIC_LIMITS.textLength) ?? '',
      supports,
      contradicts,
    });
  }
  // A fixed order makes equal facts give equal packets whatever order the page was read in.
  return kept.sort(
    (a, b) =>
      STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength] ||
      (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) ||
      (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
  );
}

/**
 * What decides the validator's verdict on a packet: the task, the labels, the rule and the deterministic
 * evidence (with the target's own tag, role and ARIA). Nearby text and peers do not enter the verdict, so
 * two elements of one finding with different neighbours but the same evidence share one signature.
 */
export function evidenceSignature(query: SemanticQuery): string {
  return stableHash(
    canonicalPacket({
      ...query,
      target: { ...query.target, accessibleName: null },
      context: { ...query.context, nearbyLabels: [], peers: [] },
      deterministicEvidence: query.deterministicEvidence.map((item) => ({
        ...item,
        id: '',
      })),
    }),
  );
}

/**
 * The packet of one element for one task, or `null` when the facts cannot make a well-formed one
 * (a chart without series, a task with no label to choose from). `bindings` ride along for the
 * caller (finding id, snapshot generation) and are never part of the packet.
 */
export function buildSemanticQuery(
  facts: SemanticFacts,
  bindings: Readonly<Record<string, string>> = {},
): BoundQuery | null {
  const seriesCount = facts.chart ? Math.min(facts.chart.series.length, MAX_CHART_SERIES) : 0;
  const allowedLabels = labelsForTask(facts.task, seriesCount);
  if (allowedLabels.length === 0) return null;
  if (facts.task === 'MAP_CHART_LABEL' && (!facts.chart || facts.chart.legendEntry === null))
    return null;
  const allowed = new Set(allowedLabels);

  const aria: string[] = [];
  for (const name of SEMANTIC_ARIA_ATTRIBUTES) {
    const value = facts.aria[name];
    if (value !== undefined && ARIA_VALUE.test(value)) aria.push(`${name}=${value}`);
  }

  const evidence: DeterministicEvidence[] = ordered(deriveEvidence(facts), allowed)
    .slice(0, SEMANTIC_LIMITS.evidenceEntries)
    .map((item, index) => ({ ...item, id: `e${index + 1}` }));

  const chart = facts.chart;
  const query: SemanticQuery = {
    schemaVersion: SEMANTIC_SCHEMA_VERSION,
    task: facts.task,
    target: {
      tag: tag(facts.tag),
      role: role(facts.role),
      controlType:
        facts.controlType !== null && INPUT_TYPE.test(facts.controlType.toLowerCase())
          ? facts.controlType.toLowerCase()
          : null,
      aria,
      accessibleName: facts.isField ? null : text(facts.accessibleName, SEMANTIC_LIMITS.textLength),
      interactive: facts.interactive,
    },
    context: {
      nearbyLabels: facts.nearbyLabels
        .slice(0, SEMANTIC_LIMITS.nearbyLabels)
        .map((label) => text(label, SEMANTIC_LIMITS.shortTextLength))
        .filter((label): label is string => label !== null),
      peers: peers(facts),
      colorRelation: facts.colorRelation,
      chart: chart
        ? {
            chartType: safeName(chart.chartType) ?? 'unknown',
            legendEntry: text(chart.legendEntry, SEMANTIC_LIMITS.shortTextLength),
            legendIndex: chart.legendIndex,
            legendCount: Math.min(chart.legendCount, 99),
            seriesCount,
          }
        : null,
      image: facts.image
        ? {
            classification: safeName(facts.image.classification) ?? 'unknown',
            small: facts.image.small,
          }
        : null,
      ruleIds: /^CA-[A-Z]+-\d{3}$/.test(facts.ruleId) ? [facts.ruleId] : [],
    },
    deterministicEvidence: evidence,
    allowedLabels,
  };
  const fitted = fitToBudget(query);
  if (!packetWithinLimits(fitted)) return null;
  return { query: fitted, inputHash: stableHash(canonicalPacket(fitted)), bindings };
}
