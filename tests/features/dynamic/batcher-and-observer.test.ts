import { describe, expect, it, vi } from 'vitest';
import {
  DocumentMutationObserver,
  MutationBatcher,
  isStyleChangeRelevant,
  isClassChangeRelevant,
  type MutationBatch,
} from '@features/dynamic-analysis';
import { createManualScheduler } from './helpers';

const fakeRecord = (): MutationRecord => ({}) as MutationRecord;

function makeBatcher(maxQueuedRecords = 10) {
  const scheduler = createManualScheduler();
  const batches: MutationBatch[] = [];
  let reenter: ((batcher: MutationBatcher) => void) | null = null;
  const batcher: MutationBatcher = new MutationBatcher({
    scheduler,
    maxQueuedRecords,
    onFlush: (batch) => {
      batches.push(batch);
      reenter?.(batcher);
    },
  });
  return {
    batcher,
    scheduler,
    batches,
    onFlushDo: (callback: (batcher: MutationBatcher) => void) => {
      reenter = callback;
    },
  };
}

describe('MutationBatcher', () => {
  it('is inert until started', () => {
    const { batcher, scheduler } = makeBatcher();
    batcher.enqueue([fakeRecord()]);
    expect(batcher.state).toBe('STOPPED');
    expect(scheduler.pending).toBe(0);
  });

  it('IDLE -> SCHEDULED -> RUNNING -> IDLE, and schedules exactly one flush for many enqueues', () => {
    const { batcher, scheduler, batches } = makeBatcher();
    batcher.start();
    expect(batcher.state).toBe('IDLE');

    batcher.enqueue([fakeRecord(), fakeRecord()]);
    batcher.enqueue([fakeRecord()]);
    batcher.enqueue([fakeRecord()]);
    expect(batcher.state).toBe('SCHEDULED');
    expect(scheduler.pending).toBe(1);

    scheduler.runFrame();
    expect(batcher.state).toBe('IDLE');
    expect(batches).toHaveLength(1);
    expect(batches[0]!.records).toHaveLength(4);
    expect(batches[0]!.overflowed).toBe(false);
  });

  it('work arriving while a flush runs is handled by a separate, later flush', () => {
    const { batcher, scheduler, batches, onFlushDo } = makeBatcher();
    batcher.start();
    let first = true;
    onFlushDo((b) => {
      expect(b.state).toBe('RUNNING');
      if (first) {
        first = false;
        b.enqueue([fakeRecord()]); // a mutation during the pass
        expect(b.state).toBe('DIRTY');
      }
    });

    batcher.enqueue([fakeRecord()]);
    scheduler.runFrame();

    expect(batches).toHaveLength(1);
    expect(batcher.state).toBe('SCHEDULED'); // not run re-entrantly
    scheduler.runFrame();
    expect(batches).toHaveLength(2);
    expect(batches[1]!.records).toHaveLength(1);
    expect(batcher.state).toBe('IDLE');
  });

  it('request() during a flush also marks it dirty (deferred work)', () => {
    const { batcher, scheduler, batches, onFlushDo } = makeBatcher();
    batcher.start();
    let first = true;
    onFlushDo((b) => {
      if (first) {
        first = false;
        b.request();
      }
    });
    batcher.request();
    scheduler.runFrame();
    expect(batcher.state).toBe('SCHEDULED');
    scheduler.runFrame();
    expect(batches).toHaveLength(2);
  });

  it('a forced flush() runs now and cancels the scheduled one', () => {
    const { batcher, scheduler, batches } = makeBatcher();
    batcher.start();
    batcher.enqueue([fakeRecord()]);
    batcher.flush();
    expect(batches).toHaveLength(1);
    expect(scheduler.pending).toBe(0);
    expect(batcher.state).toBe('IDLE');
  });

  it('overflow drops the queue, releases the records, and flags the batch once', () => {
    const { batcher, scheduler, batches } = makeBatcher(5);
    batcher.start();
    batcher.enqueue(Array.from({ length: 4 }, fakeRecord));
    batcher.enqueue(Array.from({ length: 4 }, fakeRecord)); // 8 > 5
    expect(batcher.queued).toBe(0);
    batcher.enqueue(Array.from({ length: 100 }, fakeRecord)); // already owed: cheap no-op
    expect(batcher.queued).toBe(0);
    expect(batcher.overflowCount).toBe(1);

    scheduler.runFrame();
    expect(batches[0]).toEqual({ records: [], overflowed: true });
    batcher.enqueue([fakeRecord()]);
    scheduler.runFrame();
    expect(batches[1]!.overflowed).toBe(false);
  });

  it('stop() cancels the pending flush and drops the queue', () => {
    const { batcher, scheduler, batches } = makeBatcher();
    batcher.start();
    batcher.enqueue([fakeRecord()]);
    batcher.stop();
    expect(batcher.state).toBe('STOPPED');
    expect(scheduler.pending).toBe(0);
    scheduler.runFrame();
    expect(batches).toHaveLength(0);
    batcher.start();
    expect(batcher.queued).toBe(0);
  });

  it('discard() clears queued records and the pending flush but stays started', () => {
    const { batcher, scheduler } = makeBatcher();
    batcher.start();
    batcher.enqueue([fakeRecord()]);
    batcher.discard();
    expect(batcher.state).toBe('IDLE');
    expect(batcher.queued).toBe(0);
    expect(scheduler.pending).toBe(0);
  });
});

describe('DocumentMutationObserver', () => {
  function spyFactory() {
    const calls = { observe: 0, disconnect: 0 };
    const factory = (callback: MutationCallback) => {
      const real = new MutationObserver(callback);
      return {
        observe: (...args: Parameters<MutationObserver['observe']>) => {
          calls.observe += 1;
          real.observe(...args);
        },
        disconnect: () => {
          calls.disconnect += 1;
          real.disconnect();
        },
        takeRecords: () => real.takeRecords(),
      };
    };
    return { calls, factory };
  }

  it('start() is idempotent: repeated calls never stack subscriptions', () => {
    const { calls, factory } = spyFactory();
    const observer = new DocumentMutationObserver(document, () => undefined, factory);
    observer.start();
    const afterFirst = calls.observe;
    observer.start();
    observer.start();
    expect(calls.observe).toBe(afterFirst);
    expect(observer.starts).toBe(1);
    observer.stop();
    expect(calls.disconnect).toBe(1);
    observer.stop();
    expect(calls.disconnect).toBe(1);
  });

  it('delivers nothing after stop() and again after restart', async () => {
    const onRecords = vi.fn();
    const observer = new DocumentMutationObserver(document, onRecords);
    observer.start();
    document.body.appendChild(document.createElement('div')).remove();
    await Promise.resolve();
    expect(onRecords).toHaveBeenCalledTimes(1);

    observer.stop();
    document.body.appendChild(document.createElement('div')).remove();
    await Promise.resolve();
    expect(onRecords).toHaveBeenCalledTimes(1);
    expect(observer.takeRecords()).toEqual([]);

    observer.start();
    document.body.appendChild(document.createElement('div')).remove();
    await Promise.resolve();
    expect(onRecords).toHaveBeenCalledTimes(2);
    expect(observer.starts).toBe(2);
    observer.stop();
  });
});

describe('style relevance', () => {
  const relevant = (a: string | null, b: string | null) => isStyleChangeRelevant(a, b, document);

  it('flags the properties ColorAdapt reads', () => {
    for (const property of [
      'color: red',
      'background: blue',
      'background-color: blue',
      'opacity: 0.5',
      'display: none',
      'visibility: hidden',
      '--theme: dark',
      'border-color: red',
    ]) {
      expect(relevant('', property), property).toBe(true);
    }
  });

  it('ignores animation-style properties', () => {
    for (const property of [
      'transform: none',
      'top: 4px',
      'left: 1px',
      'width: 10px',
      'transition: all 1s',
      'will-change: transform',
    ]) {
      expect(relevant('', property), property).toBe(false);
    }
  });

  it('is not fooled by reserialization of colors or reordering', () => {
    expect(relevant('color: #c0392b;', 'color: rgb(192, 57, 43); transform: none')).toBe(false);
    expect(relevant('color: red; top: 1px', 'top: 1px; color: red')).toBe(false);
  });

  it('works without an engine (raw fallback)', () => {
    expect(isStyleChangeRelevant('top: 1px', 'top: 2px')).toBe(false);
    expect(isStyleChangeRelevant('top: 1px', 'top: 2px; color: red')).toBe(true);
    expect(isStyleChangeRelevant('background: url(data:image/png;base64,a;b)', 'x: y')).toBe(true);
  });

  it('class changes: only token-set differences count', () => {
    expect(isClassChangeRelevant('a b', 'b a')).toBe(false);
    expect(isClassChangeRelevant('a  b', 'a b')).toBe(false);
    expect(isClassChangeRelevant('a', 'a b')).toBe(true);
    expect(isClassChangeRelevant(null, 'a')).toBe(true);
  });
});
