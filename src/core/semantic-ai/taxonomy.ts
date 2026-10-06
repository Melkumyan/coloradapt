/**
 * The closed vocabulary of the AI semantic layer (M11, docs/AI_SEMANTIC_ENGINE.md).
 *
 * Everything the model may say is a member of one of these lists, chosen per task. The model never
 * writes prose that product logic reads: it picks a label, cites evidence ids and gives a number.
 */

/** Task-specific questions. One packet answers one task; there is no free-form "analyze this". */
export const SEMANTIC_TASKS = [
  /** What state does this control carry (selected, active, unavailable, ...)? */
  'CLASSIFY_UI_STATE',
  /** What does this status indicator mean (error, warning, success, ...)? */
  'CLASSIFY_STATUS_MEANING',
  /** Does this graphic use color to carry meaning, or is the color decoration? */
  'ASSESS_COLOR_DEPENDENCE',
  /** Which series of a chart does this legend entry belong to? */
  'MAP_CHART_LABEL',
  /** Which common control does this icon stand for? */
  'CLASSIFY_CONTROL_ICON',
  /** Is this content that ColorAdapt cannot analyze informative or decorative? */
  'ASSESS_MANUAL_REVIEW_CASE',
] as const;
export type SemanticTask = (typeof SEMANTIC_TASKS)[number];

export const UI_STATE_LABELS = [
  'selected',
  'unselected',
  'active',
  'inactive',
  'available',
  'unavailable',
  'error',
  'warning',
  'success',
  'informational',
] as const;

export const STATUS_MEANING_LABELS = [
  'error',
  'warning',
  'success',
  'informational',
  'positive',
  'negative',
  'increase',
  'decrease',
  'online',
  'offline',
] as const;

export const COLOR_DEPENDENCE_LABELS = ['color-carries-meaning', 'color-decorative'] as const;

export const CONTROL_ICON_LABELS = [
  'close',
  'menu',
  'search',
  'settings',
  'delete',
  'add',
  'edit',
  'download',
  'upload',
  'share',
  'favorite',
  'back',
  'forward',
  'expand',
  'collapse',
  'help',
  'notification',
  'user',
  'home',
  'refresh',
  'decorative',
] as const;

export const MANUAL_REVIEW_LABELS = ['carries-information', 'decorative'] as const;

/** Labels of the tasks whose label space is fixed. `MAP_CHART_LABEL` is per packet (`series-N`). */
const FIXED_LABELS: Readonly<Record<Exclude<SemanticTask, 'MAP_CHART_LABEL'>, readonly string[]>> =
  {
    CLASSIFY_UI_STATE: UI_STATE_LABELS,
    CLASSIFY_STATUS_MEANING: STATUS_MEANING_LABELS,
    ASSESS_COLOR_DEPENDENCE: COLOR_DEPENDENCE_LABELS,
    CLASSIFY_CONTROL_ICON: CONTROL_ICON_LABELS,
    ASSESS_MANUAL_REVIEW_CASE: MANUAL_REVIEW_LABELS,
  };

/** Series labels of a chart packet: `series-1` ... `series-N`. */
export const SERIES_LABEL = /^series-(?:[1-9]|[1-3][0-9]|40)$/;
/** More series than this and a legend cannot be mapped by a bounded packet. */
export const MAX_CHART_SERIES = 12;

/** The labels a packet may offer for a task; `seriesCount` only matters for `MAP_CHART_LABEL`. */
export function labelsForTask(task: SemanticTask, seriesCount = 0): readonly string[] {
  if (task === 'MAP_CHART_LABEL') {
    const count = Math.max(0, Math.min(seriesCount, MAX_CHART_SERIES));
    return Array.from({ length: count }, (_, i) => `series-${i + 1}`);
  }
  return FIXED_LABELS[task];
}

/** What the provider may answer with. Never a verdict, never a compliance statement. */
export const MODEL_OUTCOMES = [
  'SUPPORTED_HYPOTHESIS',
  'AMBIGUOUS',
  'INSUFFICIENT_CONTEXT',
] as const;
export type ModelOutcome = (typeof MODEL_OUTCOMES)[number];

/** What came back, with the failure cases the core adds itself. */
export type SemanticModelStatus = ModelOutcome | 'MODEL_ERROR';

/** What the deterministic validator decides about a hypothesis. Never "confirmed". */
export const VALIDATOR_STATUSES = ['ACCEPTED_ADVISORY', 'REJECTED', 'UNRESOLVED'] as const;
export type ValidatorStatus = (typeof VALIDATOR_STATUSES)[number];

/** Provider families. There is deliberately no remote one. */
export const SEMANTIC_PROVIDER_IDS = ['disabled', 'mock', 'local-http', 'local-ollama'] as const;
export type SemanticProviderId = (typeof SEMANTIC_PROVIDER_IDS)[number];

/** The providers a user can select in settings (`mock` exists for tests only). */
export const SELECTABLE_PROVIDER_IDS = ['local-ollama', 'local-http'] as const;
export type SelectableProviderId = (typeof SELECTABLE_PROVIDER_IDS)[number];

export const SEMANTIC_SCHEMA_VERSION = 1;

/**
 * Budgets of one query and of the machinery around it (docs/AI_SEMANTIC_ENGINE.md, "Budgets").
 * A page of any size produces a packet of the same bounded size.
 */
export const SEMANTIC_LIMITS = {
  /** Characters of any one text field in a packet. */
  textLength: 160,
  /** Characters of a short descriptor (a peer's name, a legend entry). */
  shortTextLength: 60,
  nearbyLabels: 5,
  peerDescriptors: 12,
  evidenceEntries: 20,
  /** Serialized packet size: a small local model's context is better spent on instructions and answer. */
  packetBytes: 6144,
  /** What a provider may answer with, in characters. */
  outputChars: 1024,
  alternatives: 3,
  evidenceRefs: 8,
  /** Queries one run may send; the rest stay manual review. */
  queriesPerRun: 64,
  /** Requests in flight at once: a local model is one GPU. */
  concurrency: 2,
  /** A request that has not answered by then is `UNRESOLVED`. */
  timeoutMs: 20_000,
  cacheEntries: 256,
  cacheBytes: 262_144,
} as const;

/** A model's own confidence below this is never accepted. Above it, it authorizes nothing by itself. */
export const MODEL_CONFIDENCE_THRESHOLD = 0.6;
