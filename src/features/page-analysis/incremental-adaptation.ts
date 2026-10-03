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
  toSummary,
  type ElementOutcome,
  type OutcomeCounts,
  type PlanningContext,
  type PlanningMemo,
  type StylesheetManager,
} from '@core/adaptation';
import type {
  AdaptationChange,
  AdaptationDelta,
  AdaptationSummary,
  UserSettings,
} from '@domain/models';
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
  /** Elements the bookkeeping currently tracks (ids only; for leak tests and diagnostics). */
  trackedCount(): number;
  /** Re-analyzes `input.roots` and applies only the difference. */
  update(input: IncrementalPassInput): IncrementalPassResult;
  /** Re-attaches the sheet if the page removed it. */
  repairStylesheet(): boolean;
  /** The injected `<style>` element, if any (for mutation-ownership checks). */
  readonly styleElement: HTMLStyleElement | null;
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
  #context: PlanningContext | null = null;
  #memo: PlanningMemo = new Map();
  #kinds = new Map<string, TrackedKind>();
  #counts: OutcomeCounts = createOutcomeCounts();

  constructor(
    doc: Document,
    stylesheet: StylesheetManager,
    analyzerOptions: Partial<AnalyzeDocumentOptions>,
  ) {
    this.#doc = doc;
    this.#stylesheet = stylesheet;
    this.#analyzerOptions = analyzerOptions;
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

  /** Starts (or restarts) tracking from a full adaptation's per-element outcomes. */
  begin(
    settings: UserSettings,
    outcomes: ReadonlyMap<string, ElementOutcome>,
    notApplied: ReadonlySet<string>,
  ): void {
    this.#context = createPlanningContext(settings);
    this.#memo = new Map();
    this.#kinds = new Map();
    this.#counts = createOutcomeCounts();
    for (const [id, outcome] of outcomes) {
      this.#track(id, notApplied.has(id) ? 'notApplied' : outcome.kind);
    }
  }

  /** Stops tracking and forgets everything (adaptation switched off). */
  end(): void {
    this.#context = null;
    this.#memo = new Map();
    this.#kinds = new Map();
    this.#counts = createOutcomeCounts();
  }

  summary(): AdaptationSummary {
    return toSummary(this.#counts);
  }

  trackedCount(): number {
    return this.#kinds.size;
  }

  repairStylesheet(): boolean {
    if (!this.active || !this.#stylesheet.isDetached()) return false;
    this.#stylesheet.reattach();
    return true;
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
      if (outcome.kind === 'unresolved') unresolved += 1;
      if (outcome.kind === 'adapted') {
        upserts.push(outcome.change);
        removals.delete(element.id);
      } else if (this.#stylesheet.has(element.id)) {
        removals.add(element.id);
      }
    }
    if (this.#memo.size > MAX_MEMO_ENTRIES) this.#memo = new Map();

    const previous = new Map(
      upserts.map((change) => [change.elementId, this.#stylesheet.ruleFor(change.elementId)]),
    );
    const result = this.#stylesheet.applyDelta(
      { upsert: upserts, remove: [...removals] },
      sub.nodes,
    );
    for (const change of result.notApplied) this.#track(change.elementId, 'notApplied');

    const dropped = new Set(result.notApplied.map((change) => change.elementId));
    // A rule the browser refused to honor is gone again, even if an earlier value had one.
    for (const id of dropped) if (previous.get(id)) removals.add(id);
    const added: AdaptationChange[] = [];
    const updated: AdaptationChange[] = [];
    for (const change of upserts) {
      if (dropped.has(change.elementId)) continue;
      const before = previous.get(change.elementId);
      if (!before) added.push(change);
      else if (before.adaptedValue !== change.adaptedValue) updated.push(change);
    }

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
      rules: { added: added.length, updated: updated.length, removed: removals.size },
    };
  }

  #track(id: string, kind: TrackedKind): void {
    const before = this.#kinds.get(id);
    if (before === kind) return;
    if (before) this.#counts[before] -= 1;
    this.#kinds.set(id, kind);
    this.#counts[kind] += 1;
  }

  #untrack(id: string): void {
    const before = this.#kinds.get(id);
    if (!before) return;
    this.#counts[before] -= 1;
    this.#kinds.delete(id);
  }
}
