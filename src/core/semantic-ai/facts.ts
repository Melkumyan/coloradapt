import type { SemanticTask } from './taxonomy';
import type { ColorRelation, EvidenceStrength } from './query';

/**
 * What the browser layer may hand the packet builder: plain, already-read facts about one element.
 * Nothing here is a node. The builder bounds, redacts and allowlists everything again, so a caller
 * that forgets to is not a privacy hole (docs/AI_PRIVACY.md).
 */

/** An earlier deterministic signal (M6 evidence), in M6's own vocabulary. */
export interface RawSignal {
  /** An M6 `EvidenceSource` (`class-token`, `role`, `text-token`, ...). ARIA sources are ignored: ARIA is read from `aria`. */
  readonly source: string;
  readonly value: string;
  readonly strength: EvidenceStrength;
  /** An M6 `EvidenceTarget` (`error`, `selected`, `alert`, ...). */
  readonly supports: string;
}

export interface RawPeer {
  readonly tag: string;
  readonly role: string | null;
  readonly name: string | null;
  /** The M6 state of the peer, when it has one. */
  readonly state: string | null;
}

export interface RawChartSeries {
  readonly title: string | null;
  readonly colorName: string | null;
}

export interface RawChart {
  readonly chartType: string;
  readonly legendEntry: string | null;
  /** 1-based position of the entry in its legend. */
  readonly legendIndex: number | null;
  readonly legendCount: number;
  readonly swatchColorName: string | null;
  readonly series: readonly RawChartSeries[];
}

export interface SemanticFacts {
  readonly task: SemanticTask;
  /** The rule that left the case to a human (`CA-SEM-002`). */
  readonly ruleId: string;
  readonly tag: string;
  readonly role: string | null;
  /** `type` of an input; never a value. */
  readonly controlType: string | null;
  /** The ARIA attributes read from the element, name -> raw value. Names and values are allowlisted by the builder. */
  readonly aria: Readonly<Record<string, string>>;
  readonly accessibleName: string | null;
  readonly title: string | null;
  /** A form field (or a control the user fills in): its text is its value, so no text of its own is passed on. */
  readonly isField: boolean;
  readonly interactive: boolean;
  /** Inside an `aria-hidden="true"` subtree: the author hid it from assistive technology (which says little about what it is). */
  readonly hiddenFromAT: boolean;
  /** The author declared it presentational: `role="presentation"` / `"none"`, or an image with an empty `alt`. */
  readonly presentational: boolean;
  readonly nearbyLabels: readonly string[];
  readonly peers: readonly RawPeer[];
  readonly colorRelation: ColorRelation;
  readonly signals: readonly RawSignal[];
  /** Class-name segments (icons): `icon-close` -> `icon`, `close`. */
  readonly classSegments: readonly string[];
  readonly chart: RawChart | null;
  readonly image: { readonly classification: string; readonly small: boolean } | null;
}
