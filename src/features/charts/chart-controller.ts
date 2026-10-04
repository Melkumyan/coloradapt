import type { AnalysisRoot } from '@core/analysis';
import {
  CHART_LEGEND_ATTRIBUTE,
  CHART_MARK_ATTRIBUTE,
  CHART_NODE_ATTRIBUTE,
  CHART_OWNED_ATTRIBUTE,
  CHART_OWNER_ATTRIBUTE,
  analyzeChart,
  classifyCanvas,
  encodingKey,
  isSimulated,
  normalizeDashArray,
  ownsChart,
  planChart,
  type ChartAnalysis,
  type ChartAdaptationPlan,
  type ChartFacts,
  type Encoding,
} from '@core/charts';
import { isOutermostSvg, outermostSvg } from '@core/svg';
import {
  EMPTY_CHART_DIAGNOSTICS,
  type ChartConfidence,
  type ChartDiagnostics,
  type ChartStatus,
  type ChartType,
  type ChartUnsupportedReason,
  type VisionProfile,
} from '@domain/models';
import { CHART_LIMITS } from '@shared/constants';
import { buildArtifacts, type Expectation } from './chart-apply';
import { ChartWatch } from './chart-watch';
import { legendScopes } from './html-legend';
import {
  defaultChartEnvironment,
  readCanvasFacts,
  readChartFacts,
  type ChartEnvironment,
  type ReadChart,
} from './chart-facts';

/** What the chart layer needs from the stylesheet. */
export interface ChartSheetHost {
  setChartCss(css: string | null): void;
  /** Runs `read` with the page's own styles in effect (our rules suspended). */
  withOriginalStyles<T>(read: () => T): T;
}

export interface ChartControllerOptions {
  readonly doc: Document;
  readonly sheet: ChartSheetHost;
  readonly env?: ChartEnvironment;
}

export interface ChartSettings {
  readonly enabled: boolean;
  readonly adaptCharts: boolean;
  readonly visionProfile: VisionProfile;
  readonly adaptationStrength?: number;
}

/** What is known about one chart right now (data only). */
export interface ChartInfo {
  readonly status: ChartStatus;
  readonly type: ChartType;
  readonly confidence: ChartConfidence;
  readonly reason: ChartUnsupportedReason | null;
  readonly series: number;
  readonly adapted: number;
  readonly legendMapped: boolean;
}

const UNKNOWN_INFO: ChartInfo = {
  status: 'unknown',
  type: 'unknown',
  confidence: 'UNKNOWN',
  reason: null,
  series: 0,
  adapted: 0,
  legendMapped: false,
};

/** What a chart holds in the page while adapted. */
interface Applied {
  readonly nodes: readonly Element[];
  readonly tagged: ReadonlyArray<{ readonly element: Element; readonly attribute: string }>;
  /** Elements the artifacts depend on: if the page replaces one, the chart is re-applied. */
  readonly targets: readonly Element[];
  readonly signature: string;
}

interface ChartState {
  readonly id: string;
  readonly svg: Element;
  applied: Applied | null;
  info: ChartInfo;
  /** Encodings series wore, so a series added or removed does not renumber the others. */
  readonly prior: Map<string, Encoding>;
  readonly slots: Map<string, number>;
  nextSlot: number;
}

interface Evaluation extends ReadChart {
  readonly analysis: ChartAnalysis;
}

const SHAPE_SELECTOR = 'path, rect, circle, ellipse, line, polyline, polygon';
/** Fewer shapes than this never make a chart (a pie of three slices is the smallest). */
const MIN_SHAPES = 3;
const EMPTY_FACTS: ChartFacts = {
  marks: [],
  texts: [],
  width: 0,
  height: 0,
  hints: [],
  label: null,
  blockers: [],
  overBudget: false,
};

/** Remembered encodings per chart (identity stability); the oldest are forgotten first. */
const MAX_PRIOR = 64;
const MAX_SLOTS = 512;

type Counters = Omit<
  ChartDiagnostics,
  | 'chartsDetected'
  | 'chartsSupported'
  | 'chartsUnsupported'
  | 'seriesAnalyzed'
  | 'seriesAdapted'
  | 'legendsMapped'
  | 'chartOwners'
  | 'chartDefs'
  | 'chartOverlays'
  | 'chartRules'
  | 'chartPending'
  | 'chartWatched'
  | 'watchSubscriptions'
  | 'resizeSignals'
  | 'geometrySignals'
>;

/**
 * The chart layer (M7, docs/CHARTS.md): reads inline SVGs, asks the pure chart core what they
 * are and which series color alone cannot separate, and applies the answer as owned attributes,
 * one owned `<defs>`, decorative overlays and one static stylesheet portion.
 *
 * It owns no observer: {@link update} receives the regions M4 already decided to look at. It
 * reads with the page's own styles in effect, applies everything of one chart or nothing, and
 * counts a chart as adapted only when the browser reproduces what was planned.
 */
export class ChartController {
  readonly #doc: Document;
  readonly #sheet: ChartSheetHost;
  readonly #env: ChartEnvironment;
  #active = false;
  #profile: VisionProfile = 'normal';
  #nextId = 1;
  readonly #states = new Map<Element, ChartState>();
  readonly #css = new Map<string, string>();
  /** Classifications made during analysis (for M5's ownership question), valid until the pass ends. */
  readonly #cache = new Map<Element, Evaluation>();
  #seenCanvas = new WeakSet<Element>();
  #priorProfile: VisionProfile | null = null;
  /** Asks M4 for a pass over one chart (a size or structure change); set by the pipeline. */
  #invalidate: ((svg: Element) => void) | null = null;
  readonly #watch: ChartWatch | null;
  /** Charts with shapes that are not laid out (hidden): watched so that showing them is noticed. */
  readonly #hidden = new Set<Element>();
  #counters: Counters = this.#emptyCounters();

  constructor(options: ChartControllerOptions) {
    this.#doc = options.doc;
    this.#sheet = options.sheet;
    this.#env = options.env ?? defaultChartEnvironment(options.doc);
    const view = options.doc.defaultView;
    this.#watch = view
      ? new ChartWatch(view, (svg) => {
          if (this.#active && svg.isConnected) this.#invalidate?.(svg);
        })
      : null;
  }

  /**
   * Lets the layer ask M4 for a pass over one chart when its size or path structure changes (no
   * mutation says so). `null` stops it. The layer never schedules work itself.
   */
  bindInvalidation(invalidate: ((svg: Element) => void) | null): void {
    this.#invalidate = invalidate;
    if (!invalidate) this.#watch?.disconnect();
  }

  #emptyCounters(): Counters {
    const {
      chartsDetected: _a,
      chartsSupported: _b,
      chartsUnsupported: _c,
      seriesAnalyzed: _d,
      seriesAdapted: _e,
      legendsMapped: _f,
      chartOwners: _g,
      chartDefs: _h,
      chartOverlays: _i,
      chartRules: _j,
      chartPending: _k,
      chartWatched: _l,
      watchSubscriptions: _m,
      resizeSignals: _n,
      geometrySignals: _o,
      ...counters
    } = EMPTY_CHART_DIAGNOSTICS;
    return counters;
  }

  get active(): boolean {
    return this.#active;
  }

  /** Sets what the layer may do. Charts are only touched for an active vision profile with `adaptCharts` on. */
  configure(settings: ChartSettings): void {
    this.#active = settings.enabled && settings.adaptCharts && isSimulated(settings.visionProfile);
    this.#profile = settings.visionProfile;
  }

  /**
   * Starts (or restarts) with these settings: every artifact goes. Remembered encodings stay while
   * the vision profile is the one they were made for (a refresh gives the chart the same look); a
   * different profile has different conflicts, so they start over. What `owns` classified during
   * the analysis that just ran is kept: tearing our artifacts down does not change what a chart is.
   */
  begin(settings: ChartSettings): void {
    this.configure(settings);
    try {
      if (!this.#active) {
        this.end();
        return;
      }
      if (settings.visionProfile !== this.#priorProfile) {
        for (const state of this.#states.values()) state.prior.clear();
      }
      this.#priorProfile = settings.visionProfile;
      for (const state of this.#states.values()) this.#teardown(state);
      this.#commitCss();
    } catch {
      // Whatever could not be undone is retried by the next pass; the pipeline is never interrupted.
    }
  }

  /** Removes everything this layer ever wrote, anywhere in the document. Counters are kept. */
  end(): void {
    this.#active = false;
    this.#states.clear();
    this.#cache.clear();
    this.#css.clear();
    this.#hidden.clear();
    this.#watch?.disconnect();
    for (const node of this.#doc.querySelectorAll(`[${CHART_NODE_ATTRIBUTE}]`)) node.remove();
    for (const attribute of [CHART_MARK_ATTRIBUTE, CHART_LEGEND_ATTRIBUTE, CHART_OWNED_ATTRIBUTE]) {
      for (const element of this.#doc.querySelectorAll(`[${attribute}]`))
        element.removeAttribute(attribute);
    }
    this.#sheet.setChartCss(null);
    this.#seenCanvas = new WeakSet();
  }

  diagnostics(): ChartDiagnostics {
    let chartsDetected = 0;
    let chartsSupported = 0;
    let chartsUnsupported = 0;
    let seriesAnalyzed = 0;
    let seriesAdapted = 0;
    let legendsMapped = 0;
    for (const state of this.#states.values()) {
      const info = state.info;
      if (info.type !== 'unknown') chartsDetected += 1;
      if (info.status === 'supported') chartsSupported += 1;
      if (info.status === 'unsupported' || info.status === 'limited') chartsUnsupported += 1;
      seriesAnalyzed += info.series;
      seriesAdapted += info.adapted;
      if (info.legendMapped) legendsMapped += 1;
    }
    const owners = new Set<string>();
    for (const node of this.#doc.querySelectorAll(`[${CHART_OWNER_ATTRIBUTE}]`)) {
      owners.add(node.getAttribute(CHART_OWNER_ATTRIBUTE) ?? '');
    }
    const rules = [...this.#css.values()].reduce(
      (sum, css) => sum + css.split('\n').filter(Boolean).length,
      0,
    );
    return {
      ...this.#counters,
      chartsDetected,
      chartsSupported,
      chartsUnsupported,
      seriesAnalyzed,
      seriesAdapted,
      legendsMapped,
      chartOwners: owners.size,
      chartDefs: this.#doc.querySelectorAll(`defs[${CHART_NODE_ATTRIBUTE}]`).length,
      chartOverlays: this.#doc.querySelectorAll(`[${CHART_NODE_ATTRIBUTE}="overlay"]`).length,
      chartRules: rules,
      chartPending: this.#cache.size,
      chartWatched: this.#watch?.size ?? 0,
      watchSubscriptions: this.#watch?.counters.subscribed ?? 0,
      resizeSignals: this.#watch?.counters.resizeSignals ?? 0,
      geometrySignals: this.#watch?.counters.geometrySignals ?? 0,
    };
  }

  /** What is known about `svg` (read-only; for tests and debugging). */
  inspect(svg: Element): ChartInfo {
    return this.#states.get(svg)?.info ?? UNKNOWN_INFO;
  }

  /**
   * M5's question: does the chart layer own this SVG? True for any HIGH-confidence chart, adapted
   * or not, so its marks are never recolored twice. Call it with the page's own styles in effect
   * (the analyzer already does); the classification is kept until {@link endPass}.
   */
  owns(svg: Element): boolean {
    if (!this.#active) return false;
    try {
      return ownsChart(this.#evaluate(svg, false).analysis);
    } catch {
      return false;
    }
  }

  /** Forgets what `owns` classified: the page may change before the next pass. */
  endPass(): void {
    this.#cache.clear();
  }

  /** Full pass over the document body. */
  scanDocument(): void {
    const body = this.#doc.body;
    if (this.#active && body) this.update([{ element: body, scope: 'subtree' }]);
  }

  /**
   * Examines the charts (and canvases) inside the given regions, and drops the ones that left.
   * Returns how many leading regions were handled: like every M4 consumer it stops between
   * regions when its structural budget is spent, and the caller re-queues the rest whole.
   *
   * Two phases: every chart is read with the page's own styles in effect (the sheet is suspended
   * once for all of them), then each is planned and applied. Never throws into the pipeline.
   */
  update(roots: readonly AnalysisRoot[], anchors: readonly Element[] = []): number {
    if (!this.#active) {
      this.#cache.clear();
      return roots.length;
    }
    try {
      this.#prune();
      const canvases = new Set<Element>();
      const regions = roots.map((root) => this.#svgsIn(root, canvases));
      // A legend (or anything in a chart's neighbourhood) that came, went, moved or changed: the chart is read again.
      const near = this.#nearby([...roots.map((root) => root.element), ...anchors]);
      if (near.length > 0) {
        if (regions.length === 0) regions.push(near);
        else regions[0] = [...near, ...(regions[0] ?? [])];
      }
      const handled: Element[] = [];
      const seen = new Set<Element>();
      let budget = CHART_LIMITS.maxMarksPerPass;
      let consumed = 0;
      this.#sheet.withOriginalStyles(() => {
        for (const svgs of regions) {
          // The first region is always finished (progress); later ones wait whole when the budget is gone.
          if (consumed > 0 && budget <= 0 && svgs.some((svg) => !seen.has(svg))) break;
          for (const svg of svgs) {
            if (seen.has(svg) || !svg.isConnected) continue;
            seen.add(svg);
            handled.push(svg);
            budget -= this.#readSafely(svg);
          }
          consumed += 1;
        }
      });
      for (const svg of handled) this.#processSafely(svg);
      this.#classifyCanvases(canvases);
      this.#syncWatch();
      return Math.min(consumed, roots.length);
    } catch {
      return roots.length;
    } finally {
      this.#cache.clear();
    }
  }

  /**
   * Tracked charts with a change in their legend neighbourhood (the elements an HTML legend would
   * sit in): re-read so that a legend that appears or moves cannot leave an adapted chart behind it.
   */
  #nearby(changed: readonly Element[]): Element[] {
    if (changed.length === 0) return [];
    const found: Element[] = [];
    for (const svg of this.#states.keys()) {
      if (!svg.isConnected) continue;
      const scopes = legendScopes(svg);
      if (changed.some((el) => !svg.contains(el) && scopes.some((scope) => scope.contains(el)))) {
        found.push(svg);
      }
    }
    return found;
  }

  #svgsIn(root: AnalysisRoot, canvases: Set<Element>): Element[] {
    const unit = outermostSvg(root.element);
    if (unit) return [unit];
    if (root.element.localName === 'canvas') canvases.add(root.element);
    if (root.scope !== 'subtree') return [];
    const svgs: Element[] = [];
    for (const svg of root.element.querySelectorAll<Element>('svg')) {
      if (isOutermostSvg(svg) && svg !== this.#doc.documentElement) svgs.push(svg);
    }
    for (const canvas of root.element.querySelectorAll('canvas')) canvases.add(canvas);
    return svgs;
  }

  /** Reads (and classifies) one chart into the pass cache; returns the marks read. Never throws. */
  #readSafely(svg: Element): number {
    try {
      const { facts } = this.#evaluate(svg, false);
      return facts.marks.length + facts.texts.length;
    } catch {
      return 0;
    }
  }

  /** Never throws into the pipeline: a chart the layer cannot read is left as the page drew it. Returns marks read. */
  #processSafely(svg: Element): number {
    try {
      return this.#process(svg);
    } catch {
      const state = this.#states.get(svg);
      if (state) this.#release(state);
      return 0;
    }
  }

  // --------------------------------------------------------------------- reading

  #read(svg: Element): ReadChart {
    return readChartFacts(svg, this.#env);
  }

  #evaluate(svg: Element, suspend: boolean): Evaluation {
    const cached = this.#cache.get(svg);
    if (cached) return cached;
    // Icons and logos are the common case: a handful of shapes never makes a chart, and costs nothing here.
    if (svg.querySelectorAll(SHAPE_SELECTOR).length < MIN_SHAPES) {
      const trivial: Evaluation = {
        facts: EMPTY_FACTS,
        nodes: new Map(),
        analysis: { status: 'unknown' },
      };
      this.#cache.set(svg, trivial);
      return trivial;
    }
    const read = suspend ? this.#sheet.withOriginalStyles(() => this.#read(svg)) : this.#read(svg);
    const evaluation: Evaluation = { ...read, analysis: analyzeChart(read.facts) };
    this.#cache.set(svg, evaluation);
    return evaluation;
  }

  #classifyCanvases(canvases: ReadonlySet<Element>): void {
    let budget = CHART_LIMITS.maxCanvasPerPass;
    for (const canvas of canvases) {
      if (budget <= 0) break;
      if (this.#seenCanvas.has(canvas)) continue;
      budget -= 1;
      this.#seenCanvas.add(canvas);
      const verdict = classifyCanvas(readCanvasFacts(canvas));
      if (verdict.kind === 'canvas-chart')
        this.#counters = { ...this.#counters, canvasCharts: this.#counters.canvasCharts + 1 };
      else this.#counters = { ...this.#counters, canvasUnknown: this.#counters.canvasUnknown + 1 };
    }
  }

  // ------------------------------------------------------------------- per chart

  #stateFor(svg: Element): ChartState {
    let state = this.#states.get(svg);
    if (!state) {
      state = {
        id: `c${this.#nextId}`,
        svg,
        applied: null,
        info: UNKNOWN_INFO,
        prior: new Map(),
        slots: new Map(),
        nextSlot: 0,
      };
      this.#nextId += 1;
      this.#states.set(svg, state);
    }
    return state;
  }

  #process(svg: Element): number {
    const evaluation = this.#evaluate(svg, true);
    const { analysis, facts } = evaluation;
    const read = facts.marks.length + facts.texts.length;
    this.#bump({
      chartPasses: 1,
      marksScanned: read,
      ...(analysis.status === 'supported' || analysis.status === 'limited'
        ? {
            legendItemsScanned: analysis.chart.legendItems,
            seriesEvaluated: analysis.chart.series.length,
          }
        : {}),
    });
    // Shapes that are not laid out (a hidden panel, a breakpoint): watched, so showing them is noticed.
    if (
      analysis.status === 'unknown' &&
      facts.marks.length > 0 &&
      facts.marks.every((m) => !m.box)
    ) {
      this.#hidden.add(svg);
    } else {
      this.#hidden.delete(svg);
    }
    // An SVG that is not a chart and never was: no state, no attributes, no work next time.
    if (analysis.status === 'unknown' && !this.#states.has(svg)) return read;
    const state = this.#stateFor(svg);

    if (ownsChart(analysis)) {
      if (!svg.hasAttribute(CHART_OWNED_ATTRIBUTE))
        svg.setAttribute(CHART_OWNED_ATTRIBUTE, state.id);
    } else if (svg.hasAttribute(CHART_OWNED_ATTRIBUTE)) {
      svg.removeAttribute(CHART_OWNED_ATTRIBUTE);
    }

    if (analysis.status !== 'supported') {
      this.#release(state);
      state.info =
        analysis.status === 'unknown'
          ? UNKNOWN_INFO
          : {
              status: analysis.status,
              type: analysis.status === 'limited' ? analysis.chart.type : analysis.type,
              confidence:
                analysis.status === 'limited' ? analysis.chart.confidence : analysis.confidence,
              reason: analysis.reason,
              series: analysis.status === 'limited' ? analysis.chart.series.length : 0,
              adapted: 0,
              legendMapped: false,
            };
      if (analysis.status === 'unsupported' && state.info.confidence !== 'HIGH')
        this.#forget(state);
      return read;
    }

    const planned = planChart(analysis.chart, { profile: this.#profile, prior: state.prior });
    if (planned.status === 'limited') {
      this.#release(state);
      state.info = {
        status: 'limited',
        type: analysis.chart.type,
        confidence: analysis.chart.confidence,
        reason: planned.reason,
        series: analysis.chart.series.length,
        adapted: 0,
        legendMapped: analysis.chart.legend.status === 'mapped',
      };
      return read;
    }
    const plan = planned.plan;
    for (const s of plan.series) {
      state.prior.delete(s.seriesId);
      state.prior.set(s.seriesId, s.encoding);
    }
    while (state.prior.size > MAX_PRIOR)
      state.prior.delete(state.prior.keys().next().value as string);

    this.#apply(state, plan, evaluation);
    return read;
  }

  /** A chart-like SVG that is not owned is not remembered: it is "just an SVG". */
  #forget(state: ChartState): void {
    this.#states.delete(state.svg);
  }

  #apply(state: ChartState, plan: ChartAdaptationPlan, evaluation: Evaluation): void {
    const svg = state.svg;
    const info = (
      adapted: number,
      reason: ChartUnsupportedReason | null,
      status: ChartStatus,
    ): ChartInfo => ({
      status,
      type: plan.type,
      confidence: plan.confidence,
      reason,
      series: plan.series.length,
      adapted,
      legendMapped: plan.legendMapped,
    });
    if (!plan.adapts) {
      this.#release(state);
      state.info = info(0, null, 'supported');
      return;
    }

    // Slots are never reused while a chart lives; a chart whose series ids keep changing (colors
    // animated every frame) would grow the table without end. Past the cap it starts over.
    if (state.slots.size > MAX_SLOTS) {
      this.#release(state);
      state.slots.clear();
      state.nextSlot = 0;
    }
    for (const s of plan.series) {
      if (!state.slots.has(s.seriesId)) {
        state.slots.set(s.seriesId, state.nextSlot);
        state.nextSlot += 1;
      }
    }
    const artifacts = buildArtifacts(plan, {
      doc: this.#doc,
      chartId: state.id,
      env: this.#env,
      svg,
      nodes: evaluation.nodes,
      slotOf: (id) => state.slots.get(id) ?? 0,
      // Our own ids from a previous application are free: they go before the new ones come.
      idIsFree: (id) => {
        const holder = this.#doc.getElementById(id);
        return (
          holder === null || holder.closest(`[${CHART_OWNER_ATTRIBUTE}="${state.id}"]`) !== null
        );
      },
    });

    // Something the plan asks for could not be built (an overlay with no box to sit in): all or nothing.
    if (!artifacts.complete) {
      this.#release(state);
      this.#bump({ chartNotApplied: 1 });
      state.info = info(0, 'not-applied', 'limited');
      return;
    }
    const targets = [
      ...artifacts.tagged.map((entry) => entry.element),
      ...artifacts.overlays.map((entry) => entry.anchor),
    ];
    const signature = [
      plan.series
        .filter((s) => s.changed)
        .map((s) => `${s.seriesId}:${encodingKey(s.encoding)}:${state.slots.get(s.seriesId)}`)
        .join(';'),
      String(artifacts.overlays.length),
      String(artifacts.counts.markers),
      String(artifacts.counts.patterns),
      // Hatches and markers are sized in screen pixels: a chart drawn at another scale is re-sized.
      this.#env.unitsPerPixel(svg).toFixed(3),
    ].join('#');

    if (state.applied && this.#intact(state.applied, signature, targets)) {
      this.#bump({ chartPassesSkipped: 1 });
      state.info = info(plan.series.filter((s) => s.changed).length, null, 'supported');
      return;
    }

    this.#teardown(state);
    const nodes: Element[] = [];
    if (artifacts.defs) {
      svg.append(artifacts.defs);
      nodes.push(artifacts.defs);
    }
    for (const overlay of artifacts.overlays) {
      overlay.anchor.after(overlay.node);
      nodes.push(overlay.node);
    }
    for (const entry of artifacts.tagged) entry.element.setAttribute(entry.attribute, entry.value);
    this.#css.set(state.id, artifacts.css);
    state.applied = {
      nodes,
      tagged: artifacts.tagged.map((entry) => ({
        element: entry.element,
        attribute: entry.attribute,
      })),
      targets,
      signature,
    };
    this.#commitCss();

    if (!this.#verify(artifacts.expectations)) {
      this.#release(state);
      this.#bump({ chartNotApplied: 1 });
      state.info = info(0, 'not-applied', 'limited');
      return;
    }
    this.#bump({
      patternsCreated: artifacts.counts.patterns,
      markersCreated: artifacts.counts.markers,
      overlaysCreated: artifacts.counts.overlays,
    });
    state.info = info(plan.series.filter((s) => s.changed).length, null, 'supported');
  }

  /** The browser has the last word: every planned property must be what it reports. */
  #verify(expectations: readonly Expectation[]): boolean {
    for (const { element, property, expected } of expectations) {
      if (!element.isConnected) return false;
      const value = this.#env.getStyle(element).getPropertyValue(property);
      if (property === 'stroke-dasharray') {
        if (normalizeDashArray(value) !== normalizeDashArray(expected)) return false;
      } else if (!value.includes(expected)) return false;
    }
    return true;
  }

  /** Nothing to rewrite: same plan, same targets, everything we wrote still there. */
  #intact(applied: Applied, signature: string, targets: readonly Element[]): boolean {
    if (applied.signature !== signature || applied.targets.length !== targets.length) return false;
    if (!applied.targets.every((element, i) => element === targets[i] && element.isConnected))
      return false;
    if (!applied.nodes.every((node) => node.isConnected)) return false;
    return applied.tagged.every((entry) => entry.element.hasAttribute(entry.attribute));
  }

  // -------------------------------------------------------------------- cleanup

  /** Removes what one chart wrote (nodes, tags, its CSS entry); the sheet is committed by the caller. */
  #teardown(state: ChartState): void {
    const applied = state.applied;
    if (applied) {
      for (const node of applied.nodes) node.remove();
      for (const { element, attribute } of applied.tagged) element.removeAttribute(attribute);
    }
    // Whatever else still says it is ours (a node a framework cloned or moved).
    for (const node of state.svg.querySelectorAll(`[${CHART_OWNER_ATTRIBUTE}="${state.id}"]`))
      node.remove();
    for (const attribute of [CHART_MARK_ATTRIBUTE, CHART_LEGEND_ATTRIBUTE]) {
      for (const element of state.svg.querySelectorAll(`[${attribute}^="${state.id}."]`)) {
        element.removeAttribute(attribute);
      }
    }
    state.applied = null;
    this.#css.delete(state.id);
  }

  /** Tears a chart down and commits the sheet if that changed it. */
  #release(state: ChartState): void {
    const had = state.applied !== null || this.#css.has(state.id);
    this.#teardown(state);
    if (had) this.#commitCss();
  }

  #commitCss(): void {
    const css = [...this.#css.values()].join('\n');
    this.#sheet.setChartCss(css === '' ? null : css);
  }

  /** Watches exactly the charts the layer tracks (and the hidden candidates): nothing else. */
  #syncWatch(): void {
    if (!this.#watch || !this.#invalidate) return;
    const wanted: Element[] = [];
    for (const svg of this.#states.keys()) wanted.push(svg);
    for (const svg of this.#hidden) if (!this.#states.has(svg)) wanted.push(svg);
    this.#watch.sync(wanted);
  }

  /** Drops the charts whose `<svg>` left the document. */
  #prune(): void {
    for (const svg of this.#hidden) if (!svg.isConnected) this.#hidden.delete(svg);
    let removed = false;
    for (const [svg, state] of this.#states) {
      if (svg.isConnected) continue;
      this.#teardown(state);
      this.#states.delete(svg);
      removed = true;
    }
    if (removed) this.#commitCss();
  }

  #bump(delta: Partial<Counters>): void {
    const next = { ...this.#counters };
    for (const [key, value] of Object.entries(delta) as Array<[keyof Counters, number]>) {
      next[key] += value;
    }
    this.#counters = next;
  }
}
