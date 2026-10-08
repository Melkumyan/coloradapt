/**
 * M12.R1-P04: explicit, bounded storage-readiness precondition for the real-Firefox restart test.
 *
 * Why it exists (docs/m12/protocol.md section 13): Firefox's storage layer can refuse the FIRST access to an
 * extension's storage after a browser start (Windows file-lock errors in QuotaManager / IndexedDB while the origin
 * is initialized); the extension API reports only "An unexpected error occurred" and the next access succeeds. That
 * is a platform state, not a persistence defect. "Settings kept across restarts" is still proven by the test's own
 * single `getSettings()` assertion that runs after readiness; this module only establishes that the storage backend
 * has answered one read.
 *
 * Contract: a probe is retried only inside a fixed attempt and time budget; every attempt is reported (nothing is
 * hidden); exhausting the budget, or cancellation, fails with the last error as `cause`. No sleep is a pass
 * condition: readiness is "the probe resolved".
 */
export interface ReadinessPolicy {
  readonly maxAttempts: number;
  /** No new attempt starts after this much time since the first one began. */
  readonly budgetMs: number;
  readonly delayMs: number;
}

export interface ReadinessAttempt {
  readonly attempt: number;
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly outcome: 'ready' | 'error';
  readonly error?: { readonly name: string; readonly message: string };
}

export interface ReadinessHooks {
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly cancelled?: () => boolean;
  readonly onAttempt?: (attempt: ReadinessAttempt) => void;
}

export const DEFAULT_READINESS: ReadinessPolicy = {
  maxAttempts: 6,
  budgetMs: 90_000,
  delayMs: 1_000,
};

export class ReadinessError extends Error {
  readonly attempts: ReadonlyArray<ReadinessAttempt>;
  readonly reason: 'exhausted' | 'budget' | 'cancelled';
  constructor(
    reason: 'exhausted' | 'budget' | 'cancelled',
    attempts: ReadonlyArray<ReadinessAttempt>,
    cause: unknown,
  ) {
    super(`storage not ready (${reason}) after ${attempts.length} attempt(s)`, { cause });
    this.name = 'ReadinessError';
    this.reason = reason;
    this.attempts = attempts;
  }
}

export async function awaitReady<T>(
  probe: () => Promise<T>,
  policy: ReadinessPolicy = DEFAULT_READINESS,
  hooks: ReadinessHooks = {},
): Promise<{ value: T; attempts: ReadinessAttempt[] }> {
  const now = hooks.now ?? Date.now;
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const began = now();
  const attempts: ReadinessAttempt[] = [];
  let last: unknown;
  for (let n = 1; n <= policy.maxAttempts; n++) {
    if (hooks.cancelled?.()) throw new ReadinessError('cancelled', attempts, last);
    if (n > 1 && now() - began > policy.budgetMs)
      throw new ReadinessError('budget', attempts, last);
    const startedAtMs = now();
    try {
      const value = await probe();
      const done: ReadinessAttempt = {
        attempt: n,
        startedAtMs: startedAtMs - began,
        durationMs: now() - startedAtMs,
        outcome: 'ready',
      };
      attempts.push(done);
      hooks.onAttempt?.(done);
      return { value, attempts };
    } catch (e) {
      last = e;
      const err = e as { name?: unknown; message?: unknown } | null;
      const failed: ReadinessAttempt = {
        attempt: n,
        startedAtMs: startedAtMs - began,
        durationMs: now() - startedAtMs,
        outcome: 'error',
        error: {
          name: typeof err?.name === 'string' ? err.name : 'Error',
          message: typeof err?.message === 'string' ? err.message : 'non-error rejection',
        },
      };
      attempts.push(failed);
      hooks.onAttempt?.(failed);
    }
    if (n < policy.maxAttempts) await sleep(policy.delayMs);
  }
  throw new ReadinessError('exhausted', attempts, last);
}
