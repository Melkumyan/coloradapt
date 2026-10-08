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

/**
 * One entry per (element, property) the injected stylesheet currently styles: the element carries the rule's token
 * in `data-coloradapt-s` and the sheet has the rule for it (M12.5: one rule per distinct declaration).
 */
function sheetRules(): Array<{ id: string; property: string; value: string }> {
  const text = document.getElementById('coloradapt-stylesheet')?.textContent ?? '';
  const rules: Array<{ id: string; property: string; value: string }> = [];
  for (const element of document.querySelectorAll('[data-coloradapt-s]')) {
    const id = element.getAttribute('data-coloradapt-id') ?? '';
    for (const token of (element.getAttribute('data-coloradapt-s') ?? '').split(' ')) {
      if (!token || !text.includes(`[data-coloradapt-s~="${token}"]`)) continue;
      const colon = token.indexOf(':');
      rules.push({ id, property: token.slice(0, colon), value: token.slice(colon + 1) });
    }
  }
  return rules;
}

/** Element ids that currently have a rule in the injected stylesheet. */
export function sheetRuleIds(): string[] {
  return sheetRules().map((rule) => rule.id);
}

/** Whether `element` currently has an adaptation rule. */
export function isAdapted(element: Element): boolean {
  const id = element.getAttribute('data-coloradapt-id');
  return id !== null && sheetRuleIds().includes(id);
}

export function ruleCount(): number {
  return sheetRuleIds().length;
}
