import { DYNAMIC_BUDGET, type DynamicBudget } from '@shared/constants';
import {
  EMPTY_CHART_DIAGNOSTICS,
  EMPTY_SEMANTIC_DIAGNOSTICS,
  EMPTY_SVG_DIAGNOSTICS,
  type DynamicDiagnostics,
  type FullRescanReason,
} from '@domain/models';
import type { AnalysisRoot } from '@core/analysis';
import type { IncrementalAdaptation } from '../page-analysis/incremental-adaptation';
import type { PeerSeed } from '../semantics';
import { collectRemovedIds, normalizeRoots, resolveAffectedRoots } from './affected-roots';
import { classifyMutations } from './mutation-classifier';
import { MutationBatcher, type MutationBatch } from './mutation-batcher';
import { DocumentMutationObserver, type ObserverFactory } from './mutation-observer';
import { isColorAdaptOwnedMutation, removesColorAdaptStyle } from './ownership';
import { createFrameScheduler, type Scheduler } from './scheduler';

export interface DynamicPipelineOptions {
  readonly doc: Document;
  readonly adaptation: IncrementalAdaptation;
  /** Runs the complete (M3) analysis + adaptation. The pipeline drains the mutations it causes. */
  readonly fullRescan: () => void;
  readonly scheduler?: Scheduler;
  /** Monotonic clock, used only to space out full rescans. */
  readonly now?: () => number;
  readonly budget?: Partial<DynamicBudget>;
  readonly createObserver?: ObserverFactory;
}

export interface DynamicPipeline {
  /** Starts observing. A no-op while already started or after `dispose`. */
  start(): void;
  /** Stops observing and forgets queued work. Safe to call repeatedly. */
  stop(): void;
  /** Requests a full rescan through the normal (batched) path. */
  refresh(): void;
  /**
   * Asks for `element` (and the semantic unit around it) to be re-examined, through the normal
   * batched path. For state that changes without a DOM mutation: native form validity.
   */
  invalidate(element: Element, source?: 'semantic' | 'chart'): void;
  /** `stop()`, and `start()` becomes a no-op. */
  dispose(): void;
  /** Drops queued mutations and any pending flush (a full adaptation is about to supersede them). */
  discardPending(): void;
  /** Discards the records ColorAdapt's own writes just produced; keeps real ones queued. */
  drainOwnMutations(): void;
  /**
   * Processes everything pending right now, synchronously, until nothing is
   * left (also bypassing the full-rescan throttle). Tests and the debug
   * channel use this instead of waiting for the scheduler.
   */
  flush(): DynamicDiagnostics;
  diagnostics(): DynamicDiagnostics;
  readonly running: boolean;
}

type Counters = {
  -readonly [K in keyof DynamicDiagnostics]: K extends 'fullRescansByReason'
    ? Partial<Record<FullRescanReason, number>>
    : DynamicDiagnostics[K];
};

function emptyCounters(): Counters {
  return {
    mutationRecords: 0,
    batches: 0,
    incrementalPasses: 0,
    fullRescans: 0,
    fullRescansByReason: {},
    affectedRoots: 0,
    elementsProcessed: 0,
    selfMutationsIgnored: 0,
    irrelevantMutations: 0,
    rulesAdded: 0,
    rulesUpdated: 0,
    rulesRemoved: 0,
    queueOverflows: 0,
    rootsDeferred: 0,
    truncatedPasses: 0,
    stylesheetRepairs: 0,
    stylesheetRepairsDeferred: 0,
    observerStarts: 0,
    fullRescansThrottled: 0,
    state: 'STOPPED',
    trackedElements: 0,
    rules: 0,
    observerCallbacks: 0,
    pendingLinks: 0,
    queuedRecords: 0,
    deferredRoots: 0,
    pendingRescan: null,
    throttleTimerActive: false,
    svg: EMPTY_SVG_DIAGNOSTICS,
    semantic: EMPTY_SEMANTIC_DIAGNOSTICS,
    charts: EMPTY_CHART_DIAGNOSTICS,
    semanticInvalidations: 0,
  };
}

/**
 * The dynamic-site pipeline (docs/DYNAMIC_ANALYSIS.md):
 *
 * ```
 * MutationObserver -> (own-mutation filter) -> MutationBatcher
 *   -> classify -> affected roots -> incremental update -> stylesheet delta
 * ```
 *
 * It knows nothing about colors; it decides *what* to re-analyze and *when*,
 * and hands regions to {@link IncrementalAdaptation}. A full rescan is the
 * explicit, observable fallback for what no bounded region can describe.
 */
export function createDynamicPipeline(options: DynamicPipelineOptions): DynamicPipeline {
  const { doc, adaptation } = options;
  const budget = { ...DYNAMIC_BUDGET, ...options.budget };
  const scheduler = options.scheduler ?? createFrameScheduler(doc.defaultView ?? window);
  const now = options.now ?? (() => performance.now());

  const counters = emptyCounters();
  let disposed = false;
  let deferredRoots: AnalysisRoot[] = [];
  let pendingFullRescan: FullRescanReason | null = null;
  let forcing = false;
  let lastFullRescanAt: number | null = null;
  let cancelThrottle: (() => void) | null = null;
  let repairOwed = false;
  /** Elements named by `invalidate` (native form events) since the last batch. */
  const invalidated = new Set<Element>();
  let lastRepairAt: number | null = null;
  let cancelRepairTimer: (() => void) | null = null;
  const pendingLinks = new Map<HTMLLinkElement, () => void>();

  const observer = new DocumentMutationObserver(doc, onRecords, options.createObserver);
  const batcher = new MutationBatcher({
    scheduler,
    maxQueuedRecords: budget.maxQueuedRecords,
    onFlush: process,
  });

  /** Observer callback: own records are counted and dropped; the rest are queued. */
  function onRecords(records: readonly MutationRecord[]): void {
    counters.observerCallbacks += 1;
    const real = ingest(records);
    if (real.length > 0) batcher.enqueue(real);
  }

  /** Splits off ColorAdapt's own records (counting them). Removal of our `<style>` stays: it needs repair. */
  function ingest(records: readonly MutationRecord[]): MutationRecord[] {
    const real: MutationRecord[] = [];
    counters.mutationRecords += records.length;
    for (const record of records) {
      // Our <style> disappearing while rules still exist was not our doing: it needs repair.
      // With no rules left, the removal is our own restore() and there is nothing to do.
      const needsRepair = removesColorAdaptStyle(record) && adaptation.hasInjectedContent;
      if (isColorAdaptOwnedMutation(record) && !needsRepair) {
        counters.selfMutationsIgnored += 1;
      } else {
        real.push(record);
      }
    }
    return real;
  }

  function watchLink(link: HTMLLinkElement): void {
    if (pendingLinks.has(link) || !link.isConnected) return;
    const done = () => {
      link.removeEventListener('load', done);
      link.removeEventListener('error', done);
      pendingLinks.delete(link);
      if (!observer.connected) return;
      pendingFullRescan ??= 'stylesheet';
      batcher.request();
    };
    link.addEventListener('load', done);
    link.addEventListener('error', done);
    pendingLinks.set(link, done);
  }

  /**
   * Stops waiting for links that left the document, or were disabled, before loading
   * (no strong refs to removed nodes; a disabled link fetches nothing).
   */
  function pruneLinks(): void {
    for (const [link, handler] of pendingLinks) {
      if (link.isConnected && !link.hasAttribute('disabled')) continue;
      link.removeEventListener('load', handler);
      link.removeEventListener('error', handler);
      pendingLinks.delete(link);
    }
  }

  function unwatchLinks(): void {
    for (const [link, handler] of pendingLinks) {
      link.removeEventListener('load', handler);
      link.removeEventListener('error', handler);
    }
    pendingLinks.clear();
  }

  /**
   * Puts our `<style>` back after the page removed it. Spaced out: a page that
   * deletes it again every time would otherwise make this run every frame
   * forever. The first repair is immediate, later ones wait out the interval
   * (one timer, never dropped; a forced flush skips the wait).
   */
  function repairStylesheetIfOwed(): void {
    if (!repairOwed) return;
    if (!forcing && lastRepairAt !== null) {
      const remaining = budget.stylesheetRepairMinIntervalMs - (now() - lastRepairAt);
      if (remaining > 0) {
        if (cancelRepairTimer === null) {
          counters.stylesheetRepairsDeferred += 1;
          cancelRepairTimer = scheduler.scheduleAfter(remaining, () => {
            cancelRepairTimer = null;
            batcher.request();
          });
        }
        return;
      }
    }
    repairOwed = false;
    cancelRepairTimer?.();
    cancelRepairTimer = null;
    if (adaptation.repairStylesheet()) {
      counters.stylesheetRepairs += 1;
      lastRepairAt = now();
    }
  }

  function performFullRescan(reason: FullRescanReason): void {
    options.fullRescan();
    repairOwed = false; // the rescan re-creates the sheet if it was missing
    counters.fullRescans += 1;
    counters.fullRescansByReason[reason] = (counters.fullRescansByReason[reason] ?? 0) + 1;
    lastFullRescanAt = now();
    pendingFullRescan = null;
    deferredRoots = [];
    drainOwnMutations();
  }

  /** True (and a retry is scheduled) if a full rescan must wait out the throttle. */
  function throttleFullRescan(reason: FullRescanReason): boolean {
    if (forcing || reason === 'manual' || lastFullRescanAt === null) return false;
    const remaining = budget.fullRescanMinIntervalMs - (now() - lastFullRescanAt);
    if (remaining <= 0) return false;
    counters.fullRescansThrottled += 1;
    cancelThrottle?.();
    cancelThrottle = scheduler.scheduleAfter(remaining, () => {
      cancelThrottle = null;
      batcher.request();
    });
    return true;
  }

  function process(batch: MutationBatch): void {
    const records = [...batch.records, ...ingest(observer.takeRecords())];
    pruneLinks();
    if (batch.overflowed) {
      counters.queueOverflows += 1;
      pendingFullRescan ??= 'queue-overflow';
    }
    const hadWork =
      records.length > 0 ||
      deferredRoots.length > 0 ||
      pendingFullRescan !== null ||
      repairOwed ||
      invalidated.size > 0;
    if (hadWork) counters.batches += 1;

    let resolvedRemoved: readonly Element[] = [];
    let resolvedRoots: readonly AnalysisRoot[] = [];
    let resolvedSeeds: readonly PeerSeed[] = [];
    let resolvedDepartures: readonly Element[] = [];
    if (records.length > 0) {
      const { mutations, counts } = classifyMutations(records, { doc });
      counters.selfMutationsIgnored += counts.COLORADAPT_INTERNAL;
      counters.irrelevantMutations += counts.IRRELEVANT;

      if (mutations.some((m) => m.kind === 'COLORADAPT_INTERNAL' && m.stylesheetRemoved)) {
        repairOwed = true;
      }

      // A stylesheet that has not loaded yet changes nothing until it does.
      const effective = mutations.filter((m) => {
        if (m.kind === 'STYLESHEET_CHANGE' && m.pendingLink) {
          watchLink(m.pendingLink);
          return false;
        }
        return true;
      });
      const resolved = resolveAffectedRoots(effective, {
        doc,
        maxRoots: budget.maxAffectedRoots,
      });
      if (resolved.fullRescan) pendingFullRescan ??= resolved.fullRescan;
      resolvedRemoved = resolved.removed;
      resolvedRoots = resolved.roots;
      resolvedSeeds = resolved.peerSeeds;
      resolvedDepartures = resolved.departures;
    }

    if (!adaptation.active) {
      // Adaptation was switched off underneath us: nothing to maintain.
      invalidated.clear();
      deferredRoots = [];
      pendingFullRescan = null;
      repairOwed = false;
      return;
    }
    repairStylesheetIfOwed();

    const roots = normalizeRoots([...deferredRoots, ...resolvedRoots, ...takeInvalidated()]);
    if (!pendingFullRescan && roots.length > budget.maxAffectedRoots) {
      pendingFullRescan = 'too-many-roots';
    }

    if (pendingFullRescan) {
      if (throttleFullRescan(pendingFullRescan)) return;
      performFullRescan(pendingFullRescan);
      return;
    }

    const removedIds = collectRemovedIds(resolvedRemoved);
    if (roots.length === 0 && removedIds.length === 0) {
      // Nodes left and none held a color rule: only the semantic layer has anything to do (their peers).
      if (resolvedSeeds.length > 0 || resolvedDepartures.length > 0) {
        adaptation.updatePeers(resolvedSeeds, resolvedDepartures);
        drainOwnMutations();
      }
      return;
    }

    const result = adaptation.update({
      roots,
      removedIds,
      peerSeeds: resolvedSeeds,
      departures: resolvedDepartures,
    });
    counters.incrementalPasses += 1;
    counters.affectedRoots += result.rootsConsumed;
    counters.elementsProcessed += result.elementsProcessed;
    counters.rulesAdded += result.rules.added;
    counters.rulesUpdated += result.rules.updated;
    counters.rulesRemoved += result.rules.removed;
    if (result.truncated) counters.truncatedPasses += 1;

    deferredRoots = roots.slice(result.rootsConsumed);
    if (deferredRoots.length > 0) {
      counters.rootsDeferred += deferredRoots.length;
      batcher.request();
    }
    drainOwnMutations();
  }

  /** The regions named by `invalidate` that are still live page content. */
  function takeInvalidated(): AnalysisRoot[] {
    const roots: AnalysisRoot[] = [];
    for (const element of invalidated) {
      if (element.isConnected && doc.body?.contains(element))
        roots.push({ element, scope: 'self' });
    }
    invalidated.clear();
    return roots;
  }

  function drainOwnMutations(): void {
    if (!observer.connected) return;
    const leftover = observer.takeRecords();
    if (leftover.length === 0) return;
    const real = ingest(leftover);
    if (real.length > 0) batcher.enqueue(real);
  }

  function stop(): void {
    observer.stop();
    batcher.stop();
    cancelThrottle?.();
    cancelThrottle = null;
    cancelRepairTimer?.();
    cancelRepairTimer = null;
    repairOwed = false;
    invalidated.clear();
    unwatchLinks();
    deferredRoots = [];
    pendingFullRescan = null;
  }

  function snapshot(): DynamicDiagnostics {
    return {
      ...counters,
      fullRescansByReason: { ...counters.fullRescansByReason },
      observerStarts: observer.starts,
      queueOverflows: counters.queueOverflows,
      state: batcher.state,
      trackedElements: adaptation.trackedCount(),
      rules: adaptation.ruleCount,
      pendingLinks: pendingLinks.size,
      queuedRecords: batcher.queued,
      deferredRoots: deferredRoots.length,
      pendingRescan: pendingFullRescan,
      throttleTimerActive: cancelThrottle !== null || cancelRepairTimer !== null,
      svg: adaptation.svgDiagnostics(),
      semantic: adaptation.semanticDiagnostics(),
      charts: adaptation.chartDiagnostics(),
    };
  }

  return {
    get running() {
      return observer.connected;
    },

    start() {
      if (disposed || observer.connected) return;
      batcher.start();
      observer.start();
    },

    stop,

    refresh() {
      if (!observer.connected) return;
      pendingFullRescan ??= 'manual';
      batcher.request();
    },

    invalidate(element, source = 'semantic') {
      if (!observer.connected || !adaptation.active) return;
      invalidated.add(element);
      if (source === 'semantic') counters.semanticInvalidations += 1;
      batcher.request();
    },

    dispose() {
      stop();
      disposed = true;
    },

    discardPending() {
      if (!observer.connected) return;
      observer.takeRecords();
      batcher.discard();
      cancelThrottle?.();
      cancelThrottle = null;
      cancelRepairTimer?.();
      cancelRepairTimer = null;
      repairOwed = false;
      invalidated.clear();
      deferredRoots = [];
      pendingFullRescan = null;
    },

    drainOwnMutations,

    flush() {
      if (!observer.connected) return snapshot();
      forcing = true;
      try {
        for (let pass = 0; pass < budget.maxPassesPerFlush; pass += 1) {
          batcher.flush();
          if (
            deferredRoots.length === 0 &&
            pendingFullRescan === null &&
            batcher.queued === 0 &&
            invalidated.size === 0
          ) {
            break;
          }
        }
      } finally {
        forcing = false;
      }
      observer.syncRoots();
      return snapshot();
    },

    diagnostics: snapshot,
  };
}
