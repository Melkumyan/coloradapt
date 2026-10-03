/**
 * When a batch is flushed. Injected so tests drive the pipeline by hand,
 * with no timers and no sleeps.
 */
export interface Scheduler {
  /** Runs `run` once, soon (before the next paint where the page is visible). Returns a canceller. */
  schedule(run: () => void): () => void;
  /** Runs `run` once after at least `ms`. Only used to space out full rescans. */
  scheduleAfter(ms: number, run: () => void): () => void;
}

/**
 * Default scheduler: `requestAnimationFrame` while the page is visible, a
 * zero-delay timeout otherwise (rAF is paused in background tabs, and
 * adaptation of a hidden page should not wait for it to be shown).
 *
 * Why a frame and not a microtask or a debounce: MutationObserver callbacks
 * already arrive once per microtask checkpoint, so a microtask adds no
 * coalescing, whereas a frame merges everything a framework does across
 * several tasks into one pass, and runs before that frame is painted, so newly
 * inserted content is adapted before it is ever shown. No arbitrary delay is
 * introduced.
 */
export function createFrameScheduler(win: Window): Scheduler {
  return {
    schedule(run) {
      if (
        win.document.visibilityState === 'visible' &&
        typeof win.requestAnimationFrame === 'function'
      ) {
        const handle = win.requestAnimationFrame(() => run());
        return () => win.cancelAnimationFrame(handle);
      }
      const handle = win.setTimeout(run, 0);
      return () => win.clearTimeout(handle);
    },
    scheduleAfter(ms, run) {
      const handle = win.setTimeout(run, ms);
      return () => win.clearTimeout(handle);
    },
  };
}
