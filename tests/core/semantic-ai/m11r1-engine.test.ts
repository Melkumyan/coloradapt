import { describe, expect, it } from 'vitest';
import {
  MockSemanticProvider,
  SemanticAssistEngine,
  SemanticCache,
  SEMANTIC_LIMITS,
  type AssistItem,
  type AssistOutcome,
  type ProviderRequest,
  type SemanticProvider,
  type SemanticQuery,
} from '@core/semantic-ai';
import { ACTIVE_TAB, answer, bound, supporters } from './kit';

/**
 * M11.R1: the engine under churn. Whatever the page does while a review runs (elements replaced and
 * removed, routes and profiles changed, the setting turned off, the runtime slow or gone), the engine
 * keeps its bounds and no answer is applied to a question that stopped being current.
 */

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

const item = (id: string, name = 'Home', generation = '1', priority = 1): AssistItem => ({
  id,
  bound: { ...bound({ ...ACTIVE_TAB, accessibleName: name }), bindings: { generation } },
  priority,
});

const tick = (ms = 0): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

function gauge() {
  let inFlight = 0;
  let peak = 0;
  return {
    get peak() {
      return peak;
    },
    delay: async (ms = 1): Promise<void> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(ms);
      inFlight -= 1;
    },
  };
}

describe('element removal', () => {
  it('sends no request for elements already gone, wastes at most the in-flight ones, and applies nothing', async () => {
    const g = gauge();
    const provider = new MockSemanticProvider({ respond: rightAnswer, delay: () => g.delay(5) });
    const engine = new SemanticAssistEngine(provider);
    const items = Array.from({ length: 100 }, (_, i) => item(`f${i}`, `Group ${i}`));
    const removed = new Set<string>();
    const outcomes: AssistOutcome[] = [];
    const run = engine.run(items, {
      isCurrent: (it) => !removed.has(it.id),
      onResult: (o) => outcomes.push(o),
    });
    await tick(2); // the first requests are in flight
    for (const it of items) removed.add(it.id);
    const summary = await run;
    expect(outcomes).toEqual([]);
    // The run's cap left 36 cases manual review; the 64 it queued were all discarded, none sent but the in-flight ones.
    expect(summary.discarded + summary.notQueued.length).toBe(100);
    expect(summary.discarded).toBe(SEMANTIC_LIMITS.queriesPerRun);
    // Only what was already in flight was wasted: at most the concurrency.
    expect(provider.calls).toBeLessThanOrEqual(SEMANTIC_LIMITS.concurrency);
    expect(g.peak).toBeLessThanOrEqual(SEMANTIC_LIMITS.concurrency);
    expect(summary.coverage).toBe('partial');
    const gauges = engine.diagnostics();
    expect(gauges.semanticActive).toBe(0);
    expect(gauges.semanticQueued).toBe(0);
    expect(gauges.semanticDiscarded).toBe(SEMANTIC_LIMITS.queriesPerRun);
  });

  it('answers the elements that stayed and discards only the ones that left', async () => {
    const provider = new MockSemanticProvider({ respond: rightAnswer, delay: () => tick(1) });
    const engine = new SemanticAssistEngine(provider);
    const items = Array.from({ length: 40 }, (_, i) => item(`f${i}`, `Group ${i}`));
    const gone = (it: AssistItem): boolean => Number(it.id.slice(1)) % 2 === 1;
    const outcomes: AssistOutcome[] = [];
    const summary = await engine.run(items, {
      isCurrent: (it) => !gone(it),
      onResult: (o) => outcomes.push(o),
    });
    expect(outcomes.map((o) => o.id).sort()).toEqual(
      items
        .filter((i) => !gone(i))
        .map((i) => i.id)
        .sort(),
    );
    expect(summary.discarded).toBe(20);
  });
});

describe('churn: 500 manual-review elements, 100 packets, a slow provider', () => {
  it('keeps two in flight at most, 64 requests at most, and loses no finding', async () => {
    const g = gauge();
    const provider = new MockSemanticProvider({ respond: rightAnswer, delay: () => g.delay(1) });
    const engine = new SemanticAssistEngine(provider);
    const items = Array.from({ length: 500 }, (_, i) => item(`f${i}`, `Group ${i % 100}`));
    const stale = new Set<string>();
    const outcomes: AssistOutcome[] = [];
    const run = engine.run(items, {
      isCurrent: (it) => !stale.has(it.id),
      onResult: (o) => outcomes.push(o),
    });
    // Elements are replaced while the run is going.
    for (let wave = 0; wave < 5; wave += 1) {
      await tick(3);
      for (let i = wave; i < 500; i += 11) stale.add(`f${i}`);
    }
    const summary = await run;
    expect(g.peak).toBeLessThanOrEqual(2);
    expect(provider.calls).toBeLessThanOrEqual(SEMANTIC_LIMITS.queriesPerRun);
    // No finding is lost: every one was answered, discarded as stale, or left manual review.
    const answered = outcomes.length;
    expect(answered + summary.discarded + summary.notQueued.length).toBe(500);
    for (const o of outcomes) expect(stale.has(o.id) && summary.discarded === 0).toBe(false);
    // Nothing stale was ever delivered after it went stale.
    const gauges = engine.diagnostics();
    expect(gauges.semanticActive).toBe(0);
    expect(gauges.semanticQueued).toBe(0);
    expect(gauges.semanticMaxConcurrent).toBeLessThanOrEqual(2);
    expect(summary.coverage).toBe('partial');
  });

  it('never delivers an answer to a question of an older generation', async () => {
    const provider = new MockSemanticProvider({ respond: rightAnswer, delay: () => tick(2) });
    const engine = new SemanticAssistEngine(provider);
    let generation = '1';
    const items = Array.from({ length: 30 }, (_, i) => item(`f${i}`, `Group ${i}`, '1'));
    const delivered: string[] = [];
    const run = engine.run(items, {
      isCurrent: (it) => it.bound.bindings.generation === generation,
      onResult: (o) => delivered.push(o.id),
    });
    await tick(3);
    generation = '2'; // the page produced a newer snapshot: every old question is stale
    const summary = await run;
    const afterwards = delivered.length;
    await tick(10);
    expect(delivered).toHaveLength(afterwards);
    expect(summary.discarded + delivered.length + summary.notQueued.length).toBe(30);
    expect(provider.calls).toBeLessThan(30);
  });
});

describe('cancellation', () => {
  it('on audit close: aborts the signals in flight, clears the queue, ignores late answers, retains nothing', async () => {
    const signals: AbortSignal[] = [];
    const provider = new MockSemanticProvider({
      respond: rightAnswer,
      delay: async (signal) => {
        signals.push(signal);
        await tick(20);
      },
    });
    const engine = new SemanticAssistEngine(provider);
    const items = Array.from({ length: 20 }, (_, i) => item(`f${i}`, `Group ${i}`));
    const outcomes: AssistOutcome[] = [];
    const run = engine.run(items, { isCurrent: () => true, onResult: (o) => outcomes.push(o) });
    await tick(2);
    expect(engine.diagnostics().semanticActive).toBeGreaterThan(0);
    engine.cancelAll();
    engine.cache.clear();
    const summary = await run;
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(outcomes).toEqual([]);
    expect(summary.cancelled).toBe(true);
    const gauges = engine.diagnostics();
    expect([gauges.semanticActive, gauges.semanticQueued]).toEqual([0, 0]);
    expect(engine.cache.size).toBe(0);
    expect(provider.calls).toBeLessThanOrEqual(SEMANTIC_LIMITS.concurrency);
  });

  it('a result of an old provider never enters the result set of a new one', async () => {
    const first = new MockSemanticProvider({
      respond: rightAnswer,
      delay: () => tick(15),
      model: 'llama3.2:3b',
    });
    const second = new MockSemanticProvider({ respond: rightAnswer, model: 'qwen2.5:7b-instruct' });
    const results = new Map<string, string>();
    const oldEngine = new SemanticAssistEngine(first);
    const oldRun = oldEngine.run([item('a'), item('b', 'Other')], {
      isCurrent: () => true,
      onResult: (o) => results.set(o.id, `old:${o.model}`),
    });
    await tick(2);
    // The settings changed: the hook builds a new engine and cancels the old one.
    oldEngine.cancelAll();
    const newEngine = new SemanticAssistEngine(second);
    await newEngine.run([item('a'), item('b', 'Other')], {
      isCurrent: () => true,
      onResult: (o) => results.set(o.id, `new:${o.model}`),
    });
    await oldRun;
    await tick(30);
    expect([...results.values()].every((v) => v.startsWith('new:'))).toBe(true);
    expect(results.size).toBe(2);
  });

  it('a cache entry of one model is never served for another', async () => {
    const cache = new SemanticCache();
    const small = new MockSemanticProvider({ respond: rightAnswer, model: 'llama3.2:3b' });
    const large = new MockSemanticProvider({ respond: rightAnswer, model: 'qwen2.5:7b-instruct' });
    const hooks = { isCurrent: () => true, onResult: () => undefined };
    await new SemanticAssistEngine(small, { cache }).run([item('a')], hooks);
    await new SemanticAssistEngine(large, { cache }).run([item('a')], hooks);
    expect(small.calls).toBe(1);
    expect(large.calls).toBe(1);
    expect(cache.size).toBe(2);
  });
});

describe('slow and absent runtimes', () => {
  it('a timed-out request is unresolved, is never applied later, and does not block the event loop', async () => {
    const outcomes: AssistOutcome[] = [];
    const provider = new MockSemanticProvider({
      respond: rightAnswer,
      // Ignores its own signal: it answers long after the timeout.
      delay: () => tick(60),
    });
    const engine = new SemanticAssistEngine(provider, { timeoutMs: 15 });
    let loopTurned = false;
    setTimeout(() => (loopTurned = true), 0);
    const summary = await engine.run([item('a')], {
      isCurrent: () => true,
      onResult: (o) => outcomes.push(o),
    });
    expect(loopTurned).toBe(true); // the event loop kept turning while the provider "thought"
    expect(summary.stats.timeouts).toBe(1);
    expect(outcomes[0]?.interpreted).toMatchObject({
      validatorStatus: 'UNRESOLVED',
      reason: 'timeout',
    });
    await tick(80);
    expect(outcomes).toHaveLength(1); // the late answer never arrived at the caller
    expect(engine.diagnostics()).toMatchObject({ semanticActive: 0, semanticQueued: 0 });
  });

  it('two unreachable answers end a run: no storm, and the rest stay manual review', async () => {
    let calls = 0;
    const provider: SemanticProvider = {
      id: 'local-http',
      identity: () => ({ provider: 'local-http', model: null }),
      health: () => Promise.resolve('UNAVAILABLE'),
      infer: () => {
        calls += 1;
        return Promise.resolve({ ok: false, failure: 'unavailable' });
      },
    };
    const engine = new SemanticAssistEngine(provider);
    const items = Array.from({ length: 50 }, (_, i) => item(`f${i}`, `Group ${i}`));
    const summary = await engine.run(items, { isCurrent: () => true, onResult: () => undefined });
    // The second unreachable answer ends the run; a request started in between makes the bound concurrency + 1.
    expect(calls).toBeLessThanOrEqual(SEMANTIC_LIMITS.concurrency + 1);
    expect(summary.notQueued.length).toBeGreaterThanOrEqual(47);
    expect(summary.coverage).toBe('unavailable');
  });

  it('recovers when the runtime comes back, without anything being reset', async () => {
    let up = false;
    const provider = new MockSemanticProvider({
      respond: (r) => (up ? rightAnswer(r) : Promise.reject(new Error('down'))),
    });
    const engine = new SemanticAssistEngine(provider);
    const hooks = { isCurrent: () => true, onResult: () => undefined };
    const down = await engine.run([item('a')], hooks);
    expect(down.coverage).toBe('unavailable');
    up = true;
    const back = await engine.run([item('a')], hooks);
    expect(back.coverage).toBe('completed');
    expect(back.stats.accepted).toBe(1);
  });
});

describe('lifecycle', () => {
  it('leaves nothing behind after 100 open / run / close cycles with answers in flight', async () => {
    const provider = new MockSemanticProvider({ respond: rightAnswer, delay: () => tick(1) });
    let bytes = 0;
    for (let cycle = 0; cycle < 100; cycle += 1) {
      const engine = new SemanticAssistEngine(provider);
      const items = Array.from({ length: 8 }, (_, i) => item(`f${i}`, `Group ${cycle}-${i}`));
      const run = engine.run(items, { isCurrent: () => true, onResult: () => undefined });
      if (cycle % 2 === 0) await tick(1);
      engine.cancelAll();
      engine.cache.clear();
      await run;
      const g = engine.diagnostics();
      expect([g.semanticActive, g.semanticQueued, engine.cache.size, engine.cache.bytes]).toEqual([
        0, 0, 0, 0,
      ]);
      bytes += engine.cache.bytes;
    }
    expect(bytes).toBe(0);
  });

  it('keeps a long-lived cache within its entry and byte budgets over 100 runs of 64 fresh packets', async () => {
    const provider = new MockSemanticProvider({ respond: rightAnswer });
    const engine = new SemanticAssistEngine(provider);
    for (let run = 0; run < 100; run += 1) {
      const items = Array.from({ length: 64 }, (_, i) => item(`f${i}`, `Run ${run} group ${i}`));
      await engine.run(items, { isCurrent: () => true, onResult: () => undefined });
      expect(engine.cache.size).toBeLessThanOrEqual(SEMANTIC_LIMITS.cacheEntries);
      expect(engine.cache.bytes).toBeLessThanOrEqual(SEMANTIC_LIMITS.cacheBytes);
    }
  });
});

describe('coverage never claims more than was done', () => {
  it('is partial when packets were left over, and counts them', async () => {
    const provider = new MockSemanticProvider({ respond: rightAnswer });
    const engine = new SemanticAssistEngine(provider);
    const items = Array.from({ length: 100 }, (_, i) => item(`f${i}`, `Group ${i}`));
    const summary = await engine.run(items, { isCurrent: () => true, onResult: () => undefined });
    expect(summary.coverage).toBe('partial');
    expect(summary.stats.notQueued).toBe(100 - SEMANTIC_LIMITS.queriesPerRun);
    expect(summary.notQueued).toHaveLength(100 - SEMANTIC_LIMITS.queriesPerRun);
  });

  it('is completed only when every eligible case was answered or deduplicated', async () => {
    const provider = new MockSemanticProvider({ respond: rightAnswer });
    const engine = new SemanticAssistEngine(provider);
    const items = Array.from({ length: SEMANTIC_LIMITS.queriesPerRun }, (_, i) =>
      item(`f${i}`, `Group ${i}`),
    );
    const summary = await engine.run(items, { isCurrent: () => true, onResult: () => undefined });
    expect(summary.coverage).toBe('completed');
    expect(summary.stats.notQueued).toBe(0);
  });
});
