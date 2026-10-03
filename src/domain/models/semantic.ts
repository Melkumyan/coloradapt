/**
 * Counters of the semantic-cue layer (M6, docs/SEMANTIC_ACCESSIBILITY.md), for tests and
 * debugging only. They never leave the device and are never logged in production
 * (docs/PRIVACY.md). Cumulative unless marked as a gauge.
 */
export interface SemanticDiagnostics {
  /** Elements that passed the cheap attribute pre-filter and were examined. */
  readonly semanticCandidates: number;
  readonly semanticClassified: number;
  readonly semanticUnknown: number;
  readonly semanticConflicts: number;
  /** Classified elements (any confidence) whose state turned out to be carried by color only. */
  readonly colorOnlyDetected: number;
  readonly cuesPlanned: number;
  readonly cuesApplied: number;
  /** Planned cues the browser did not render as planned (never reported as applied). */
  readonly cuesNotApplied: number;
  /** Cues taken off an element (state changed, evidence gone, or the setting turned off). */
  readonly cuesRemoved: number;
  /** Semantic passes (a full scan or one incremental pass each). */
  readonly semanticPasses: number;
  /** Roots / elements handed to semantic passes. */
  readonly semanticRoots: number;
  /** Peer groups searched because a member changed or left (bounded; never a document scan). */
  readonly semanticPeerSearches: number;
  /** Peers re-examined only because a neighbor changed or left. */
  readonly semanticPeersReexamined: number;
  /** Gauge: elements carrying a cue right now. */
  readonly cuesActive: number;
}

export const EMPTY_SEMANTIC_DIAGNOSTICS: SemanticDiagnostics = {
  semanticCandidates: 0,
  semanticClassified: 0,
  semanticUnknown: 0,
  semanticConflicts: 0,
  colorOnlyDetected: 0,
  cuesPlanned: 0,
  cuesApplied: 0,
  cuesNotApplied: 0,
  cuesRemoved: 0,
  semanticPasses: 0,
  semanticRoots: 0,
  semanticPeerSearches: 0,
  semanticPeersReexamined: 0,
  cuesActive: 0,
};
