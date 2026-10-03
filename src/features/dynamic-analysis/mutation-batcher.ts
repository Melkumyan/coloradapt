import type { PipelineState } from '@domain/models';
import type { Scheduler } from './scheduler';

export interface MutationBatch {
  readonly records: readonly MutationRecord[];
  /** The queue limit was hit: the records were dropped and a full rescan is owed. */
  readonly overflowed: boolean;
}

export interface MutationBatcherOptions {
  readonly scheduler: Scheduler;
  /** Hard queue limit, in records. */
  readonly maxQueuedRecords: number;
  /** Handles one batch. Runs with the batcher in RUNNING; may call `request()`. */
  readonly onFlush: (batch: MutationBatch) => void;
}

/**
 * Queue + state machine between the observer and the analysis pass:
 *
 * ```
 * STOPPED -start-> IDLE -enqueue/request-> SCHEDULED -flush-> RUNNING -> IDLE
 *                                  RUNNING -enqueue/request-> DIRTY -> SCHEDULED
 * ```
 *
 * Two passes never overlap: work that arrives while one runs makes the
 * machine DIRTY and is handled by the next, separately scheduled, flush.
 * The queue is bounded; on overflow the queued records are dropped (their
 * references released) and the next batch carries `overflowed`, which the
 * pipeline answers with one full rescan, so a mutation storm costs O(1)
 * memory and one pass, never a silent stop.
 */
export class MutationBatcher {
  readonly #options: MutationBatcherOptions;
  #queue: MutationRecord[] = [];
  #overflowed = false;
  #state: PipelineState = 'STOPPED';
  #cancel: (() => void) | null = null;
  #overflowCount = 0;

  constructor(options: MutationBatcherOptions) {
    this.#options = options;
  }

  get state(): PipelineState {
    return this.#state;
  }

  get queued(): number {
    return this.#queue.length;
  }

  get overflowCount(): number {
    return this.#overflowCount;
  }

  /** Allows scheduling. */
  start(): void {
    if (this.#state === 'STOPPED') this.#state = 'IDLE';
  }

  /** Cancels any pending flush and drops the queue. */
  stop(): void {
    this.#cancel?.();
    this.#cancel = null;
    this.#queue = [];
    this.#overflowed = false;
    this.#state = 'STOPPED';
  }

  /** Drops queued records and a pending flush, but stays started. */
  discard(): void {
    this.#queue = [];
    this.#overflowed = false;
    if (this.#state === 'SCHEDULED') {
      this.#cancel?.();
      this.#cancel = null;
      this.#state = 'IDLE';
    }
  }

  /** Adds records and schedules a flush. */
  enqueue(records: readonly MutationRecord[]): void {
    if (this.#state === 'STOPPED') return;
    if (this.#overflowed) {
      // A full rescan is already owed; the records add nothing.
      this.request();
      return;
    }
    if (this.#queue.length + records.length > this.#options.maxQueuedRecords) {
      this.#queue = [];
      this.#overflowed = true;
      this.#overflowCount += 1;
    } else {
      for (const record of records) this.#queue.push(record);
    }
    this.request();
  }

  /** Asks for a flush without adding records (deferred work, manual refresh). */
  request(): void {
    switch (this.#state) {
      case 'IDLE':
        this.#state = 'SCHEDULED';
        this.#cancel = this.#options.scheduler.schedule(() => {
          this.#cancel = null;
          this.flush();
        });
        break;
      case 'RUNNING':
        this.#state = 'DIRTY';
        break;
      default:
        break;
    }
  }

  /** Takes everything queued so far. */
  take(): MutationBatch {
    const batch = { records: this.#queue, overflowed: this.#overflowed };
    this.#queue = [];
    this.#overflowed = false;
    return batch;
  }

  /** Runs the flush now (the scheduled one, or a forced one). No-op while RUNNING or STOPPED. */
  flush(): void {
    if (this.#state === 'STOPPED') return;
    if (this.#state === 'RUNNING' || this.#state === 'DIRTY') {
      this.#state = 'DIRTY';
      return;
    }
    this.#cancel?.();
    this.#cancel = null;
    this.#state = 'RUNNING';
    try {
      this.#options.onFlush(this.take());
    } finally {
      // onFlush may have changed the state (work arrived, or stop()); TS cannot see that.
      const after: PipelineState = this.state;
      if (after === 'DIRTY') {
        this.#state = 'IDLE';
        this.request();
      } else if (after === 'RUNNING') {
        this.#state = 'IDLE';
      }
    }
  }
}
