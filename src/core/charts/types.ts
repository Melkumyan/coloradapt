import type {
  ChartConfidence,
  ChartType,
  ChartUnsupportedReason,
  ColorValue,
  ModelConfidence,
  VisionModel,
  VisionProfile,
} from '@domain/models';

/**
 * The plain-data model of the chart layer (docs/CHARTS.md). The browser layer
 * reads an `<svg>` into {@link ChartFacts}; everything below is a pure function
 * of those facts. Nothing in `core/charts` touches the DOM.
 */

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** What paints a mark's fill or stroke. */
export interface PaintFacts {
  readonly kind: 'none' | 'solid' | 'gradient' | 'pattern' | 'other';
  /** For `solid`: the color (alpha is the paint's own; opacity is separate). */
  readonly color: ColorValue | null;
  /** For a paint server: the reference text (`url(#a)`), so two marks can be told apart. */
  readonly ref: string | null;
  /** Paint opacity x element opacity, 0-1. */
  readonly opacity: number;
}

export const NO_PAINT: PaintFacts = { kind: 'none', color: null, ref: null, opacity: 1 };

/** One painted shape of the chart, as the browser computed it. `order` is document order among marks and texts. */
export interface MarkFacts {
  readonly order: number;
  readonly tag: string;
  /** Ids of the nearest ancestors inside the chart, nearest first (up to 3). */
  readonly ancestry: readonly number[];
  readonly fill: PaintFacts;
  readonly stroke: PaintFacts;
  readonly strokeWidth: number;
  /** Computed `stroke-dasharray`, numbers only (`'5 3'`), or null for none. */
  readonly dash: string | null;
  /** The computed `marker-mid`/`marker-start`/`marker-end` reference, or null. */
  readonly markerRef: string | null;
  /** Path vertices / polyline points (1 for a plain shape). */
  readonly vertices: number;
  /** Closed outline: a rect, circle, ellipse, polygon, or a path ending in Z. */
  readonly closed: boolean;
  /** Arc commands in a path (a pie slice has one, a donut slice two). */
  readonly arcCount: number;
  /** Only horizontal and vertical segments (axes, steps, gridlines). */
  readonly rectilinear: boolean;
  readonly box: Box | null;
  readonly classTokens: readonly string[];
  /** `data-series` / `data-key` / `data-name` (whichever the author wrote). */
  readonly dataSeries: string | null;
  /** `aria-label` or a `<title>` child. */
  readonly label: string | null;
}

export interface TextFacts {
  readonly order: number;
  readonly ancestry: readonly number[];
  readonly text: string;
  readonly color: ColorValue | null;
  readonly box: Box | null;
  readonly classTokens: readonly string[];
}

/** Why an SVG cannot be a supported chart no matter what its marks look like. */
export type ChartBlocker =
  'animated' | 'filter' | 'mask' | 'foreign-object' | 'embedded-image' | 'html-legend';

export interface ChartFacts {
  readonly marks: readonly MarkFacts[];
  readonly texts: readonly TextFacts[];
  /** Rendered size of the `<svg>`, or the viewBox size when not laid out. */
  readonly width: number;
  readonly height: number;
  /** Class/id/role/aria tokens of the `<svg>` and two ancestors, lower-cased. */
  readonly hints: readonly string[];
  /** The `<svg>`'s own accessible label (`aria-label`, `<title>`), if any. */
  readonly label: string | null;
  readonly blockers: readonly ChartBlocker[];
  /** The walk hit a structural limit: the facts are incomplete. */
  readonly overBudget: boolean;
}

// ----------------------------------------------------------------------- legend

export type SwatchKind = 'box' | 'line' | 'point';

/** One legend entry: a small swatch followed by its text. */
export interface LegendItem {
  /** Order of the swatch mark. */
  readonly swatchOrder: number;
  readonly textOrder: number;
  readonly kind: SwatchKind;
  readonly label: string;
  /** The color the swatch shows (stroke for a line sample, fill otherwise). */
  readonly color: ColorValue | null;
  /** Identity of the swatch's paint: `#rrggbb`, or `ref:url(#id)` for a pattern; null when unreadable. */
  readonly paintKey: string | null;
  readonly dataSeries: string | null;
  readonly classTokens: readonly string[];
  readonly box: Box | null;
  readonly strokeWidth: number;
}

// ----------------------------------------------------------------------- series

export type SeriesKind = 'line' | 'point' | 'bar' | 'slice';

/** The non-color encoding a series already has in the page. */
export interface ExistingEncoding {
  readonly dash: string | null;
  readonly markerRef: string | null;
  /** Reference of a pattern fill, or null. */
  readonly patternRef: string | null;
  readonly strokeWidth: number;
  /** Tag (+ vertex count for paths) of the series' points; null for lines/bars. */
  readonly pointShape: string | null;
  /** A text label sits at the series itself (not in a legend). */
  readonly directLabel: boolean;
}

export interface ChartSeries {
  /** Stable within a chart's lifecycle: `k:<key>`, `t:<token>`, `c:<color>` or `o:<index>`. */
  readonly id: string;
  /** Position among the series, in order of first mark. */
  readonly index: number;
  readonly kind: SeriesKind;
  readonly label: string | null;
  /** The visible color of the series (stroke for lines, fill otherwise; a neutral gray for a pattern-only fill). */
  readonly color: ColorValue;
  /** Identity of the series' paint: `#rrggbb`, or `ref:url(#id)` for a pattern fill. */
  readonly paintKey: string;
  /** Series-specific class tokens shared by all of the series' marks. */
  readonly classTokens: readonly string[];
  /** `data-series`-style key, when the author wrote one on every mark. */
  readonly dataSeries: string | null;
  /** Orders of the marks that make up the series. */
  readonly marks: readonly number[];
  readonly existing: ExistingEncoding;
  /** Largest vertex count among the series' paths (for the marker density policy). */
  readonly maxVertices: number;
  /** Some marks are points drawn on a line (the page's own vertex markers): no markers are added. */
  readonly memberPoints: boolean;
}

// ---------------------------------------------------------------- legend mapping

export type MappingEvidence = 'key' | 'token' | 'color';

export interface LegendPair {
  readonly seriesId: string;
  readonly item: LegendItem;
  readonly evidence: MappingEvidence;
}

export type LegendMapping =
  /** No legend items in the chart. */
  | { readonly status: 'none' }
  /** Every series has exactly one legend item and no item has two series. */
  | { readonly status: 'mapped'; readonly pairs: readonly LegendPair[] }
  | {
      readonly status: 'ambiguous';
      readonly reason: 'no-match' | 'duplicate-color' | 'conflicting-evidence' | 'partial';
    };

// -------------------------------------------------------------------- encodings

export type LineStyleId = 'solid' | 'dashed' | 'dotted' | 'dash-dot' | 'long-dash';
/** `ring` (a hollow point) exists for scatter points only; line markers are circle/square/triangle/diamond/cross. */
export type MarkerId = 'circle' | 'square' | 'triangle' | 'diamond' | 'cross' | 'plus' | 'ring';
export type PatternId =
  'diagonal' | 'crosshatch' | 'dots' | 'horizontal' | 'vertical' | 'diagonal-reverse';

/** The non-color identity of one series. `solid`/`null`/`null` is "as the page drew it". */
export interface Encoding {
  readonly dash: LineStyleId;
  readonly marker: MarkerId | null;
  readonly pattern: PatternId | null;
}

export const DEFAULT_ENCODING: Encoding = { dash: 'solid', marker: null, pattern: null };

export function isDefaultEncoding(encoding: Encoding): boolean {
  return encoding.dash === 'solid' && encoding.marker === null && encoding.pattern === null;
}

export function encodingKey(encoding: Encoding): string {
  return `${encoding.dash}|${encoding.marker ?? '-'}|${encoding.pattern ?? '-'}`;
}

// ---------------------------------------------------------------------- analysis

/** The chart's structure, before anything is decided about adapting it. */
export interface ChartDescriptor {
  readonly type: ChartType;
  readonly confidence: ChartConfidence;
  /** What the classification rests on (for diagnostics and tests). */
  readonly evidence: readonly string[];
  readonly series: readonly ChartSeries[];
  readonly legend: LegendMapping;
  /** Legend entries the detector found (mapped or not). */
  readonly legendItems: number;
  /** Orders of marks and texts that are legend swatches/labels (never data). */
  readonly legendOrders: ReadonlySet<number>;
}

export type ChartAnalysis =
  | { readonly status: 'supported'; readonly chart: ChartDescriptor }
  | {
      readonly status: 'limited';
      readonly reason: ChartUnsupportedReason;
      readonly chart: ChartDescriptor;
    }
  | {
      readonly status: 'unsupported';
      readonly reason: ChartUnsupportedReason;
      readonly type: ChartType;
      readonly confidence: ChartConfidence;
    }
  | { readonly status: 'unknown' };

// -------------------------------------------------------------------------- plan

/** Pairwise result for two series under the active profile. */
export interface PairReport {
  readonly a: string;
  readonly b: string;
  readonly originalDistance: number;
  readonly simulatedDistance: number;
  /** Hard to tell apart by color under the profile. */
  readonly problematic: boolean;
  /** Told apart without color (existing style, marker, pattern, direct labels, or ours). */
  readonly distinctWithoutColor: boolean;
  /** Told apart by the page's own non-color encoding, before any adaptation. */
  readonly alreadyDistinct: boolean;
}

export interface SeriesPlan {
  readonly seriesId: string;
  readonly index: number;
  readonly kind: SeriesKind;
  readonly label: string | null;
  readonly color: ColorValue;
  readonly marks: readonly number[];
  readonly existing: ExistingEncoding;
  readonly encoding: Encoding;
  /** The encoding differs from what the page drew: something is written. */
  readonly changed: boolean;
  /** The legend entry that must show the same encoding; null when the chart has no legend. */
  readonly legendItem: LegendItem | null;
  /** M7 prefers redundancy to recoloring: always null today (docs/CHARTS.md). */
  readonly colorAdjustment: null;
}

export interface ChartAdaptationPlan {
  readonly type: ChartType;
  readonly confidence: ChartConfidence;
  readonly profile: VisionProfile;
  readonly model: VisionModel | null;
  /** How much scientific weight the simulation behind `profile` carries (M2, never upgraded). */
  readonly modelConfidence: ModelConfidence;
  readonly series: readonly SeriesPlan[];
  readonly pairs: readonly PairReport[];
  /** Pairs that are hard to tell apart by color and are not told apart without it either: must be 0. */
  readonly unresolvedPairs: number;
  readonly legendMapped: boolean;
  /** At least one series is written. */
  readonly adapts: boolean;
  /** Per-vertex marker instances / overlay nodes / patterns the plan asks for. */
  readonly budget: {
    readonly markerInstances: number;
    readonly overlays: number;
    readonly patterns: number;
  };
}

export type ChartPlanResult =
  | { readonly status: 'planned'; readonly plan: ChartAdaptationPlan }
  | { readonly status: 'limited'; readonly reason: ChartUnsupportedReason };

export interface PlanOptions {
  readonly profile: VisionProfile;
  readonly severity?: number;
  /** Encodings series already have in this chart's lifecycle (identity stability). */
  readonly prior?: ReadonlyMap<string, Encoding>;
}
