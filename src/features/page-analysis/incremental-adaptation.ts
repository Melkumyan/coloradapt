import {
  analyzeSubtrees,
  collectOwnedIds,
  type AnalysisRoot,
  type AnalyzeDocumentOptions,
} from '@core/analysis';
import {
  createOutcomeCounts,
  createPlanningContext,
  planElement,
  ruleKey,
  toSummary,
  type ElementOutcome,
  type OutcomeCounts,
  type PlanningContext,
  type PlanningMemo,
  type StylesheetManager,
} from '@core/adaptation';
import { EMPTY_SEMANTIC_DIAGNOSTICS } from '@domain/models';
import type {
  AdaptationChange,
  AdaptationDelta,
  AdaptationSummary,
  ElementDescriptor,
  SemanticDiagnostics,
  SvgDiagnostics,
  SvgUnitInfo,
  UserSettings,
} from '@domain/models';
import type { PeerSeed, SemanticCueController } from '../semantics';
import { findNotAdaptable } from './adaptability';

/** Cap on the per-session optimizer memo (distinct color pairs); cleared when exceeded. */
const MAX_MEMO_ENTRIES = 2048;

/** What the page-level bookkeeping remembers per element: a string, never a node. */
type TrackedKind = ElementOutcome['kind'] | 'notApplied';

export interface IncrementalPassInput {
  /** Regions to re-analyze (already de-duplicated by the caller). */
  readonly roots: readonly AnalysisRoot[];
  /** Ids of elements that left the document; their adaptation is dropped. */
  readonly removedIds: readonly string[];
  /** Where elements left the page: their former peers are re-examined by the semantic layer (M6). */
  readonly peerSeeds?: readonly PeerSeed[];
}

export interface IncrementalPassResult {
  /** How many leading `roots` were consumed; the caller re-queues the rest. */
  readonly rootsConsumed: number;
  /** Candidate elements inspected by the analyzer. */
  readonly elementsProcessed: number;
  /** A budget cut a root short; its tail was not analyzed. */
  readonly truncated: boolean;
  readonly delta: AdaptationDelta;
  /** Rules actually added/updated/removed in the stylesheet. */
  readonly rules: { readonly added: number; readonly updated: number; readonly removed: number };
}

/** The part of the incremental machinery the dynamic pipeline is allowed to use. */
export interface IncrementalAdaptation {
  /** True between a successful (enabled) full adaptation and `disableAdaptation`. */
  readonly active: boolean;
  /** Page-level tallies, kept current across incremental passes. */
  summary(): AdaptationSummary;
  /** Rules currently in the injected stylesheet. */
  readonly ruleCount: number;
  /** The injected stylesheet holds anything (color rules or semantic cue CSS): losing it needs repair. */
  readonly hasInjectedContent: boolean;
  /** Counters of the semantic-cue layer (docs/SEMANTIC_ACCESSIBILITY.md). */
  semanticDiagnostics(): SemanticDiagnostics;
  /** Elements the bookkeeping currently tracks (ids only; for leak tests and diagnostics). */
  trackedCount(): number;
  /** Gauges of the inline-SVG units currently tracked. */
  svgDiagnostics(): SvgDiagnostics;
  /** Re-analyzes `input.roots` and applies only the difference. */
  update(input: IncrementalPassInput): IncrementalPassResult;
  /**
   * Only elements left the page and none of them held a color rule: nothing for the color layer to
   * do, but the semantic layer re-examines their former peers (M6.R1). Not an incremental pass.
   */
  updatePeers(seeds: readonly PeerSeed[]): void;
  /** Re-attaches the sheet if the page removed it. */
  repairStylesheet(): boolean;
  /** The injected `<style>` element, if any (for mutation-ownership checks). */
  readonly styleElement: HTMLStyleElement | null;
}

/** The analyzed element a change belongs to (an inline SVG for all of its rules). */
function owner(change: AdaptationChange): string {
  return change.ownerId ?? change.elementId;
}

const EMPTY_RESULT: IncrementalPassResult = {
  rootsConsumed: 0,
  elementsProcessed: 0,
  truncated: false,
  delta: { added: [], updated: [], removed: [], notApplied: [], unresolved: 0 },
  rules: { added: 0, updated: 0, removed: 0 },
};

/**
 * Per-document bookkeeping that lets the page be re-adapted region by region.
 * A full adaptation `begin`s it (seeding one outcome per analyzed element);
 * from then on `update` re-analyzes only the given roots, plans them with the
 * same per-element logic as the full plan, and hands the stylesheet only the
 * difference. It knows nothing about MutationObserver.
 */
export class IncrementalAdaptationSession implements IncrementalAdaptation {
  readonly #doc: Document;
  readonly #stylesheet: StylesheetManager;
  readonly #analyzerOptions: Partial<AnalyzeDocumentOptions>;
  readonly #semantic: SemanticCueController | null;
  #context: PlanningContext | null = null;
  #memo: PlanningMemo = new Map();
  #kinds = new Map<string, TrackedKind>();
  #counts: OutcomeCounts = createOutcomeCounts();
  /** What is known about each tracked inline SVG: data only, never a node. */
  #svg = new Map<string, Pick<SvgUnitInfo, 'unsupportedReason' | 'paintServer'>>();

  constructor(
    doc: Document,
    stylesheet: StylesheetManager,
    analyzerOptions: Partial<AnalyzeDocumentOptions>,
    semantic: SemanticCueController | null = null,
  ) {
    this.#doc = doc;
    this.#stylesheet = stylesheet;
    this.#analyzerOptions = analyzerOptions;
    this.#semantic = semantic;
  }

  get active(): boolean {
    return this.#context !== null;
  }

  get ruleCount(): number {
    return this.#stylesheet.ruleCount;
  }

  get styleElement(): HTMLStyleElement | null {
    return this.#stylesheet.styleElement;
  }

  get hasInjectedContent(): boolean {
    return this.#stylesheet.hasContent;
  }

  semanticDiagnostics(): SemanticDiagnostics {
    return this.#semantic?.diagnostics() ?? EMPTY_SEMANTIC_DIAGNOSTICS;
  }

  /** Starts (or restarts) tracking from a full adaptation's per-element outcomes. */
  begin(
    settings: UserSettings,
    outcomes: ReadonlyMap<string, ElementOutcome>,
    notApplied: ReadonlySet<string>,
    elements: readonly ElementDescriptor[] = [],
  ): void {
    this.#context = createPlanningContext(settings);
    this.#memo = new Map();
    this.#kinds = new Map();
    this.#svg = new Map();
    this.#counts = createOutcomeCounts();
    for (const [id, outcome] of outcomes) {
      this.#track(id, notApplied.has(id) ? 'notApplied' : outcome.kind);
    }
    for (const element of elements) this.#trackSvg(element);
    // The cue layer reads the same settled page: after the colors, with the same lifetime.
    if (this.#semantic) {
      this.#semantic.begin(settings);
      this.#semantic.scanDocument();
    }
  }

  /** Stops tracking and forgets everything (adaptation switched off). */
  end(): void {
    this.#semantic?.end();
    this.#context = null;
    this.#memo = new Map();
    this.#kinds = new Map();
    this.#svg = new Map();
    this.#counts = createOutcomeCounts();
  }

  summary(): AdaptationSummary {
    return toSummary(this.#counts);
  }

  trackedCount(): number {
    return this.#kinds.size;
  }

  svgDiagnostics(): SvgDiagnostics {
    let svgAdapted = 0;
    let svgUnsupported = 0;
    let svgNotApplied = 0;
    let svgPaintServers = 0;
    for (const [id, info] of this.#svg) {
      const kind = this.#kinds.get(id);
      if (kind === 'adapted') svgAdapted += 1;
      if (kind === 'notApplied') svgNotApplied += 1;
      if (info.unsupportedReason) svgUnsupported += 1;
      if (info.paintServer) svgPaintServers += 1;
    }
    return {
      svgAnalyzed: this.#svg.size,
      svgAdapted,
      svgUnsupported,
      svgNotApplied,
      svgPaintServers,
    };
  }

  repairStylesheet(): boolean {
    if (!this.active || !this.#stylesheet.isDetached()) return false;
    this.#stylesheet.reattach();
    return true;
  }

  updatePeers(seeds: readonly PeerSeed[]): void {
    if (this.#context) this.#semantic?.update([], seeds);
  }

  update(input: IncrementalPassInput): IncrementalPassResult {
    const context = this.#context;
    if (!context) return EMPTY_RESULT;

    const removals = new Set<string>();
    for (const id of input.removedIds) {
      this.#untrack(id);
      if (this.#stylesheet.has(id)) removals.add(id);
    }

    const getStyle = this.#analyzerOptions.getStyle ?? ((el: Element) => getComputedStyle(el));
    // Analysis must see the page's own colors, never our adaptation (docs/ADAPTATION_ENGINE.md).
    const { sub, unsafe } = this.#stylesheet.withOriginalStyles(() => {
      const analysis = analyzeSubtrees(input.roots, this.#analyzerOptions);
      return {
        sub: analysis,
        unsafe: findNotAdaptable(
          this.#doc,
          analysis.elements.filter((element) => element.analysisStatus === 'resolved'),
          getStyle,
          analysis.nodes,
        ),
      };
    });

    // Only a root that alone exceeds the element budget is cut short; it is consumed (its
    // tail is reported as truncated) rather than retried forever. Roots that merely did not
    // fit next to others were left whole and are re-queued (analyzeSubtrees).
    const rootsConsumed = Math.min(
      input.roots.length,
      sub.truncated ? sub.rootsCompleted + 1 : sub.rootsCompleted,
    );

    // Elements tracked in a fully re-analyzed region that did not qualify this time
    // (hidden, text gone, no longer a candidate) lose their adaptation.
    const analyzedIds = new Set(sub.nodes.keys());
    for (const root of input.roots.slice(0, sub.rootsCompleted)) {
      for (const id of collectOwnedIds(root.element, root.scope)) {
        if (analyzedIds.has(id) || !this.#kinds.has(id)) continue;
        this.#untrack(id);
        if (this.#stylesheet.has(id)) removals.add(id);
      }
    }

    const upserts: AdaptationChange[] = [];
    let unresolved = 0;
    for (const element of sub.elements) {
      const outcome = planElement(
        unsafe.has(element.id) ? { ...element, analysisStatus: 'partial' } : element,
        context,
        this.#memo,
      );
      this.#track(element.id, outcome.kind);
      this.#trackSvg(element);
      if (outcome.kind === 'unresolved') unresolved += 1;
      if (outcome.kind === 'adapted') {
        upserts.push(...outcome.changes);
        removals.delete(element.id);
      } else if (this.#stylesheet.has(element.id)) {
        removals.add(element.id);
      }
    }
    if (this.#memo.size > MAX_MEMO_ENTRIES) this.#memo = new Map();

    const previous = new Map(
      upserts.map((change) => [
        ruleKey(change),
        this.#stylesheet.ruleFor(change.elementId, change.property),
      ]),
    );
    const result = this.#stylesheet.applyDelta(
      { upsert: upserts, remove: [...removals] },
      sub.nodes,
    );
    for (const change of result.notApplied) this.#track(owner(change), 'notApplied');

    const dropped = new Set(result.notApplied.map(owner));
    // A rule the browser refused to honor is gone again, even if an earlier value had one.
    for (const change of upserts) {
      if (dropped.has(owner(change)) && previous.get(ruleKey(change))) removals.add(owner(change));
    }
    const added: AdaptationChange[] = [];
    const updated: AdaptationChange[] = [];
    for (const change of upserts) {
      if (dropped.has(owner(change))) continue;
      const before = previous.get(ruleKey(change));
      if (!before) added.push(change);
      else if (before.adaptedValue !== change.adaptedValue) updated.push(change);
    }

    // Semantics follow the same regions M4 chose; the cue layer has no observer and no scan of its own.
    this.#semantic?.update(input.roots.slice(0, rootsConsumed), input.peerSeeds ?? []);

    return {
      rootsConsumed,
      elementsProcessed: sub.candidatesInspected,
      truncated: sub.truncated,
      delta: {
        added,
        updated,
        removed: [...removals],
        notApplied: result.notApplied,
        unresolved,
      },
      rules: {
        added: added.length,
        updated: updated.length,
        removed: removals.size + result.pruned,
      },
    };
  }

  #track(id: string, kind: TrackedKind): void {
    const before = this.#kinds.get(id);
    if (before === kind) return;
    if (before) this.#counts[before] -= 1;
    this.#kinds.set(id, kind);
    this.#counts[kind] += 1;
  }

  #trackSvg(element: ElementDescriptor): void {
    const info = element.svg;
    if (!info) return;
    this.#svg.set(element.id, {
      unsupportedReason: info.unsupportedReason,
      paintServer: info.paintServer,
    });
  }

  #untrack(id: string): void {
    this.#svg.delete(id);
    const before = this.#kinds.get(id);
    if (!before) return;
    this.#counts[before] -= 1;
    this.#kinds.delete(id);
  }
}
