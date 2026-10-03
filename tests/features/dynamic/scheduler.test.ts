import { describe, expect, it, vi } from 'vitest';
import { createFrameScheduler } from '@features/dynamic-analysis';

/** A window double with the timing primitives the scheduler may use. */
function fakeWindow(visibility: DocumentVisibilityState, withRaf = true) {
  const frames: Array<() => void> = [];
  const timeouts: Array<{ ms: number; run: () => void; cleared: boolean }> = [];
  const win = {
    document: { visibilityState: visibility },
    requestAnimationFrame: withRaf ? (run: () => void) => frames.push(run) : undefined,
    cancelAnimationFrame: (handle: number) => {
      frames[handle - 1] = () => undefined;
    },
    setTimeout: (run: () => void, ms: number) => {
      timeouts.push({ ms, run, cleared: false });
      return timeouts.length;
    },
    clearTimeout: (handle: number) => {
      timeouts[handle - 1]!.cleared = true;
    },
  };
  return { win: win as unknown as Window, frames, timeouts };
}

describe('createFrameScheduler', () => {
  it('visible page: requestAnimationFrame, no timeout', () => {
    const { win, frames, timeouts } = fakeWindow('visible');
    const run = vi.fn();
    createFrameScheduler(win).schedule(run);
    expect(frames).toHaveLength(1);
    expect(timeouts).toHaveLength(0);
    frames[0]!();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('hidden page: a zero-delay timeout, no requestAnimationFrame (rAF is paused there)', () => {
    const { win, frames, timeouts } = fakeWindow('hidden');
    const run = vi.fn();
    createFrameScheduler(win).schedule(run);
    expect(frames).toHaveLength(0);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]!.ms).toBe(0);
    timeouts[0]!.run();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('visibility is read at scheduling time, so a page that becomes hidden uses the timeout', () => {
    const fake = fakeWindow('visible');
    const scheduler = createFrameScheduler(fake.win);
    scheduler.schedule(() => undefined);
    (fake.win.document as unknown as { visibilityState: string }).visibilityState = 'hidden';
    scheduler.schedule(() => undefined);
    expect(fake.frames).toHaveLength(1);
    expect(fake.timeouts).toHaveLength(1);
  });

  it('without requestAnimationFrame it falls back to the timeout', () => {
    const { win, timeouts } = fakeWindow('visible', false);
    createFrameScheduler(win).schedule(() => undefined);
    expect(timeouts).toHaveLength(1);
  });

  it('the canceller stops a scheduled run on both paths', () => {
    const visible = fakeWindow('visible');
    const ranVisible = vi.fn();
    createFrameScheduler(visible.win).schedule(ranVisible)();
    visible.frames.forEach((frame) => frame());
    expect(ranVisible).not.toHaveBeenCalled();

    const hidden = fakeWindow('hidden');
    createFrameScheduler(hidden.win).schedule(() => undefined)();
    expect(hidden.timeouts[0]!.cleared).toBe(true);
  });

  it('scheduleAfter uses a timeout with the requested delay, and can be cancelled', () => {
    const { win, timeouts } = fakeWindow('visible');
    const cancel = createFrameScheduler(win).scheduleAfter(500, () => undefined);
    expect(timeouts[0]!.ms).toBe(500);
    cancel();
    expect(timeouts[0]!.cleared).toBe(true);
  });
});
