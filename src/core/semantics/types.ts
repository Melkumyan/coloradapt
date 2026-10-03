/**
 * Semantic accessibility domain model (M6, docs/SEMANTIC_ACCESSIBILITY.md).
 *
 * Pipeline, all of it pure data in / pure data out (no DOM in this folder):
 *
 * ```
 * ElementFacts -> SemanticEvidence[] -> SemanticResult -> ColorOnlyVerdict -> SemanticCuePlan
 * ```
 *
 * The one rule that shapes everything: `unknown` beats a wrong conclusion.
 */

/** What an element may be said to communicate. Most elements stay unclassified. */
export const SEMANTIC_STATES = [
  'success',
  'error',
  'warning',
  'info',
  'selected',
  'unselected',
  'active',
  'inactive',
  'enabled',
  'disabled',
  'required',
  'invalid',
  'valid',
  'positive',
  'negative',
  'online',
  'offline',
  'increase',
  'decrease',
] as const;

export type SemanticState = (typeof SEMANTIC_STATES)[number];

/**
 * What a piece of evidence can point at: one concrete state, or the `alert` *family*
 * (`role="alert"`: an error or a warning, the role does not say which) or the `status` family
 * (`role="status"`: a success or an info message, ...). A family hint
 * corroborates a state of its family and never classifies by itself.
 */
export type EvidenceTarget = SemanticState | 'alert' | 'status';

export type EvidenceStrength = 'strong' | 'medium' | 'weak';

/** Where a piece of evidence came from. Provenance is part of the result, never dropped. */
export type EvidenceSource =
  | 'aria-invalid'
  | 'aria-selected'
  | 'aria-current'
  | 'aria-disabled'
  | 'aria-checked'
  | 'aria-pressed'
  | 'aria-required'
  | 'aria-live'
  | 'aria-label'
  | 'aria-describedby'
  | 'role'
  | 'native-invalid'
  | 'native-required'
  | 'native-disabled'
  | 'native-selected'
  | 'class-token'
  | 'data-token'
  | 'text-token'
  | 'title-token'
  | 'id-token'
  | 'context-token'
  | 'color';

/**
 * Independent *kinds* of evidence. Two medium pieces of evidence only corroborate each
 * other when they come from different kinds (a class and a `data-state` are two
 * spellings of the same author habit; a class and the visible text are not).
 */
export type EvidenceKind =
  'aria' | 'native' | 'role' | 'class' | 'data' | 'text' | 'label' | 'id' | 'context' | 'color';

export interface SemanticEvidence {
  readonly source: EvidenceSource;
  /** The attribute value / token / word that was matched (provenance, for tests and debugging). */
  readonly value: string;
  readonly supports: EvidenceTarget;
  readonly strength: EvidenceStrength;
}

export type SemanticConfidence = 'high' | 'medium' | 'low';

/** Why evidence could not be turned into one state. */
export type UnknownReason = 'no-evidence' | 'weak-evidence-only' | 'family-only';

export type SemanticResult =
  | {
      readonly status: 'classified';
      readonly state: SemanticState;
      readonly confidence: SemanticConfidence;
      readonly evidence: readonly SemanticEvidence[];
    }
  | {
      readonly status: 'unknown';
      readonly reason: UnknownReason;
      readonly evidence: readonly SemanticEvidence[];
    }
  | {
      readonly status: 'conflict';
      /** The incompatible states the evidence points at. */
      readonly states: readonly SemanticState[];
      readonly evidence: readonly SemanticEvidence[];
    };

// ---------------------------------------------------------------------------
// Facts: everything the core is allowed to know about one element (read by the
// DOM layer, never by the core). All plain data.
// ---------------------------------------------------------------------------

export type ElementKind =
  /** input, select, textarea, option, img, video, canvas, ...: no pseudo-element can be attached. */
  | 'control'
  /** An element with text or inline content. */
  | 'text'
  /** An empty box with an explicit size: a status dot, a pill without text. */
  | 'dot'
  /** Anything else (table rows, `display: contents`, hidden, ...): never decorated. */
  | 'other';

export interface NativeFacts {
  readonly isControl: boolean;
  readonly required: boolean;
  readonly disabled: boolean;
  readonly empty: boolean;
  /** `validity.valid === false` */
  readonly invalid: boolean;
  /** The field has been interacted with (`:user-invalid` matched, or it holds a value without `:user-invalid` support). */
  readonly nonPristine: boolean;
  readonly selectedOption: boolean;
}

/** Non-color presentation and color presentation of one element, as computed styles. */
export interface StyleSnapshot {
  /** Properties that are not paint: geometry, typography, borders' width/style, decoration, shadows. */
  readonly shape: Readonly<Record<string, string>>;
  /** Properties that are paint only. */
  readonly paint: Readonly<Record<string, string>>;
}

export interface ElementFacts {
  readonly tag: string;
  readonly role: string | null;
  readonly kind: ElementKind;
  readonly classTokens: readonly string[];
  readonly idTokens: readonly string[];
  /** `data-state`, `data-status`, ... values, in attribute order. */
  readonly dataValues: readonly { readonly name: string; readonly value: string }[];
  readonly aria: Readonly<Record<string, string>>;
  readonly title: string;
  /** Visible text, whitespace-collapsed (truncated; `textTruncated` when cut). */
  readonly text: string;
  readonly textTruncated: boolean;
  /** Accessible-name text contributed by `aria-label` / a described-by target (already resolved). */
  readonly labelText: string;
  readonly describedByText: string;
  readonly native: NativeFacts;
  /** Class tokens of the element's parent, for context evidence only. */
  readonly parentClassTokens: readonly string[];
  /** Whether the element is a control variant (`btn-danger`) rather than a state carrier. */
  readonly isInteractive: boolean;
  /** The computed paint hint (`red`, `green`, ...): weak, supporting evidence only. */
  readonly colorHint: string | null;
  /** The element shows an icon of its own: inline SVG, `<img>`, `role="img"`, an icon-font class. */
  readonly hasIcon: boolean;
  /** The page already draws something in the element's `::before` / `::after`. */
  readonly beforeContent: boolean;
  readonly afterContent: boolean;
}

// ---------------------------------------------------------------------------
// Existing cues and color-only detection
// ---------------------------------------------------------------------------

export type ExistingCueKind =
  | 'icon'
  | 'symbol-text'
  | 'state-text'
  | 'pseudo-content'
  | 'marker-text'
  | 'shape-difference'
  | 'content-difference'
  | 'text-style-difference';

/** What the page already shows besides color, on the element itself. */
export interface ExistingCues {
  readonly cues: readonly ExistingCueKind[];
  /** The element's `::before` / `::after` are already used by the page. */
  readonly beforeBusy: boolean;
  readonly afterBusy: boolean;
}

/** A comparable element of the same component, with its own state and presentation. */
export interface PeerFacts {
  readonly state: SemanticState | null;
  readonly style: StyleSnapshot;
  readonly hasIcon: boolean;
  readonly hasText: boolean;
}

export interface ColorOnlyInput {
  readonly state: SemanticState;
  readonly style: StyleSnapshot;
  readonly existing: ExistingCues;
  readonly hasText: boolean;
  readonly kind: ElementKind;
  /** Comparable elements that are in a different (or no) semantic state; empty when none were found. */
  readonly contrastingPeers: readonly PeerFacts[];
}

export type ColorOnlyVerdict =
  | { readonly colorOnly: true; readonly basis: 'peer-comparison' | 'no-content' }
  | {
      readonly colorOnly: false;
      readonly reason:
        'existing-cue' | 'structural-difference' | 'no-visual-difference' | 'cannot-compare';
      /** Detail for tests: the existing cue or the differing property. */
      readonly detail?: string;
    };

// ---------------------------------------------------------------------------
// Cues
// ---------------------------------------------------------------------------

export type CueType =
  | 'icon'
  | 'marker'
  | 'border-style'
  | 'underline'
  | 'prefix-symbol'
  | 'suffix-symbol'
  | 'text-label'
  | 'shape';

/** Where the decoration is drawn. The DOM layer turns a placement into CSS; the core only chooses it. */
export type CuePlacement =
  /** `::after` / `::before` of the element itself, as inline content. */
  | 'after'
  | 'before'
  /** `::after` filling an empty sized box (a dot). */
  | 'inner'
  /** An outline on the element itself (controls, replaced elements). */
  | 'outline'
  /** A text underline on the element itself. */
  | 'underline';

export type OutlineStyle = 'dashed' | 'dotted' | 'double' | 'solid';

export interface CueSpec {
  readonly type: CueType;
  readonly placement: CuePlacement;
  /** The glyph drawn by `after` / `before` / `inner` / `label-after`. */
  readonly glyph?: string;
  /** The pattern drawn by `outline`. */
  readonly outline?: OutlineStyle;
}

/** What the decision layer wants on the page. Data only: applying it is the DOM layer's business. */
export interface SemanticCuePlan {
  /** Every injected cue is ColorAdapt's; the owner is recorded so cleanup can find them. */
  readonly owner: 'coloradapt-semantic';
  readonly state: SemanticState;
  readonly confidence: SemanticConfidence;
  readonly cue: CueSpec;
  /** Human-readable why (tests, debugging). */
  readonly reason: string;
}

export type CueDecision =
  | { readonly action: 'cue'; readonly plan: SemanticCuePlan }
  | {
      readonly action: 'none';
      readonly reason:
        | 'unknown'
        | 'conflict'
        | 'below-threshold'
        | 'no-cue-for-state'
        | 'not-color-only'
        | 'no-safe-placement'
        | 'disabled-by-settings';
      readonly detail?: string;
      /** Set when color-only was assessed (below the confidence threshold: reported, not applied). */
      readonly colorOnly?: boolean;
    };
