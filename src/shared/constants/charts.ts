/**
 * Structural limits of the chart layer (docs/CHARTS.md, "Limits"). Engineering
 * thresholds of what ColorAdapt can model safely and cheaply, not standards.
 * Nothing here is a wall-clock value; a chart over a limit is classified
 * `unsupported`/`limited`, never half-adapted.
 */
export const CHART_LIMITS = {
  /** Painted marks + text elements read from one `<svg>`; more is `too-large`. */
  maxMarks: 2000,
  /** Series of one chart (also the number of generated patterns). */
  maxSeries: 12,
  /** Legend items considered; a cluster of more entries is data labels, not a legend. */
  maxLegendItems: 12,
  /** Vertex count above which a line gets a dash style only (no per-vertex markers). */
  maxMarkerVertices: 60,
  /** Per-vertex marker instances one chart may ask the browser to draw. */
  maxMarkerInstances: 500,
  /** Overlay nodes (legend samples + scatter glyphs) one chart may hold. */
  maxOverlayNodes: 500,
  /**
   * Marks (and texts) read in one pass, summed over its regions. Once spent, the remaining regions
   * are handed back to M4 (whole, for the next pass); the first region of a pass is always finished.
   */
  maxMarksPerPass: 20_000,
  /** Canvas elements classified per pass. */
  maxCanvasPerPass: 50,
  /** SVG elements walked inside one chart (descendants), including defs. */
  maxDescendants: 6000,
  /** Elements the HTML legend guard looks at around one chart (per scope). */
  maxLegendScan: 300,
  /** Charts whose size and geometry the chart layer watches at once (resize + structure bridge). */
  maxWatched: 128,
} as const;

/** Simulated OKLab distance under which two series colors are treated as hard to tell apart. */
export const CHART_PAIR_DISTANCE = 0.12;
