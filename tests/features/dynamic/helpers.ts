import { DEFAULT_USER_SETTINGS, type UserSettings } from '@domain/models';
import type { Scheduler } from '@features/dynamic-analysis';

export const DEUTAN: UserSettings = {
  ...DEFAULT_USER_SETTINGS,
  visionProfile: 'deuteranopia',
  adaptationStrength: 1,
};

/** Red text on green: a conflict for deuteranopia (adapted), as in the M3 tests. */
export const CONFLICT_STYLE = 'color: #c0392b; background-color: #27ae60;';
/** Dark text on white: accessible, must stay untouched. */
export const FINE_STYLE = 'color: #000000; background-color: #ffffff;';

export interface ManualScheduler extends Scheduler {
  /** Callbacks waiting for the next "frame". */
  readonly pending: number;
  /** Runs everything currently waiting (callbacks queued while running wait for the next call). */
  runFrame(): void;
  /** Throttle timers: [ms, run] */
  readonly timers: ReadonlyArray<{ ms: number; run: () => void }>;
  runTimers(): void;
}

/** A scheduler driven by hand: no timers, no sleeps, no rAF. */
export function createManualScheduler(): ManualScheduler {
  let queue: Array<() => void> = [];
  let timers: Array<{ ms: number; run: () => void }> = [];
  return {
    schedule(run) {
      queue.push(run);
      return () => {
        queue = queue.filter((entry) => entry !== run);
      };
    },
    scheduleAfter(ms, run) {
      const entry = { ms, run };
      timers.push(entry);
      return () => {
        timers = timers.filter((candidate) => candidate !== entry);
      };
    },
    get pending() {
      return queue.length;
    },
    get timers() {
      return timers;
    },
    runFrame() {
      const batch = queue;
      queue = [];
      for (const run of batch) run();
    },
    runTimers() {
      const due = timers;
      timers = [];
      for (const { run } of due) run();
    },
  };
}

/** Lets pending MutationObserver callbacks (microtasks) run. */
export async function microtasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

export function computedColor(element: Element): string {
  return getComputedStyle(element).color;
}

export function html(markup: string): void {
  document.body.innerHTML = markup;
}

/** Element ids that currently have a rule in the injected stylesheet, as written in its text. */
export function sheetRuleIds(): string[] {
  const text = document.getElementById('coloradapt-stylesheet')?.textContent ?? '';
  return [...text.matchAll(/\[data-coloradapt-id="([^"]+)"\]:not/g)].map((match) => match[1]!);
}

/** Whether `element` currently has an adaptation rule. */
export function isAdapted(element: Element): boolean {
  const id = element.getAttribute('data-coloradapt-id');
  return id !== null && sheetRuleIds().includes(id);
}

export function ruleCount(): number {
  return sheetRuleIds().length;
}
