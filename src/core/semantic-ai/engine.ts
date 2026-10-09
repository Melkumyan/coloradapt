import type { AssistCoverage, AssistStats } from '@core/audit';
import { SemanticCache, cacheKey } from './cache';
import { interpretProviderResult, type Interpreted } from './interpret';
import { buildProviderRequest } from './prompt';
import type { ProviderFailure, ProviderResult, SemanticProvider } from './provider';
import type { BoundQuery } from './query';
import { SEMANTIC_LIMITS, type SemanticTask } from './taxonomy';

/**
 * Runs a batch of packets through a provider under every bound the product promises
 * (docs/AI_SEMANTIC_ENGINE.md, "Engine"): a queue cap per run, identical packets sent once, at most
 * {@link SEMANTIC_LIMITS.concurrency} requests in flight, a timeout per request, a memory-only LRU
 * cache, no retry storm against an unavailable runtime, and no answer applied after the question
 * went stale (a new epoch, an aborted run, or the caller's `isCurrent` saying the target moved on).
 *
 * The engine never reads a page, never touches storage and never decides what an answer means:
 * that is {@link interpretProviderResult}.
 */

export interface AssistItem {
  /** What the caller binds the answer to (a finding id). */
  readonly id: string;
  readonly bound: BoundQuery;
  /** Higher goes first when the run's budget cannot cover everything. */
  readonly priority: number;
}

export interface AssistOutcome {
  readonly id: string;
  readonly task: SemanticTask;
  readonly inputHash: string;
  readonly interpreted: Interpreted;
  /** The answer came from the cache, not from a request of this run. */
  readonly cached: boolean;
  /** The model name the runtime reported for it, when it did. */
  readonly model: string | null;
}

export interface RunHooks {
  readonly signal?: AbortSignal;
  /** Whether the question still describes the page (generation, target identity, profile). */
  readonly isCurrent: (item: AssistItem) => boolean;
  readonly onResult: (outcome: AssistOutcome, item: AssistItem) => void;
}

export interface RunSummary {
  readonly coverage: AssistCoverage;
  readonly stats: AssistStats;
  /** Cases the run left alone (budget, or an unavailable runtime): they stay manual review. */
  readonly notQueued: readonly string[];
  /** Answers that arrived for a question that was no longer current. */
  readonly discarded: number;
  readonly cancelled: boolean;
}

/** Local counters, for tests and debugging. No telemetry. */
export interface SemanticAssistDiagnostics {
  readonly semanticEligible: number;
  readonly semanticQueries: number;
  readonly semanticDeduped: number;
  readonly semanticAccepted: number;
  readonly semanticRejected: number;
  readonly semanticUnresolved: number;
  readonly semanticErrors: number;
  readonly semanticTimeouts: number;
  readonly semanticCacheHits: number;
  readonly semanticCacheMisses: number;
  readonly semanticDiscarded: number;
  readonly semanticOverBudget: number;
  /** Gauges: requests in flight and packets waiting, right now. */
  readonly semanticActive: number;
  readonly semanticQueued: number;
  readonly semanticMaxConcurrent: number;
}

export interface EngineScheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface EngineOptions {
  readonly scheduler?: EngineScheduler;
  readonly timeoutMs?: number;
  readonly concurrency?: number;
  readonly queriesPerRun?: number;
  readonly cache?: SemanticCache;
}

const UNREACHABLE: ReadonlySet<ProviderFailure> = new Set([
  'unavailable',
  'blocked-endpoint',
  'not-configured',
  'consent-required',
]);
/** Two unreachable answers in a row end the run: the runtime is not there, and asking more is a storm. */
const UNREACHABLE_STREAK = 2;

export class SemanticAssistEngine {
  readonly #provider: SemanticProvider;
  readonly #cache: SemanticCache;
  readonly #scheduler: EngineScheduler;
  readonly #timeoutMs: number;
  readonly #concurrency: number;
  readonly #queriesPerRun: number;
  readonly #active = new Set<AbortController>();
  #epoch = 0;
  #queued = 0;
  #counters = {
    eligible: 0,
    queries: 0,
    deduped: 0,
    accepted: 0,
    rejected: 0,
    unresolved: 0,
    errors: 0,
    timeouts: 0,
    cacheHits: 0,
    cacheMisses: 0,
    discarded: 0,
    overBudget: 0,
    maxConcurrent: 0,
  };

  constructor(provider: SemanticProvider, options: EngineOptions = {}) {
    this.#provider = provider;
    this.#cache = options.cache ?? new SemanticCache();
    this.#scheduler = options.scheduler ?? {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.#timeoutMs = options.timeoutMs ?? SEMANTIC_LIMITS.timeoutMs;
    this.#concurrency = Math.max(1, options.concurrency ?? SEMANTIC_LIMITS.concurrency);
    this.#queriesPerRun = options.queriesPerRun ?? SEMANTIC_LIMITS.queriesPerRun;
  }

  get provider(): SemanticProvider {
    return this.#provider;
  }

  get cache(): SemanticCache {
    return this.#cache;
  }

  /** Aborts every request in flight and makes every run in progress discard what it still gets. */
  cancelAll(): void {
    this.#epoch += 1;
    for (const controller of this.#active) controller.abort();
  }

  diagnostics(): SemanticAssistDiagnostics {
    const c = this.#counters;
    return {
      semanticEligible: c.eligible,
      semanticQueries: c.queries,
      semanticDeduped: c.deduped,
      semanticAccepted: c.accepted,
      semanticRejected: c.rejected,
      semanticUnresolved: c.unresolved,
      semanticErrors: c.errors,
      semanticTimeouts: c.timeouts,
      semanticCacheHits: c.cacheHits,
      semanticCacheMisses: c.cacheMisses,
      semanticDiscarded: c.discarded,
      semanticOverBudget: c.overBudget,
      semanticActive: this.#active.size,
      semanticQueued: this.#queued,
      semanticMaxConcurrent: c.maxConcurrent,
    };
  }

  async run(items: readonly AssistItem[], hooks: RunHooks): Promise<RunSummary> {
    const stats = {
      eligible: items.length,
      queried: 0,
      deduped: 0,
      cacheHits: 0,
      accepted: 0,
      rejected: 0,
      unresolved: 0,
      modelErrors: 0,
      timeouts: 0,
      notQueued: 0,
    };
    this.#counters.eligible += items.length;
    const summary = (
      coverage: AssistCoverage,
      notQueued: string[],
      discarded: number,
      cancelled: boolean,
    ): RunSummary => ({
      coverage,
      stats,
      notQueued,
      discarded,
      cancelled,
    });
    if (this.#provider.id === 'disabled')
      return summary(
        'disabled',
        items.map((i) => i.id),
        0,
        false,
      );

    const epoch = this.#epoch;
    const stale = (): boolean => this.#epoch !== epoch || hooks.signal?.aborted === true;
    const identity = this.#provider.identity();
    const keyOf = (item: AssistItem): string =>
      cacheKey(identity.provider, identity.model, item.bound.query.task, item.bound.inputHash);

    // Most valuable first; the sort is stable, so equal priorities keep their order.
    const ordered = [...items].sort((a, b) => b.priority - a.priority);
    const groups = new Map<string, AssistItem[]>();
    const skipped = new Set<string>();
    const notQueued: string[] = [];
    for (const item of ordered) {
      const key = keyOf(item);
      const group = groups.get(key);
      if (group) {
        group.push(item);
        stats.deduped += 1;
        this.#counters.deduped += 1;
      } else if (skipped.has(key) || groups.size >= this.#queriesPerRun) {
        skipped.add(key);
        notQueued.push(item.id);
        this.#counters.overBudget += 1;
      } else {
        groups.set(key, [item]);
      }
    }

    let discarded = 0;
    const deliver = (
      key: string,
      interpreted: Interpreted,
      cached: boolean,
      model: string | null,
    ): void => {
      for (const item of groups.get(key) ?? []) {
        if (stale() || !hooks.isCurrent(item)) {
          discarded += 1;
          this.#counters.discarded += 1;
          continue;
        }
        const tally =
          interpreted.modelStatus === 'MODEL_ERROR'
            ? 'errors'
            : interpreted.validatorStatus === 'ACCEPTED_ADVISORY'
              ? 'accepted'
              : interpreted.validatorStatus === 'REJECTED'
                ? 'rejected'
                : 'unresolved';
        if (tally === 'errors') {
          stats.modelErrors += 1;
          this.#counters.errors += 1;
        } else {
          stats[tally] += 1;
          this.#counters[tally] += 1;
        }
        hooks.onResult(
          {
            id: item.id,
            task: item.bound.query.task,
            inputHash: item.bound.inputHash,
            interpreted,
            cached,
            model,
          },
          item,
        );
      }
    };

    const pending: { key: string; item: AssistItem }[] = [];
    for (const [key, group] of groups) {
      const first = group[0];
      if (!first) continue;
      const hit = this.#cache.get(key);
      if (hit) {
        stats.cacheHits += group.length;
        this.#counters.cacheHits += 1;
        deliver(key, hit, true, identity.model);
      } else {
        this.#counters.cacheMisses += 1;
        pending.push({ key, item: first });
      }
    }

    this.#queued += pending.length;
    let next = 0;
    let unreachable = 0;
    let providerFailures = 0;
    let answered = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (stale() || unreachable >= UNREACHABLE_STREAK) return;
        const index = next;
        next += 1;
        const job = pending[index];
        if (!job) return;
        this.#queued -= 1;
        // A question nobody is waiting for any more (its element left the page, its route or profile
        // changed) is not sent: only requests already in flight (at most the concurrency) can be wasted.
        const waiting = groups.get(job.key) ?? [];
        if (!waiting.some((item) => hooks.isCurrent(item))) {
          discarded += waiting.length;
          this.#counters.discarded += waiting.length;
          continue;
        }

        const controller = new AbortController();
        const forward = (): void => controller.abort();
        hooks.signal?.addEventListener('abort', forward, { once: true });
        let timedOut = false;
        const timer = this.#scheduler.setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, this.#timeoutMs);
        this.#active.add(controller);
        this.#counters.maxConcurrent = Math.max(this.#counters.maxConcurrent, this.#active.size);
        this.#counters.queries += 1;
        stats.queried += 1;
        let result: ProviderResult;
        try {
          // A provider that ignores its signal still cannot hold a run: the abort wins the race.
          const aborted = new Promise<ProviderResult>((resolve) => {
            const give = (): void => resolve({ ok: false, failure: 'aborted' });
            if (controller.signal.aborted) give();
            else controller.signal.addEventListener('abort', give, { once: true });
          });
          result = await Promise.race([
            this.#provider.infer(buildProviderRequest(job.item.bound.query), controller.signal),
            aborted,
          ]);
        } catch {
          result = { ok: false, failure: controller.signal.aborted ? 'aborted' : 'bad-response' };
        } finally {
          this.#scheduler.clearTimeout(timer);
          hooks.signal?.removeEventListener('abort', forward);
          this.#active.delete(controller);
        }
        if (stale()) continue;
        if (timedOut && !result.ok) {
          result = { ok: false, failure: 'timeout' };
          stats.timeouts += 1;
          this.#counters.timeouts += 1;
        }
        if (!result.ok) providerFailures += 1;
        if (!result.ok && UNREACHABLE.has(result.failure)) unreachable += 1;
        else unreachable = 0;
        const interpreted = interpretProviderResult(job.item.bound.query, result);
        // Only an answer that parsed is worth keeping: a failure says nothing about the packet.
        if (interpreted.modelStatus !== 'MODEL_ERROR') this.#cache.set(job.key, interpreted);
        if (result.ok) answered += 1;
        deliver(job.key, interpreted, false, result.ok ? result.model : null);
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(this.#concurrency, pending.length) }, () => worker()),
      );
    } finally {
      // Whatever was never taken (a cancelled run, an unreachable runtime) leaves the queue.
      this.#queued -= Math.max(0, pending.length - next);
    }

    const cancelled = stale();
    // Jobs nobody took: their cases stay manual review.
    for (const job of pending.slice(next)) {
      for (const item of groups.get(job.key) ?? []) notQueued.push(item.id);
    }
    stats.notQueued = notQueued.length;
    let coverage: AssistCoverage = 'completed';
    // No request got an answer: the runtime is not there, refused us, or was too slow. Nothing was reviewed.
    if (answered === 0 && providerFailures > 0) coverage = 'unavailable';
    else if (cancelled || notQueued.length > 0 || discarded > 0) coverage = 'partial';
    return summary(coverage, notQueued, discarded, cancelled);
  }
}
