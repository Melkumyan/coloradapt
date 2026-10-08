import { describe, expect, it } from 'vitest';
import { DEFAULT_READINESS, ReadinessError, awaitReady } from '../../realworld/lib/readiness';

/**
 * The storage-readiness precondition of the Firefox restart test (docs/m12/protocol.md section 13): bounded, reported,
 * never a pass for a permanent failure. Time and sleeping are injected; nothing here waits for real.
 */
const clock = () => {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => (t += ms),
    slept,
  };
};

const transient = (message = 'An unexpected error occurred') => new Error(message);

describe('storage readiness precondition', () => {
  it('a storage that is ready at once needs one attempt and no sleep', async () => {
    const c = clock();
    const { value, attempts } = await awaitReady(() => Promise.resolve('ok'), DEFAULT_READINESS, c);
    expect(value).toBe('ok');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt: 1, outcome: 'ready' });
    expect(c.slept).toEqual([]);
  });

  it('a transient refusal of the first accesses is recovered, and every attempt is reported', async () => {
    const c = clock();
    let calls = 0;
    const seen: string[] = [];
    const { attempts } = await awaitReady(
      () => (++calls < 3 ? Promise.reject(transient()) : Promise.resolve(true)),
      DEFAULT_READINESS,
      { ...c, onAttempt: (a) => seen.push(a.outcome) },
    );
    expect(calls).toBe(3);
    expect(attempts.map((a) => a.outcome)).toEqual(['error', 'error', 'ready']);
    expect(attempts[0]?.error).toEqual({
      name: 'Error',
      message: 'An unexpected error occurred',
    });
    expect(seen).toEqual(['error', 'error', 'ready']);
    expect(c.slept).toEqual([1000, 1000]);
  });

  it('a permanent failure is bounded by the attempt count and keeps the last error as cause', async () => {
    const c = clock();
    let calls = 0;
    const failure = awaitReady(
      () => {
        calls++;
        return Promise.reject(transient(`refused ${calls}`));
      },
      { maxAttempts: 4, budgetMs: 1e9, delayMs: 10 },
      c,
    );
    await expect(failure).rejects.toBeInstanceOf(ReadinessError);
    expect(calls).toBe(4); // no infinite retry
    const error = (await failure.catch((e: unknown) => e)) as ReadinessError;
    expect(error.reason).toBe('exhausted');
    expect(error.attempts).toHaveLength(4);
    expect((error.cause as Error).message).toBe('refused 4'); // the real last error is not replaced
    expect(c.slept).toEqual([10, 10, 10]);
  });

  it('the time budget stops new attempts even when attempts remain', async () => {
    const c = clock();
    let calls = 0;
    const failure = awaitReady(
      () => {
        calls++;
        c.advance(11_000); // each refused attempt takes ~11 s, as observed in Firefox
        return Promise.reject(transient());
      },
      { maxAttempts: 100, budgetMs: 25_000, delayMs: 1000 },
      c,
    );
    const error = (await failure.catch((e: unknown) => e)) as ReadinessError;
    expect(error.reason).toBe('budget');
    expect(calls).toBeLessThan(5);
  });

  it('cancellation (the browser is closing) ends the wait at once', async () => {
    const c = clock();
    let calls = 0;
    let closed = false;
    const failure = awaitReady(
      () => {
        calls++;
        closed = true; // shutdown begins during the first refused attempt
        return Promise.reject(transient());
      },
      DEFAULT_READINESS,
      { ...c, cancelled: () => closed },
    );
    const error = (await failure.catch((e: unknown) => e)) as ReadinessError;
    expect(error.reason).toBe('cancelled');
    expect(calls).toBe(1);
  });

  it('a success is never turned into a failure and a rejection with a non-error value is still reported', async () => {
    const c = clock();
    let calls = 0;
    const { attempts } = await awaitReady(
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test: a rejection that is not an Error
      () => (++calls === 1 ? Promise.reject('plain string') : Promise.resolve(1)),
      DEFAULT_READINESS,
      c,
    );
    expect(attempts[0]?.error?.message).toBe('non-error rejection');
    expect(attempts[1]?.outcome).toBe('ready');
  });

  it('the default policy is finite', () => {
    expect(DEFAULT_READINESS.maxAttempts).toBeGreaterThan(1);
    expect(DEFAULT_READINESS.maxAttempts).toBeLessThanOrEqual(10);
    expect(DEFAULT_READINESS.budgetMs).toBeLessThanOrEqual(120_000);
  });
});
