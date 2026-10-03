import type { ColorValue } from './color';
import type { ElementDescriptor, ElementRole } from './element';
import type { UserSettings } from './settings';
import type { ModelConfidence, VisionProfile } from './vision-profile';
import type { VisionAnalysis } from './vision-analysis';

/**
 * A pure function that inspects one analyzed element and optionally
 * proposes a change. Rules are composed by the Adaptation Engine and never
 * touch the DOM themselves, so they stay unit-testable in isolation.
 */
export interface AdaptationRule {
  readonly id: string;
  readonly appliesTo: readonly ElementRole[];
  readonly description: string;
  evaluate(
    descriptor: ElementDescriptor,
    profile: VisionProfile,
    settings: UserSettings,
  ): AdaptationChange | null;
}

export type UnchangedReason =
  'normal-vision' | 'strength-zero' | 'already-distinguishable' | 'below-visible-change';

export type NoSafeCandidateReason =
  'no-candidate-meets-constraints' | 'search-budget-exhausted' | 'strength-interpolation-unsafe';

export type UnsupportedReason = 'custom-profile-unsupported' | 'invalid-color';

export type AdaptationReason =
  UnchangedReason | 'improved' | NoSafeCandidateReason | UnsupportedReason;

/** Structural search statistics, for tests/debugging. Never wall-clock based. */
export interface SearchStats {
  /** Candidates actually evaluated (after de-duplication). */
  readonly candidateCount: number;
  /** Search stages entered (lightness/chroma, small hue, wide hue). */
  readonly stagesSearched: number;
}

interface AdaptationResultBase {
  readonly originalColor: ColorValue;
  readonly background: ColorValue;
  readonly profile: VisionProfile;
  readonly severity: number;
  /** Provenance of the vision model behind this result; never hidden. */
  readonly confidence: ModelConfidence;
  /**
   * The color that is safe to apply: the original color for every status
   * except `adapted`. Always a valid opaque sRGB color.
   */
  readonly outputColor: ColorValue;
  readonly stats: SearchStats;
}

interface AnalyzedResultBase extends AdaptationResultBase {
  /** WCAG 2.x contrast of the original pair. Separate from vision distance. */
  readonly originalContrast: number;
  readonly originalVisionAnalysis: VisionAnalysis;
}

export interface UnchangedAdaptation extends AnalyzedResultBase {
  readonly status: 'unchanged';
  readonly reason: UnchangedReason;
}

export interface AdaptedAdaptation extends AnalyzedResultBase {
  readonly status: 'adapted';
  readonly reason: 'improved';
  /** The optimizer's strength-1 candidate; `outputColor` is this after applying strength. */
  readonly optimizedColor: ColorValue;
  readonly adaptedVisionAnalysis: VisionAnalysis;
  readonly adaptedContrast: number;
  /** OKLab distance between `originalColor` and `outputColor`. */
  readonly changeDistance: number;
  /** Candidate score of the optimizer's choice (see docs/ADAPTATION_ENGINE.md). */
  readonly score: number;
}

export interface NoSafeCandidateAdaptation extends AnalyzedResultBase {
  readonly status: 'no-safe-candidate';
  readonly reason: NoSafeCandidateReason;
}

export interface UnsupportedAdaptation extends AdaptationResultBase {
  readonly status: 'unsupported';
  readonly reason: UnsupportedReason;
}

/** Outcome of searching for a foreground adaptation of one color pair. */
export type AdaptationResult =
  UnchangedAdaptation | AdaptedAdaptation | NoSafeCandidateAdaptation | UnsupportedAdaptation;

export type AdaptationStatus = AdaptationResult['status'];

export interface AdaptationMetrics {
  readonly originalContrast: number;
  readonly adaptedContrast: number;
  readonly originalSimulatedDistance: number;
  readonly adaptedSimulatedDistance: number;
  readonly changeDistance: number;
  readonly score: number;
}

/**
 * A single reversible style change for one element, expressed as plain data
 * so it can be applied by an infrastructure layer (a stylesheet rule
 * targeting `[data-coloradapt-id="..."]`) without the core ever writing CSS.
 */
export interface AdaptationChange {
  readonly elementId: string;
  /**
   * The analyzed element this change belongs to, when it differs from the one
   * the rule targets (an inline SVG's rules target its shapes). Rules sharing an
   * owner are applied, verified and dropped together; absent => the element itself.
   */
  readonly ownerId?: string;
  readonly property: string;
  readonly originalValue: string;
  readonly adaptedValue: string;
  readonly reason: string;
  readonly confidence: ModelConfidence;
  readonly metrics: AdaptationMetrics;
}

export interface AdaptationSummary {
  /** Elements whose pair fell below the detection threshold: adapted + no-safe-candidate. */
  readonly problemsDetected: number;
  readonly adapted: number;
  /** Resolved elements left alone (accessible pair, strength 0, ...). */
  readonly unchanged: number;
  readonly noSafeCandidate: number;
  /**
   * Elements the plan adapted but whose planned `color` the browser did not
   * reproduce after the stylesheet was applied (e.g. an inline `!important`).
   * They are removed from the plan's changes — never reported as adapted.
   */
  readonly notApplied: number;
  /**
   * Elements not adapted because analysis was `partial`/`unsupported` (for an inline SVG:
   * multi-paint, gradients, translucent paint, ... see `SvgUnsupportedReason`), or the
   * profile is unsupported.
   */
  readonly unresolved: number;
  /** Elements outside scope (img, disabled, no text, an SVG when `adaptSVG` is off, ...). */
  readonly skipped: number;
}

/**
 * Page-level, DOM-independent output of the Adaptation Engine: a list of
 * per-element changes plus bookkeeping. Pipeline:
 * optimizer -> AdaptationPlan -> content layer -> stylesheet.
 */
export interface AdaptationPlan {
  readonly profile: VisionProfile;
  readonly confidence: ModelConfidence;
  readonly strength: number;
  readonly changes: readonly AdaptationChange[];
  readonly summary: AdaptationSummary;
}

export const EMPTY_ADAPTATION_SUMMARY: AdaptationSummary = {
  problemsDetected: 0,
  adapted: 0,
  unchanged: 0,
  noSafeCandidate: 0,
  notApplied: 0,
  unresolved: 0,
  skipped: 0,
};

/**
 * The difference one incremental pass makes to the page's adaptation:
 * what to add or change, and which elements lose their rule. Pure data —
 * like {@link AdaptationPlan}, applying it is the content layer's job.
 */
export interface AdaptationDelta {
  /** Changes for elements that have no rule yet. */
  readonly added: readonly AdaptationChange[];
  /** Changes replacing an existing rule with a different value. */
  readonly updated: readonly AdaptationChange[];
  /** Element ids whose rule is dropped (removed, hidden, or no longer worth adapting). */
  readonly removed: readonly string[];
  /** Changes the browser did not honor (e.g. an inline `!important`). */
  readonly notApplied: readonly AdaptationChange[];
  /** Re-analyzed elements left alone because their analysis was partial/unsupported. */
  readonly unresolved: number;
}

export const EMPTY_ADAPTATION_DELTA: AdaptationDelta = {
  added: [],
  updated: [],
  removed: [],
  notApplied: [],
  unresolved: 0,
};
