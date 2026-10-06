import { describe, expect, it } from 'vitest';
import {
  DisabledProvider,
  MockSemanticProvider,
  SemanticAssistEngine,
  SemanticCache,
  entryOf,
  SEMANTIC_LIMITS,
  type AssistItem,
  type AssistOutcome,
  type ProviderRequest,
  type ProviderResult,
  type SemanticProvider,
  type SemanticQuery,
} from '@core/semantic-ai';
import { ACTIVE_TAB, answer, bound, supporters } from './kit';

/** An answer that is right for the packet in the request. */
function rightAnswer(request: ProviderRequest): string {
  const query = JSON.parse(request.payload) as SemanticQuery;
  const label = query.allowedLabels.find((l) => supporters(query, l).length >= 2) ?? 'unknown';
  return label === 'unknown'
    ? JSON.stringify({
        schemaVersion: 1,
        outcome: 'AMBIGUOUS',
        label,
        confidence: 0.1,
        evidenceRefs: [],
      })
    : answer(label, 0.9, supporters(query, label));
}

const item = (id: string, name = 'Home', priority = 1): AssistItem => ({
  id,
  bound: bound({ ...ACTIVE_TAB, accessibleName: name }),
  priority,
});

const collect = () => {
  const outcomes: AssistOutcome[] = [];
  return {
    outcomes,
    hooks: {
      isCurrent: () => true,
      onResult: (o: AssistOutcome) => outcomes.push(o),
    },
  };
};

describe('SemanticAssistEngine: no AI where none is needed', () => {
  it('makes zero calls for nothing eligible', async () => {
    const provider = new MockSemanticProvider({ respond: rightAnswer });
    const engine = new SemanticAssistEngine(provider);
    const { hooks } = collect();
    const summary = await engine.run([], hooks);
    expect(provider.calls).toBe(0);
    expect(summary.coverage).toBe('completed');
  });

  it('makes zero calls with the disabled provider', async () => {
    const engine = new SemanticAssistEngine(new DisabledProvider());
    const { hooks, outcomes } = collect();
    const summary = await engine.run([item('a')], hooks);
    expect(summary.coverage).toBe('disabled');
    expect(outcomes).toHaveLength(0);
    expect(summary.notQueued).toEqual(['a']);
  });
});

describe('SemanticAssistEngine: pipeline', () => {
  it('accepts a corroborated answer and keeps the case advisory', async () => {
    const provider = new MockSemanticProvider({ respond: rightAnswer });
    const engine = new SemanticAssistEngine(provider);
    const { hooks, outcomes } = collect();
    const summary = await engine.run([item('a')], hooks);
    expect(outcomes[0]?.interpreted.validatorStatus).toBe('ACCEPTED_ADVISORY');
    expect(summary.stats).toMatchObject({ eligible: 1, queried: 1, accepted: 1 });
    expect(summary.coverage).toBe('completed');
  });

  it('sends identical packets once and answers every item', async () => {
    const provider = new MockSemanticProvider({ respond: rightAnswer });
    const engine = new SemanticAssistEngine(provider);
    const { hooks, outcomes } = collect();
    const items = Array.from({ length: 100 }, (_, i) => item(`f${i}`));
    const summary = await engine.run(items, hooks);
    expect(provider.calls).toBe(1);
    expect(outcomes).toHaveLength(100);
    expect(new Set(outcomes.map((o) => o.interpreted.validatorStatus))).toEqual(
      new Set(['ACCEPTED_ADVISORY']),
    );
    expect(summary.stats.deduped).toBe(99);
  });

  it('answers a repeated run from the cache without a request', async () => {
    const provider = new MockSemanticProvider({ respond: rightAnswer });
    const engine = new SemanticAssistEngine(provider);
    await engine.run([item('a')], collect().hooks);
    const second = collect();
    const summary = await engine.run([item('a')], second.hooks);
    expect(provider.calls).toBe(1);
    expect(second.outcomes[0]?.cached).toBe(true);
    expect(summary.stats.cacheHits).toBe(1);
    expect(engine.diagnostics().semanticCacheHits).toBe(1);
  });

  it('does not cache failures, so a runtime that comes back is used', async () => {
    let up = false;
    const provider = new MockSemanticProvider({
      respond: (request) => {
        if (!up) throw new Error('down');
        return rightAnswer(request);
      },
    });
    const engine = new SemanticAssistEngine(provider);
    const first = collect();
    await engine.run([item('a')], first.hooks);
    expect(first.outcomes[0]?.interpreted.modelStatus).toBe('MODEL_ERROR');
    up = true;
    const second = collect();
    await engine.run([item('a')], second.hooks);
    expect(second.outcomes[0]?.interpreted.validatorStatus).toBe('ACCEPTED_ADVISORY');
    expect(provider.calls).toBe(2);
  });

  it('keys the cache on the provider identity', async () => {
    const cache = new SemanticCache();
    const a = new MockSemanticProvider({ respond: rightAnswer, model: 'one' });
    const b = new MockSemanticProvider({ respond: rightAnswer, model: 'two' });
    await new SemanticAssistEngine(a, { cache }).run([item('x')], collect().hooks);
    await new SemanticAssistEngine(b, { cache }).run([item('x')], collect().hooks);
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
  });
});

describe('SemanticAssistEngine: bounds', () => {
  it('caps requests per run, takes the most valuable first and leaves the rest manual review', async () => {
    const provider = new MockSemanticProvider({ respond: rightAnswer });
    const engine = new SemanticAssistEngine(provider, { queriesPerRun: 5 });
    const { hooks, outcomes } = collect();
    const items = Array.from({ length: 20 }, (_, i) => item(`f${i}`, `Tab ${i}`, i));
    const summary = await engine.run(items, hooks);
    expect(provider.calls).toBe(5);
    expect(outcomes.map((o) => o.id).sort()).toEqual(['f15', 'f16', 'f17', 'f18', 'f19']);
    expect(summary.notQueued).toHaveLength(15);
    expect(summary.coverage).toBe('partial');
    expect(engine.diagnostics().semanticOverBudget).toBe(15);
    expect(engine.diagnostics().semanticQueued).toBe(0);
  });

  it('holds 500 instances of 100 packets to bounded requests, bounded concurrency and an empty queue', async () => {
    let inFlight = 0;
    let peak = 0;
    const provider = new MockSemanticProvider({
      respond: rightAnswer,
      delay: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
      },
    });
    const engine = new SemanticAssistEngine(provider);
    const items = Array.from({ length: 500 }, (_, i) => item(`f${i}`, `Group ${i % 100}`));
    const { hooks, outcomes } = collect();
    const summary = await engine.run(items, hooks);
    expect(provider.calls).toBe(SEMANTIC_LIMITS.queriesPerRun);
    expect(peak).toBeLessThanOrEqual(SEMANTIC_LIMITS.concurrency);
    expect(engine.diagnostics().semanticMaxConcurrent).toBeLessThanOrEqual(
      SEMANTIC_LIMITS.concurrency,
    );
    expect(outcomes.length + summary.notQueued.length).toBe(500);
    expect(summary.stats.deduped).toBe(4 * SEMANTIC_LIMITS.queriesPerRun);
    expect(summary.notQueued).toHaveLength(5 * (100 - SEMANTIC_LIMITS.queriesPerRun));
    const gauges = engine.diagnostics();
    expect(gauges.semanticActive).toBe(0);
    expect(gauges.semanticQueued).toBe(0);
  });

  it('stops asking an unreachable runtime and leaves the rest manual review', async () => {
    const provider = new MockSemanticProvider({
      respond: () => {
        throw new Error('refused');
      },
    });
    // The mock reports a thrown responder as `bad-response`; an unreachable runtime is `unavailable`.
    const unreachable = {
      id: 'mock' as const,
      identity: () => provider.identity(),
      health: () => provider.health(),
      calls: 0,
      infer() {
        this.calls += 1;
        return Promise.resolve({ ok: false as const, failure: 'unavailable' as const });
      },
    };
    const engine = new SemanticAssistEngine(unreachable);
    const { hooks } = collect();
    const items = Array.from({ length: 30 }, (_, i) => item(`f${i}`, `Tab ${i}`));
    const summary = await engine.run(items, hooks);
    expect(unreachable.calls).toBeLessThanOrEqual(SEMANTIC_LIMITS.concurrency + 2);
    expect(summary.coverage).toBe('unavailable');
    expect(summary.notQueued.length).toBeGreaterThan(20);
  });
});

describe('SemanticAssistEngine: an unavailable runtime', () => {
  it('is reported as unavailable even when it was asked only once, and says nothing about the finding', async () => {
    const provider = new MockSemanticProvider({ respond: rightAnswer });
    const unreachable: SemanticProvider = {
      id: 'mock',
      identity: () => provider.identity(),
      health: () => provider.health(),
      infer: () => Promise.resolve({ ok: false, failure: 'unavailable' }),
    };
    const engine = new SemanticAssistEngine(unreachable);
    const { hooks, outcomes } = collect();
    const summary = await engine.run([item('a')], hooks);
    expect(summary.coverage).toBe('unavailable');
    expect(outcomes[0]?.interpreted.modelStatus).toBe('MODEL_ERROR');
    expect(entryOf(outcomes[0]!, item('a').bound.query)).toBeNull();
  });

  it('keeps an answer that was refused as malformed, because a model did answer', async () => {
    const provider = new MockSemanticProvider({ respond: () => 'Sure, it is active!' });
    const engine = new SemanticAssistEngine(provider);
    const { hooks, outcomes } = collect();
    const summary = await engine.run([item('a')], hooks);
    expect(summary.coverage).toBe('completed');
    expect(entryOf(outcomes[0]!, item('a').bound.query)).toMatchObject({
      modelStatus: 'MODEL_ERROR',
      validatorStatus: 'REJECTED',
      validatorReason: 'not-json',
      hypothesis: null,
    });
  });
});

describe('SemanticAssistEngine: time and staleness', () => {
  it('resolves a slow runtime as unresolved, never as a page failure', async () => {
    const provider = new MockSemanticProvider({
      respond: rightAnswer,
      delay: (signal) =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve())),
    });
    const engine = new SemanticAssistEngine(provider, { timeoutMs: 25 });
    const { hooks, outcomes } = collect();
    const summary = await engine.run([item('a')], hooks);
    expect(outcomes[0]?.interpreted).toMatchObject({
      modelStatus: 'MODEL_ERROR',
      validatorStatus: 'UNRESOLVED',
      reason: 'timeout',
    });
    expect(summary.stats.timeouts).toBe(1);
    expect(engine.diagnostics().semanticActive).toBe(0);
  });

  it('is not held by a provider that ignores its signal: the timeout still resolves the case', async () => {
    const never: SemanticProvider = {
      id: 'mock',
      identity: () => ({ provider: 'mock', model: 'stubborn' }),
      health: () => Promise.resolve('AVAILABLE'),
      infer: () => new Promise<ProviderResult>(() => undefined),
    };
    const engine = new SemanticAssistEngine(never, { timeoutMs: 20 });
    const { hooks, outcomes } = collect();
    const summary = await engine.run([item('a')], hooks);
    expect(outcomes[0]?.interpreted.reason).toBe('timeout');
    expect(summary.stats.timeouts).toBe(1);
    expect(engine.diagnostics()).toMatchObject({ semanticActive: 0, semanticQueued: 0 });
  });

  it('discards the answer of a question that is no longer current', async () => {
    const provider = new MockSemanticProvider({ respond: rightAnswer });
    const engine = new SemanticAssistEngine(provider);
    let current = true;
    const outcomes: AssistOutcome[] = [];
    const run = engine.run([item('a')], {
      isCurrent: () => current,
      onResult: (o) => outcomes.push(o),
    });
    current = false; // the element was replaced while the model was thinking
    const summary = await run;
    expect(outcomes).toHaveLength(0);
    expect(summary.discarded).toBe(1);
    expect(summary.coverage).toBe('partial');
  });

  it('cancels requests in flight and ignores their late answers', async () => {
    let release: () => void = () => undefined;
    const provider = new MockSemanticProvider({
      respond: rightAnswer,
      delay: () => new Promise<void>((resolve) => (release = resolve)),
    });
    const engine = new SemanticAssistEngine(provider);
    const { hooks, outcomes } = collect();
    const run = engine.run([item('a'), item('b', 'Other')], hooks);
    await new Promise((r) => setTimeout(r, 5));
    expect(engine.diagnostics().semanticActive).toBe(2);
    engine.cancelAll();
    release();
    const summary = await run;
    expect(outcomes).toHaveLength(0);
    expect(summary.cancelled).toBe(true);
    expect(engine.diagnostics()).toMatchObject({ semanticActive: 0, semanticQueued: 0 });
  });

  it('cancels through the run’s own signal', async () => {
    const provider = new MockSemanticProvider({
      respond: rightAnswer,
      delay: (signal) =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve())),
    });
    const engine = new SemanticAssistEngine(provider);
    const controller = new AbortController();
    const { outcomes } = collect();
    const run = engine.run([item('a')], {
      signal: controller.signal,
      isCurrent: () => true,
      onResult: (o) => outcomes.push(o),
    });
    controller.abort();
    const summary = await run;
    expect(outcomes).toHaveLength(0);
    expect(summary.cancelled).toBe(true);
  });

  it('leaves nothing behind after 100 open/close cycles', async () => {
    const provider = new MockSemanticProvider({
      respond: rightAnswer,
      delay: (signal) =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve())),
    });
    const engine = new SemanticAssistEngine(provider);
    for (let i = 0; i < 100; i += 1) {
      const controller = new AbortController();
      const run = engine.run([item(`a${i}`, `T${i}`), item(`b${i}`, `U${i}`)], {
        signal: controller.signal,
        isCurrent: () => true,
        onResult: () => undefined,
      });
      controller.abort();
      await run;
    }
    expect(engine.diagnostics()).toMatchObject({ semanticActive: 0, semanticQueued: 0 });
  });
});

describe('SemanticCache', () => {
  const entry = {
    modelStatus: 'AMBIGUOUS' as const,
    validatorStatus: 'UNRESOLVED' as const,
    reason: 'model-ambiguous' as const,
    hypothesis: null,
    validation: null,
  };

  it('is bounded by entries and evicts the least recently used', () => {
    const cache = new SemanticCache(3, 1_000_000);
    for (const key of ['a', 'b', 'c']) cache.set(key, entry);
    cache.get('a');
    cache.set('d', entry);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.size).toBe(3);
  });

  it('is bounded by bytes', () => {
    const cache = new SemanticCache(1000, 600);
    for (let i = 0; i < 50; i += 1) cache.set(`k${i}`, entry);
    expect(cache.bytes).toBeLessThanOrEqual(600);
    expect(cache.size).toBeLessThan(50);
  });

  it('holds the documented caps by default', () => {
    const cache = new SemanticCache();
    for (let i = 0; i < SEMANTIC_LIMITS.cacheEntries + 50; i += 1) cache.set(`k${i}`, entry);
    expect(cache.size).toBe(SEMANTIC_LIMITS.cacheEntries);
  });
});
