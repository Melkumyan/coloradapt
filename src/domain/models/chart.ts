/**
 * Plain data of the chart layer (M7, docs/CHARTS.md). The pure core
 * (`core/charts`) and the browser layer (`features/charts`) share these;
 * neither needs the other's code.
 */

/** Chart families the classifier can tell apart. Only some are adapted (docs/CHARTS.md). */
export type ChartType =
  'line' | 'area' | 'bar' | 'stacked-bar' | 'scatter' | 'pie' | 'donut' | 'heatmap' | 'unknown';

/** How sure the classifier is that an SVG is a chart of that type. Only `HIGH` is adapted. */
export type ChartConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

/**
 * Why a chart is not (fully) adapted. These are engineering classifications of what ColorAdapt
 * can model safely, not statements about the chart.
 */
export type ChartUnsupportedReason =
  /** Heatmap: color encodes magnitude, not identity. Detected only. */
  | 'heatmap-sequential'
  /** Area / stacked bar: classified, not adapted in M7. */
  | 'type-not-adapted'
  /** A gradient fills a mark: it may be a sequential/diverging encoding. */
  | 'paint-gradient'
  | 'animated'
  | 'filter'
  | 'mask'
  | 'foreign-object'
  | 'embedded-image'
  /** Over a structural limit (marks, series, legend items). */
  | 'too-large'
  | 'too-many-series'
  /** The classifier is not confident enough this is a supported chart (`MEDIUM`/`LOW`/`UNKNOWN`). */
  | 'low-confidence'
  /** A legend exists but series and legend items cannot be paired deterministically. */
  | 'legend-ambiguous'
  /** An HTML legend sits next to the chart; M7 only synchronizes inline SVG legends. */
  | 'html-legend'
  /** A pie/donut without a complete series <-> legend mapping. */
  | 'pie-without-legend'
  /** Bars/slices in a single-hue (or gray) ramp: color there is probably magnitude, not category. */
  | 'sequential-palette'
  /** No unique combination of line style, marker and pattern is left for every series. */
  | 'encoding-exhausted'
  /** The browser did not reproduce what was planned (specificity, `!important`, ...). */
  | 'not-applied';

/** What the chart layer did with one SVG. */
export type ChartStatus = 'supported' | 'limited' | 'unsupported' | 'unknown';

/**
 * Counters and gauges of the chart layer, for tests and debugging only. No telemetry. The first
 * group are gauges of the charts tracked right now (a removed chart leaves them); the rest are
 * counters that only grow.
 */
export interface ChartDiagnostics {
  /** Charts the layer owns right now: HIGH confidence, whatever happened to them next. */
  readonly chartsDetected: number;
  /** Of those, `supported` (an adaptable type, series and legend mapped). */
  readonly chartsSupported: number;
  /** Of those, recognized and refused: a type M7 does not adapt, a blocker, or `limited`. */
  readonly chartsUnsupported: number;
  readonly seriesAnalyzed: number;
  /** Series (of the tracked charts) that wear a non-color encoding. */
  readonly seriesAdapted: number;
  readonly legendsMapped: number;
  readonly patternsCreated: number;
  readonly markersCreated: number;
  /** Overlay nodes created (legend line samples, scatter glyphs). */
  readonly overlaysCreated: number;
  /** Charts whose planned encoding the browser did not reproduce (rolled back). */
  readonly chartNotApplied: number;
  /** `<canvas>` elements that look like data visualization (detected, never adapted). */
  readonly canvasCharts: number;
  /** Other `<canvas>` elements (never adapted). */
  readonly canvasUnknown: number;
  /** Chart evaluations (one per chart per pass). */
  readonly chartPasses: number;
  /** Chart evaluations that found the chart unchanged and wrote nothing. */
  readonly chartPassesSkipped: number;
  /** Marks read by the chart layer. */
  readonly marksScanned: number;
  /** Gauges (right now): charts holding M7 artifacts, owned `<defs>`, overlays, rules. */
  readonly chartOwners: number;
  readonly chartDefs: number;
  readonly chartOverlays: number;
  readonly chartRules: number;
  /** Charts waiting for work (always 0 once a pass has finished). */
  readonly chartPending: number;
  /** Gauge: charts the resize/geometry bridge watches right now (0 when adaptation is off). */
  readonly chartWatched: number;
  /** Subscriptions made by the bridge (a chart starts being watched). */
  readonly watchSubscriptions: number;
  /** Size changes of a watched chart passed to M4. */
  readonly resizeSignals: number;
  /** Structural `d`/`points` changes of a watched chart passed to M4. */
  readonly geometrySignals: number;
  /** Legend entries found by the chart classifier (summed over evaluations). */
  readonly legendItemsScanned: number;
  /** Series analyzed by the classifier (summed over evaluations). */
  readonly seriesEvaluated: number;
}

export const EMPTY_CHART_DIAGNOSTICS: ChartDiagnostics = {
  chartsDetected: 0,
  chartsSupported: 0,
  chartsUnsupported: 0,
  seriesAnalyzed: 0,
  seriesAdapted: 0,
  legendsMapped: 0,
  patternsCreated: 0,
  markersCreated: 0,
  overlaysCreated: 0,
  chartNotApplied: 0,
  canvasCharts: 0,
  canvasUnknown: 0,
  chartPasses: 0,
  chartPassesSkipped: 0,
  marksScanned: 0,
  chartOwners: 0,
  chartDefs: 0,
  chartOverlays: 0,
  chartRules: 0,
  chartPending: 0,
  chartWatched: 0,
  watchSubscriptions: 0,
  resizeSignals: 0,
  geometrySignals: 0,
  legendItemsScanned: 0,
  seriesEvaluated: 0,
};
