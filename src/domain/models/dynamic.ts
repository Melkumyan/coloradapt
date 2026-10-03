import type { SemanticDiagnostics } from './semantic';
import type { SvgDiagnostics } from './svg';

/** Why the whole document is re-analyzed instead of a few regions (docs/DYNAMIC_ANALYSIS.md). */
export type FullRescanReason =
  'manual' | 'stylesheet' | 'document-root' | 'too-many-roots' | 'queue-overflow';

/** State of the mutation batcher / dynamic pipeline. */
export type PipelineState = 'STOPPED' | 'IDLE' | 'SCHEDULED' | 'RUNNING' | 'DIRTY';

/**
 * Counters of the dynamic-site pipeline, for tests and debugging only. They
 * never leave the device and are never logged in production (docs/PRIVACY.md).
 */
export interface DynamicDiagnostics {
  /** Mutation records received (own ones included). */
  readonly mutationRecords: number;
  /** Batches that had any work to look at. */
  readonly batches: number;
  readonly incrementalPasses: number;
  readonly fullRescans: number;
  readonly fullRescansByReason: Readonly<Partial<Record<FullRescanReason, number>>>;
  /** Regions handed to incremental passes. */
  readonly affectedRoots: number;
  /** Candidate elements inspected by incremental passes. */
  readonly elementsProcessed: number;
  /** Mutations recognized as ColorAdapt's own and ignored. */
  readonly selfMutationsIgnored: number;
  /** Mutations classified as irrelevant (unrelated attributes, no net change, ...). */
  readonly irrelevantMutations: number;
  readonly rulesAdded: number;
  readonly rulesUpdated: number;
  readonly rulesRemoved: number;
  readonly queueOverflows: number;
  /** Roots handed to a later pass because a budget ended the current one. */
  readonly rootsDeferred: number;
  readonly truncatedPasses: number;
  /** Times the page deleted our `<style>` and it was put back (spaced out, never dropped). */
  readonly stylesheetRepairs: number;
  /**
   * Repairs that had to wait out the minimum interval (one timer armed each). Every one costs exactly
   * one extra batch when its timer fires, which makes `batches` an exact function of the other counters
   * instead of a function of the wall clock.
   */
  readonly stylesheetRepairsDeferred: number;
  /** Times the observer was actually connected. */
  readonly observerStarts: number;
  /** Full rescans postponed by the minimum-interval throttle. */
  readonly fullRescansThrottled: number;
  readonly state: PipelineState;
  /** Elements the adaptation bookkeeping tracks right now. */
  readonly trackedElements: number;
  /** Rules in the injected stylesheet right now. */
  readonly rules: number;
  /** MutationObserver callbacks received (each delivers one or more records). */
  readonly observerCallbacks: number;
  /** `<link rel=stylesheet>` elements still waited on for `load`/`error` right now. */
  readonly pendingLinks: number;
  /** Mutation records queued for the next flush right now. */
  readonly queuedRecords: number;
  /** Roots handed over to a later pass and not yet processed, right now. */
  readonly deferredRoots: number;
  /** A full rescan that is owed but has not run yet (null when none). */
  readonly pendingRescan: FullRescanReason | null;
  /** A throttled full rescan or stylesheet repair is waiting on its timer right now. */
  readonly throttleTimerActive: boolean;
  /** Inline-SVG gauges (docs/SVG_ANALYSIS.md). */
  readonly svg: SvgDiagnostics;
  /** Semantic-cue counters (docs/SEMANTIC_ACCESSIBILITY.md). */
  readonly semantic: SemanticDiagnostics;
  /** Full rescans' counterpart for semantics: elements re-examined by external invalidation (form events). */
  readonly semanticInvalidations: number;
}
