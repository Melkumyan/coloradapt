import type {
  ModelConfidence,
  VisionModel,
  VisionModelFidelity,
  VisionProfile,
} from '@domain/models';

/**
 * The developer-audit model (M9, docs/DEVELOPER_AUDIT.md). Everything in `core/audit` is plain
 * data in, plain data out: no DOM, no clock, no randomness. The browser layer (`features/audit`)
 * reads the page into {@link AuditCandidate}s; this folder turns candidates into findings.
 *
 * Four things are kept apart on purpose, because merging them is how an audit starts to lie:
 *
 * - *what was observed* (a color, a ratio, an attribute) vs. *what was inferred* vs. a
 *   *threshold ColorAdapt chose* vs. an *estimate of a simulation model*: {@link EvidenceBasis};
 * - how *bad* a finding is ({@link AuditSeverity}) vs. how *sure* the audit is of it
 *   ({@link AuditConfidence}) vs. how much *scientific weight* the simulation behind it carries
 *   ({@link AuditSimulation});
 * - a real issue vs. "a human has to look" vs. "ColorAdapt could not analyze this"
 *   ({@link AuditAssessment});
 * - the page as the author wrote it vs. what ColorAdapt did to it ({@link AuditAdaptationStatus}).
 */

/** Version of the exported report format (docs/AUDIT_EXPORT_SCHEMA.md). Bump on any breaking change. */
export const AUDIT_SCHEMA_VERSION = 1;

export const AUDIT_CATEGORIES = [
  'color-contrast',
  'color-distinguishability',
  'color-only-information',
  'semantic-state',
  'svg',
  'chart',
  'image',
  /** Reserved: dynamic content is reported through the other categories, from the page's current state. */
  'dynamic-content',
  'unsupported-content',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const AUDIT_SUBCATEGORIES = [
  'text-contrast',
  'foreground-background-conflict',
  'series-color-conflict',
  'missing-non-color-cue',
  'ambiguous-semantic-color',
  'unreadable-image',
  'unsupported-raster-chart',
  'unsupported-canvas-chart',
  'unsupported-chart',
  'legend-ambiguous',
  'analysis-incomplete',
  'coverage-limited',
  'icon-conflict',
] as const;
export type AuditSubcategory = (typeof AUDIT_SUBCATEGORIES)[number];

/** Most severe first. Documented in docs/DEVELOPER_AUDIT.md, "Severity". */
export const AUDIT_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

/** How sure the audit is that what it reports is true of the page (not how bad it is). */
export const AUDIT_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type AuditConfidence = (typeof AUDIT_CONFIDENCES)[number];

/**
 * - `issue`: a defect ColorAdapt established from deterministic rules over the page's own data;
 * - `manual-review`: something that may matter and that ColorAdapt cannot decide (a canvas chart);
 * - `analysis-limitation`: ColorAdapt could not analyze this; says nothing about the page.
 */
export const AUDIT_ASSESSMENTS = ['issue', 'manual-review', 'analysis-limitation'] as const;
export type AuditAssessment = (typeof AUDIT_ASSESSMENTS)[number];

/**
 * What ColorAdapt did about a finding right now. Never changes the finding itself: the source
 * page still has the problem, whatever the status.
 */
export const AUDIT_ADAPTATION_STATUSES = [
  /** ColorAdapt does not adapt this kind of problem (or nothing was asked of it). */
  'not-applicable',
  /** ColorAdapt looked and found no change needed. */
  'not-needed',
  /** ColorAdapt changed what the user sees. */
  'adapted',
  /** ColorAdapt planned a change the browser did not render. */
  'not-applied',
  /** ColorAdapt searched and found no change it can make safely. */
  'no-safe-candidate',
  /** ColorAdapt does not support this content. */
  'unsupported',
  /** Adaptation is switched off (or this setting is): nothing was attempted. */
  'not-enabled',
] as const;
export type AuditAdaptationStatus = (typeof AUDIT_ADAPTATION_STATUSES)[number];

export const AUDIT_MILESTONES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8'] as const;
export type AuditMilestone = (typeof AUDIT_MILESTONES)[number];

/** Provenance: which subsystem produced the finding, and which others it relied on. */
export interface AuditSource {
  readonly primary: AuditMilestone;
  readonly contributing: readonly AuditMilestone[];
  /** Human name of the primary subsystem (`CSS analysis`, `Semantic cues`, ...). */
  readonly subsystem: string;
}

/** Why a number or a sentence is in a finding. */
export const EVIDENCE_BASES = [
  /** Read from the page or computed from what was read, with no judgement involved. */
  'observed-fact',
  /** Concluded from observed facts by a heuristic (a class name that says "error"). */
  'inference',
  /** A cutoff ColorAdapt chose (contrast target, distance threshold). Not a standard. */
  'engineering-threshold',
  /** The output of a color vision simulation model; carries that model's confidence. */
  'model-estimate',
] as const;
export type EvidenceBasis = (typeof EVIDENCE_BASES)[number];

export type AuditValue =
  | { readonly kind: 'color'; readonly hex: string }
  | { readonly kind: 'colors'; readonly foreground: string; readonly background: string }
  | { readonly kind: 'number'; readonly value: number; readonly unit?: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'list'; readonly items: readonly string[] };

export interface AuditEvidence {
  /** Stable machine name (`contrast.ratio`); unique within one finding's evidence. */
  readonly key: string;
  readonly basis: EvidenceBasis;
  /** Short human label, a deterministic template. */
  readonly label: string;
  readonly value: AuditValue;
}

/** What the page-level simulation behind a finding is worth (docs/COLOR_VISION_SIMULATION.md). */
export interface AuditSimulation {
  readonly profile: VisionProfile;
  readonly model: VisionModel;
  readonly fidelity: VisionModelFidelity;
  /** The M2 confidence of the profile; never upgraded by the audit. */
  readonly modelConfidence: ModelConfidence;
}

// ---------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------

/**
 * How a developer finds an element. Deliberately small and bounded: no page text beyond a short
 * snippet, never a value of a form control, never an attribute that was not asked for.
 */
export interface AuditLocator {
  readonly tag: string;
  readonly id: string | null;
  /** Up to {@link LOCATOR_LIMITS.classes} sanitized class names, in document order. */
  readonly classes: readonly string[];
  readonly role: string | null;
  /** `type` of an `<input>` (`email`), never its value. */
  readonly inputType: string | null;
  /** A bounded, redacted visible-text snippet, or null (always null for form controls). */
  readonly text: string | null;
  /** A short CSS-like path anchored at the nearest unique id, for display. */
  readonly path: string;
}

export const LOCATOR_LIMITS = {
  classes: 3,
  textLength: 40,
  tokenLength: 40,
  pathSegments: 6,
  /** Characters read from the page to make a snippet (never the whole text of a big element). */
  textRead: 200,
} as const;

/**
 * An element as the core sees it. `key` is its structural identity: the same element in the same
 * place gives the same key on every run, whatever its classes, text or state are right now.
 */
export interface AuditTargetInput {
  readonly key: string;
  readonly locator: AuditLocator;
  /** Component signature: what repeated copies of the same element have in common. */
  readonly component: string;
}

export interface AuditAffected {
  /** Stable id of this one finding on this one element. */
  readonly instanceId: string;
  readonly locator: AuditLocator;
  readonly severity: AuditSeverity;
  readonly adaptationStatus: AuditAdaptationStatus;
  readonly evidence: readonly AuditEvidence[];
}

// ---------------------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------------------

export interface AuditSuggestedColor {
  readonly hex: string;
  /** Always set: a suggestion is ColorAdapt's, not a standard. */
  readonly origin: 'coloradapt-generated';
  readonly note: string;
}

export interface AuditRecommendation {
  /** One sentence: what to change. */
  readonly summary: string;
  /** Concrete options, most direct first. */
  readonly actions: readonly string[];
  /** The values this recommendation is about (`#AABBCC on #FFFFFF`), when there are any. */
  readonly observed: string | null;
  /** What ColorAdapt did on the page about it, when it did something. */
  readonly coloradapt: string | null;
  /** Only when M3 found a validated candidate. */
  readonly suggestedColor: AuditSuggestedColor | null;
}

/** The facts a recommendation may mention. Strings are already bounded and safe. */
export interface RecommendationContext {
  readonly observed?: string;
  readonly state?: string;
  readonly reason?: string;
  readonly chartType?: string;
  readonly trigger?: string;
  readonly suggestedHex?: string;
  readonly adaptation: AuditAdaptationStatus;
}

// ---------------------------------------------------------------------------------------
// Severity inputs
// ---------------------------------------------------------------------------------------

export type FunctionalImpact = 'none' | 'minor' | 'moderate' | 'major';
export type InformationLoss = 'none' | 'partial' | 'total';
export type Redundancy = 'present' | 'absent' | 'unknown';

/** Everything {@link computeSeverity} may look at, apart from the rule's default and the status. */
export interface SeverityFactors {
  /** What breaks for the user if the problem is not noticed. */
  readonly functionalImpact: FunctionalImpact;
  /** How much of the information the element carries is lost. */
  readonly informationLoss: InformationLoss;
  /** The element is something a user operates (link, button, form field, tab). */
  readonly interactive: boolean;
  /** Whether another, non-color way of telling things apart exists (partly). */
  readonly redundancy: Redundancy;
}

// ---------------------------------------------------------------------------------------
// Candidates, findings, snapshot
// ---------------------------------------------------------------------------------------

/**
 * One problem on one element, as the evaluators emit it (before severity, dedup, grouping).
 * `profile` is the profile the problem was evaluated under; `null` for a problem that does not
 * depend on one (a semantic cue missing, a contrast ratio).
 */
export interface AuditCandidate {
  readonly ruleId: string;
  readonly target: AuditTargetInput;
  /** Part of the identity: the state, the trigger, ... that makes two problems on one element different. */
  readonly context: string;
  readonly profile: VisionProfile | null;
  readonly confidence: AuditConfidence;
  readonly assessment: AuditAssessment;
  readonly title?: string;
  readonly summary: string;
  readonly evidence: readonly AuditEvidence[];
  readonly factors: SeverityFactors;
  readonly adaptation: AuditAdaptationStatus;
  readonly simulation: AuditSimulation | null;
  readonly recommendation: RecommendationContext;
}

export interface AuditFinding {
  /** Group id: `<ruleId>:<hash of rule, component, context>`; stable across refreshes. */
  readonly id: string;
  readonly ruleId: string;
  readonly category: AuditCategory;
  readonly subcategory: AuditSubcategory;
  readonly severity: AuditSeverity;
  /** Why this severity: one line per step of the documented algorithm. */
  readonly severityReasons: readonly string[];
  readonly confidence: AuditConfidence;
  readonly assessment: AuditAssessment;
  readonly title: string;
  readonly summary: string;
  /** Evidence of the most severe affected element. */
  readonly evidence: readonly AuditEvidence[];
  /** Exact number of elements this finding covers. */
  readonly affectedCount: number;
  /** The first {@link AUDIT_LIMITS.sampleTargets} of them, most severe first. */
  readonly affected: readonly AuditAffected[];
  readonly recommendation: AuditRecommendation;
  readonly source: AuditSource;
  /** Profiles the problem exists under; empty for a problem that is not profile-specific. */
  readonly visionProfiles: readonly VisionProfile[];
  readonly simulation: readonly AuditSimulation[];
  /** The worst status among the affected elements (see `ADAPTATION_PRECEDENCE`). */
  readonly adaptationStatus: AuditAdaptationStatus;
  readonly adaptationBreakdown: Readonly<Partial<Record<AuditAdaptationStatus, number>>>;
  /** Fixed sentence about source page vs. adapted appearance. */
  readonly sourceNote: string;
  readonly wcag: readonly WcagRelation[];
}

export interface WcagRelation {
  readonly criterion: string;
  readonly name: string;
  /** Always `related-to`: ColorAdapt never claims conformance or failure. */
  readonly relation: 'related-to';
}

export const AUDIT_LIMITS = {
  /** Affected elements kept per finding in a snapshot (the count stays exact). */
  sampleTargets: 50,
  /** Findings (groups) a snapshot holds; beyond it `truncatedFindings` says how many were left out. */
  maxFindings: 1000,
  /** Pairs of chart series listed in one chart's evidence. */
  chartPairs: 6,
} as const;

/**
 * How much of a subsystem's job one audit pass did (docs/DEVELOPER_AUDIT.md, "Coverage"):
 * `complete` everything the subsystem is documented to look at was looked at; `partial` a budget
 * or a documented restriction left part of it out; `disabled` a setting turned it off (nothing
 * was looked at); `unsupported` ColorAdapt does not audit it at all. A clean result in anything
 * but `complete` is not evidence about the part that was not looked at.
 */
export const AUDIT_COVERAGE_LEVELS = ['complete', 'partial', 'disabled', 'unsupported'] as const;
export type AuditCoverageLevel = (typeof AUDIT_COVERAGE_LEVELS)[number];

export interface AuditSubsystemCoverage {
  /** Stable machine name, one of `AUDIT_SUBSYSTEM_IDS`. */
  readonly id: string;
  readonly name: string;
  readonly level: AuditCoverageLevel;
  /** One fixed sentence saying what was and was not looked at. */
  readonly note: string;
}

export interface AuditCoverage {
  /** Per subsystem, in a fixed order. Global limits live here, not as one finding per element. */
  readonly subsystems: readonly AuditSubsystemCoverage[];
  /** Budgets one pass hit (`analyzed elements`, `chart marks`, ...), sorted. Empty when none was hit. */
  readonly budgetsReached: readonly string[];
  /** Elements of the CSS analysis (M1/M5), whether or not they had a finding. */
  readonly elementsAnalyzed: number;
  readonly analysisTruncated: boolean;
  readonly semanticCandidates: number;
  readonly svgUnits: number;
  readonly charts: number;
  readonly canvases: number;
  readonly images: number;
  /** Findings (groups) that did not fit {@link AUDIT_LIMITS.maxFindings}; their counts are in `summary`. */
  readonly truncatedFindings: number;
}

export interface AuditSummary {
  /** Findings (groups) in the snapshot. */
  readonly findings: number;
  /** Elements affected, summed over findings (an element in two findings counts twice). */
  readonly affectedElements: number;
  readonly bySeverity: Readonly<Record<AuditSeverity, number>>;
  readonly byCategory: Readonly<Record<AuditCategory, number>>;
  readonly byConfidence: Readonly<Record<AuditConfidence, number>>;
  readonly byAssessment: Readonly<Record<AuditAssessment, number>>;
  readonly byAdaptation: Readonly<Record<AuditAdaptationStatus, number>>;
  /** `issue` findings ColorAdapt visibly compensated for (the source page is unchanged). */
  readonly adapted: number;
  /** `issue` findings nothing compensates for. */
  readonly unresolved: number;
  readonly manualReview: number;
}

export interface AuditSettingsInfo {
  /** The profile the user has selected; the audit may cover others too. */
  readonly activeProfile: VisionProfile;
  readonly auditedProfiles: readonly VisionProfile[];
  readonly adaptationEnabled: boolean;
}

export interface AuditPageInfo {
  /** `origin` only: no credentials, no port quirks beyond the origin, no query, no hash. */
  readonly origin: string;
  /** Pathname with opaque-looking segments redacted. */
  readonly pathname: string;
}

/** The audit of one page at one moment. Immutable once built; a newer generation replaces it whole. */
export interface AuditSnapshot {
  readonly schemaVersion: typeof AUDIT_SCHEMA_VERSION;
  /** Monotonic per page; an older generation never replaces a newer one. */
  readonly generation: number;
  readonly timestamp: number;
  readonly page: AuditPageInfo;
  readonly extensionVersion: string;
  readonly settings: AuditSettingsInfo;
  readonly coverage: AuditCoverage;
  readonly findings: readonly AuditFinding[];
  readonly summary: AuditSummary;
}

/** Fixed note carried by every finding. Adaptation never hides a source problem. */
export const SOURCE_NOTE =
  'Measured on the original page. ColorAdapt’s own changes (recoloring, cues, chart encodings, ' +
  'generated images) are ignored here, so the finding stays until the page itself is fixed.';
