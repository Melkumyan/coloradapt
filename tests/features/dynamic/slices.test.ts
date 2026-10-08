import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '@domain/models';
import { createDynamicContentController } from '@features/dynamic-analysis';
import { CUE_ATTRIBUTE } from '@features/semantics';
import { simulatedBrowser } from '../semantics/kit';
import { createManualScheduler, microtasks } from './helpers';

/**
 * M12.5 (docs/PERFORMANCE.md, "Burst model"): a burst is processed in slices, and where the slices end must never
 * change what the page ends up with. Every test here compares a final state with the state of one unbounded pass
 * over the same page, or checks that a stopped / superseded burst leaves nothing behind.
 */
const URL = 'https://example.com';

const DEUTAN: UserSettings = {
  ...DEFAULT_USER_SETTINGS,
  visionProfile: 'deuteranopia',
  adaptationStrength: 1,
  semanticCuesEnabled: true,
};
const PROTAN: UserSettings = { ...DEUTAN, visionProfile: 'protanopia' };

const CSS = `
  .badge { display: inline-block; padding: 2px 6px; color: #ffffff; background-color: #7f8c8d; }
  .badge.success { background-color: #1e8449; }
  .badge.error { background-color: #c0392b; }
  .status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
  .status.online { background-color: #27ae60; }
  .status.offline { background-color: #c0392b; }
  .fade { opacity: 0.6; }
  .clear { background-color: transparent; }
`;

/** A small deterministic generator (mulberry32): the fixtures are the same on every run. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One row of a host: a mix of what the engine treats differently. */
function row(kind: number, n: number): string {
  switch (kind % 9) {
    case 0:
      return `<p style="color:#c0392b;background-color:#27ae60">red on green ${n}</p>`;
    case 1:
      return `<p style="color:#000000;background-color:#ffffff">fine ${n}</p>`;
    case 2:
      return `<div class="fade" style="background-color:#27ae60"><span style="color:#c0392b">faded ${n}</span></div>`;
    case 3:
      return `<div style="background-color:#27ae60"><div class="clear"><b style="color:#c0392b">through ${n}</b></div></div>`;
    case 4:
      return `<p style="color:#c0392b !important;background-color:#27ae60">important ${n}</p>`;
    case 5:
      return `<span class="badge success">ok ${n}</span><span class="badge error">bad ${n}</span>`;
    case 6:
      return `<span class="status online"></span><span class="status offline"></span>`;
    case 7:
      return `<a href="#" style="color:#2980b9;background-color:#ffffff">link ${n}</a>`;
    default:
      return `<p style="color:#8e44ad;background-color:#d35400">purple on orange ${n}</p>`;
  }
}

function host(index: number, rows: number, seed = 1): string {
  const next = random(seed * 1000 + index);
  const items = Array.from({ length: rows }, (_v, i) =>
    row(Math.floor(next() * 9), index * 100 + i),
  );
  return `<section data-host="${index}">${items.join('')}</section>`;
}

interface Rig {
  readonly controller: ReturnType<typeof createDynamicContentController>;
  readonly scheduler: ReturnType<typeof createManualScheduler>;
}

let current: Rig | null = null;

/** Like {@link start}, with the weights of the slice budget supplied by the test. */
function startWeighted(slice: number, weigh: (element: Element) => number): Rig {
  document.head.innerHTML = `<style id="page-css">${CSS}</style>`;
  document.body.innerHTML =
    '<main></main><p style="color:#c0392b;background-color:#27ae60">first</p>';
  const scheduler = createManualScheduler();
  const controller = createDynamicContentController(
    document,
    { now: () => 0, sliceElements: slice, sliceWeight: weigh },
    { scheduler, budget: { maxPassesPerFlush: 100_000 } },
    { env: simulatedBrowser(document) },
  );
  controller.enableAdaptation(URL, DEUTAN);
  current = { controller, scheduler };
  return current;
}

/** The page before the burst, adapted, observing; `slice` is the slice budget of incremental passes. */
function start(initial: string, slice: number, settings: UserSettings = DEUTAN): Rig {
  document.head.innerHTML = `<style id="page-css">${CSS}</style>`;
  document.body.innerHTML = initial;
  const scheduler = createManualScheduler();
  const controller = createDynamicContentController(
    document,
    { now: () => 0, sliceElements: slice },
    { scheduler, budget: { maxPassesPerFlush: 100_000 } },
    { env: simulatedBrowser(document) },
  );
  controller.enableAdaptation(URL, settings);
  current = { controller, scheduler };
  return current;
}

afterEach(() => {
  current?.controller.dynamic.dispose();
  current?.controller.disableAdaptation();
  current = null;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

/** What the page ends up with, independent of ids and of the order work was done in. */
function snapshot(rig: Rig): unknown {
  const nodes = [...document.body.querySelectorAll('*')];
  return {
    elements: nodes.map((node, index) => [
      index,
      node.getAttribute('data-coloradapt-s'),
      node.getAttribute(CUE_ATTRIBUTE),
      getComputedStyle(node).color,
    ]),
    sheet: document.getElementById('coloradapt-stylesheet')?.textContent ?? null,
    summary: rig.controller.incremental.summary(),
    tracked: rig.controller.incremental.trackedCount(),
    rules: rig.controller.incremental.ruleCount,
  };
}

const append = (markup: string) => document.body.insertAdjacentHTML('beforeend', markup);

/** Runs frames by hand until the pipeline has nothing left; returns how many it took. */
async function settle(rig: Rig, limit = 10_000): Promise<number> {
  let frames = 0;
  for (;;) {
    await microtasks();
    if (rig.scheduler.pending === 0) return frames;
    if (frames >= limit) throw new Error('did not settle');
    rig.scheduler.runFrame();
    frames += 1;
  }
}

const CHUNKS = [1, 2, 3, 7, 16, 64, 256, 1_000_000];

describe('chunk-boundary parity', () => {
  const hosts = (count: number, rows: number, seed: number) =>
    Array.from({ length: count }, (_v, i) => host(i, rows, seed)).join('');

  it('the reference run is genuinely unbounded: one pass for the whole burst', async () => {
    const rig = start('<main></main>', 1_000_000);
    append(hosts(20, 8, 1));
    await settle(rig);
    expect(rig.controller.dynamic.diagnostics().incrementalPasses).toBe(1);
  });

  for (const seed of [1, 2, 3]) {
    it(`a burst of 20 hosts ends in the same state for every slice size (seed ${seed})`, async () => {
      const results = new Map<number, unknown>();
      const passes = new Map<number, number>();
      for (const chunk of CHUNKS) {
        const rig = start(
          '<main></main><p style="color:#c0392b;background-color:#27ae60">old</p>',
          chunk,
        );
        append(hosts(20, 8, seed));
        await settle(rig);
        results.set(chunk, snapshot(rig));
        passes.set(chunk, rig.controller.dynamic.diagnostics().incrementalPasses);
        const diag = rig.controller.dynamic.diagnostics();
        expect(diag.deferredRoots).toBe(0);
        expect(diag.queuedRecords).toBe(0);
        expect(diag.fullRescans).toBe(0);
        rig.controller.dynamic.dispose();
        rig.controller.disableAdaptation();
      }
      const reference = results.get(1_000_000);
      for (const chunk of CHUNKS) expect(results.get(chunk), `slice ${chunk}`).toEqual(reference);
      // it really was sliced: smaller budgets take at least as many passes, and the reference took one
      expect(passes.get(1_000_000)!).toBe(1);
      expect(passes.get(1)!).toBeGreaterThanOrEqual(passes.get(7)!);
      expect(passes.get(7)!).toBeGreaterThan(passes.get(256)!);
      expect(passes.get(16)!).toBeGreaterThan(1);
    });
  }

  it('a burst equals what a fresh full analysis of the same page produces', async () => {
    const rig = start('<main></main>', 7);
    append(hosts(20, 8, 4));
    await settle(rig);
    const incremental = snapshot(rig);
    rig.controller.dynamic.dispose();
    rig.controller.disableAdaptation();

    // the same page, but loaded with its content: one full analysis
    const markup = `<main></main>${hosts(20, 8, 4)}`;
    const fresh = start(markup, 1_000_000);
    expect(snapshot(fresh)).toEqual(incremental);
  });
});

describe('parity corpus (60 deterministic pages)', () => {
  /** Page `n`: a few hosts of a few rows, shapes and sizes chosen by the seed. */
  const page = (n: number) => {
    const next = random(n * 7919);
    const hosts = 2 + Math.floor(next() * 7);
    const rows = 2 + Math.floor(next() * 9);
    return Array.from({ length: hosts }, (_v, i) => host(i, rows, n)).join('');
  };
  const final = async (n: number, slice: number, weigh?: (element: Element) => number) => {
    const rig = weigh
      ? startWeighted(slice, weigh)
      : start('<main></main><p style="color:#c0392b;background-color:#27ae60">first</p>', slice);
    append(page(n));
    await settle(rig);
    const state = snapshot(rig);
    rig.controller.dynamic.dispose();
    rig.controller.disableAdaptation();
    current = null;
    return state;
  };

  it('sixty pages end in the same state for every slice size tried', async () => {
    for (let n = 1; n <= 60; n += 1) {
      const reference = await final(n, 1_000_000);
      for (const slice of [1, 7, 64]) {
        expect(await final(n, slice), `page ${n}, slice ${slice}`).toEqual(reference);
      }
    }
  }, 120_000);

  it('randomized slice boundaries (seeded weights) end in the same state', async () => {
    for (let n = 1; n <= 20; n += 1) {
      const reference = await final(n, 1_000_000);
      for (const seed of [1, 2, 3]) {
        const next = random(seed * 104729 + n);
        const weights = new WeakMap<Element, number>();
        const weigh = (element: Element) => {
          if (!weights.has(element)) weights.set(element, 1 + Math.floor(next() * 6));
          return weights.get(element)!;
        };
        const slice = 4 + Math.floor(random(seed + n)() * 40);
        expect(await final(n, slice, weigh), `page ${n}, seed ${seed}, slice ${slice}`).toEqual(
          reference,
        );
      }
    }
  }, 120_000);
});

describe('mutations that arrive while a burst is being worked off', () => {
  /** The operations of a scenario, applied at the given point (after `slices` slices have run). */
  const operations: Array<(slice: number) => void> = [
    () => append(host(100, 6, 9)),
    () => document.querySelector('[data-host="3"]')?.remove(),
    () => {
      const target = document.querySelector('[data-host="5"] p');
      target?.setAttribute('style', 'color:#000000;background-color:#ffffff');
    },
    () =>
      document
        .querySelector('[data-host="7"]')
        ?.replaceWith(
          Object.assign(document.createElement('section'), { innerHTML: host(101, 5, 9) }),
        ),
    () => append(host(102, 6, 9)),
    () => document.querySelector('[data-host="9"] p')?.setAttribute('class', 'badge success'),
    () => document.querySelector('[data-host="11"]')?.remove(),
  ];

  for (const chunk of [1, 3, 16, 256]) {
    it(`every interleaving point converges to the one-pass result (slice ${chunk})`, async () => {
      const burst = Array.from({ length: 16 }, (_v, i) => host(i, 6, 9)).join('');

      // reference: all operations first, one unbounded pass
      const ref = start('<main></main>', 1_000_000);
      append(burst);
      for (const [i, operation] of operations.entries()) operation(i);
      await settle(ref);
      const expected = snapshot(ref);
      ref.controller.dynamic.dispose();
      ref.controller.disableAdaptation();

      // after 0, 1, 2, ... slices, apply the next operation
      for (let gap = 0; gap <= 3; gap += 1) {
        const rig = start('<main></main>', chunk);
        append(burst);
        for (const [i, operation] of operations.entries()) {
          for (let s = 0; s < gap; s += 1) {
            await microtasks();
            rig.scheduler.runFrame();
          }
          operation(i);
        }
        await settle(rig);
        expect(snapshot(rig), `slice ${chunk}, one slice between operations x${gap}`).toEqual(
          expected,
        );
        rig.controller.dynamic.dispose();
        rig.controller.disableAdaptation();
      }
    });
  }

  it('an element mutated 1000 times before a slice is analyzed once, not 1000 times', async () => {
    const rig = start('<p id="x" style="color:#c0392b;background-color:#27ae60">x</p>', 16);
    const x = document.getElementById('x')!;
    for (let i = 0; i <= 1000; i += 1) {
      x.setAttribute(
        'style',
        i % 2 ? 'color:#c0392b;background-color:#27ae60' : 'color:#000000;background-color:#ffffff',
      );
    }
    await settle(rig);
    const diag = rig.controller.dynamic.diagnostics();
    expect(diag.incrementalPasses).toBe(1);
    expect(diag.elementsProcessed).toBeLessThanOrEqual(2);
    expect(diag.queueOverflows).toBe(0);
  });

  it('a subtree and one of its own elements mutated together are one region, not two', async () => {
    const rig = start('<main></main>', 16);
    append(host(0, 6, 1));
    const section = document.querySelector('[data-host="0"]')!;
    section.querySelector('p')?.setAttribute('class', 'badge');
    await settle(rig);
    const diag = rig.controller.dynamic.diagnostics();
    expect(diag.affectedRoots).toBeLessThanOrEqual(2);
  });
});

describe('cancellation', () => {
  it('turning ON off in the middle of a burst leaves nothing behind and nothing scheduled', async () => {
    const rig = start('<main></main>', 3);
    append(Array.from({ length: 30 }, (_v, i) => host(i, 6, 2)).join(''));
    await microtasks();
    rig.scheduler.runFrame();
    expect(rig.controller.dynamic.diagnostics().deferredRoots).toBeGreaterThan(0);

    rig.controller.disableAdaptation();

    expect(rig.scheduler.pending).toBe(0);
    rig.scheduler.runFrame();
    const diag = rig.controller.dynamic.diagnostics();
    expect(diag.deferredRoots).toBe(0);
    expect(diag.cancelledRoots).toBeGreaterThan(0); // the work that was waiting is counted as cancelled
    expect(diag.queuedRecords).toBe(0);
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
    expect(document.getElementById('coloradapt-suppress')).toBeNull();
    expect(
      document.querySelectorAll('[data-coloradapt-s], [data-coloradapt-t], [data-coloradapt-cue]'),
    ).toHaveLength(0);
  });

  it('a profile change in the middle of a burst ends exactly where the new profile alone would', async () => {
    const burst = Array.from({ length: 24 }, (_v, i) => host(i, 6, 3)).join('');

    const alone = start('<main></main>', 5, PROTAN);
    append(burst);
    await settle(alone);
    const expected = snapshot(alone);
    alone.controller.dynamic.dispose();
    alone.controller.disableAdaptation();

    const rig = start('<main></main>', 5, DEUTAN);
    append(burst);
    await microtasks();
    rig.scheduler.runFrame();
    rig.scheduler.runFrame();
    expect(rig.controller.dynamic.diagnostics().deferredRoots).toBeGreaterThan(0);
    rig.controller.enableAdaptation(URL, PROTAN);
    await settle(rig);

    expect(snapshot(rig)).toEqual(expected);
    expect(rig.controller.dynamic.diagnostics().deferredRoots).toBe(0);
  });

  it('stopping the pipeline cancels the pending flush: nothing resumes later', async () => {
    const rig = start('<main></main>', 2);
    append(Array.from({ length: 10 }, (_v, i) => host(i, 4, 5)).join(''));
    await microtasks();
    rig.scheduler.runFrame();
    rig.controller.dynamic.stop();
    expect(rig.scheduler.pending).toBe(0);
    const before = rig.controller.incremental.trackedCount();
    rig.scheduler.runFrame();
    expect(rig.controller.incremental.trackedCount()).toBe(before);
  });

  it('an element removed while it waits for its slice is never adapted and leaves no rule', async () => {
    const rig = start('<main></main>', 2);
    append(Array.from({ length: 10 }, (_v, i) => host(i, 4, 6)).join(''));
    await microtasks();
    rig.scheduler.runFrame();
    document.querySelector('[data-host="9"]')?.remove();
    document.querySelector('[data-host="8"]')?.remove();
    await settle(rig);
    // they were queued, left the page before their turn, and were dropped without work
    expect(rig.controller.dynamic.diagnostics().staleRoots).toBeGreaterThan(0);
    const ids = [...document.querySelectorAll('[data-coloradapt-id]')].map((n) =>
      n.getAttribute('data-coloradapt-id'),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(rig.controller.dynamic.diagnostics().deferredRoots).toBe(0);
    // every rule the bookkeeping holds belongs to an element that is still in the page
    const pairs = [...document.querySelectorAll('[data-coloradapt-s]')].reduce(
      (sum, node) => sum + (node.getAttribute('data-coloradapt-s') ?? '').split(' ').length,
      0,
    );
    expect(rig.controller.incremental.ruleCount).toBe(pairs);
  });
});

describe('starvation and continuous mutation', () => {
  it('old work is worked off first, whatever keeps arriving behind it', async () => {
    const rig = start('<main></main>', 4);
    append(host(0, 8, 7));
    append(host(1, 8, 7));
    append(host(2, 8, 7));
    const adaptedAt = new Map<number, number>();
    for (let frame = 1; frame <= 60; frame += 1) {
      append(host(100 + frame, 8, 7)); // a new burst every frame
      await microtasks();
      rig.scheduler.runFrame();
      for (const index of [0, 1, 2]) {
        if (adaptedAt.has(index)) continue;
        const done =
          [...document.querySelectorAll(`[data-host="${index}"] [data-coloradapt-id]`)].length > 0;
        if (done) adaptedAt.set(index, frame);
      }
      const diag = rig.controller.dynamic.diagnostics();
      expect(diag.queueOverflows).toBe(0);
    }
    // the first hosts were reached within a few frames, ahead of everything that came after them
    expect(adaptedAt.get(0)!).toBeLessThanOrEqual(3);
    expect(adaptedAt.get(2)!).toBeLessThanOrEqual(8);
    const diag = rig.controller.dynamic.diagnostics();
    expect(diag.peakDeferredRoots).toBeLessThanOrEqual(512);
    // when the stream stops, the backlog is worked off in a bounded number of frames
    const frames = await settle(rig);
    expect(frames).toBeLessThanOrEqual(80);
    expect(rig.controller.dynamic.diagnostics().deferredRoots).toBe(0);
  });

  it('the work per slice stays inside the slice budget however long the stream runs', async () => {
    const rig = start('<main></main>', 16);
    for (let frame = 0; frame < 40; frame += 1) {
      append(host(frame, 8, 8));
      await microtasks();
      rig.scheduler.runFrame();
    }
    const diag = rig.controller.dynamic.diagnostics();
    // every pass looked at no more than the slice budget plus the one region it always takes
    expect(diag.elementsProcessed / Math.max(1, diag.incrementalPasses)).toBeLessThanOrEqual(
      16 + 16,
    );
  });
});

describe('failure inside a slice', () => {
  it('an exception surfaces, the pipeline is not left stuck, and the next change is handled', async () => {
    const rig = start('<main></main>', 8);
    append(host(0, 6, 12));
    await microtasks();
    const real = rig.controller.incremental.update.bind(rig.controller.incremental);
    let failed = false;
    rig.controller.incremental.update = (input) => {
      if (!failed) {
        failed = true;
        throw new Error('boom');
      }
      return real(input);
    };
    expect(() => rig.scheduler.runFrame()).toThrow('boom');
    expect(rig.controller.dynamic.diagnostics().state).toBe('IDLE');

    append(host(1, 6, 12));
    await settle(rig);
    // the second burst is adapted; nothing is waiting for a retry that will never come
    expect(document.querySelectorAll('[data-host="1"] [data-coloradapt-s]').length).toBeGreaterThan(
      0,
    );
    expect(rig.controller.dynamic.diagnostics().queuedRecords).toBe(0);
    expect(rig.scheduler.pending).toBe(0);
  });
});

describe('slice diagnostics', () => {
  it('count slices and time them with the injected clock', async () => {
    let tick = 0;
    document.head.innerHTML = `<style>${CSS}</style>`;
    document.body.innerHTML = '<main></main>';
    const scheduler = createManualScheduler();
    const controller = createDynamicContentController(
      document,
      { now: () => 0, sliceElements: 4 },
      { scheduler, now: () => (tick += 5) },
      { env: simulatedBrowser(document) },
    );
    controller.enableAdaptation(URL, DEUTAN);
    current = { controller, scheduler };
    append(Array.from({ length: 6 }, (_v, i) => host(i, 4, 11)).join(''));
    await settle(current);
    const diag = controller.dynamic.diagnostics();
    expect(diag.slices).toBe(diag.batches);
    expect(diag.slices).toBeGreaterThan(1);
    expect(diag.maxSliceMs).toBeGreaterThan(0);
    expect(diag.totalSliceMs).toBeGreaterThanOrEqual(diag.maxSliceMs);
  });
});
