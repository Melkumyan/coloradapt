import { expect, test, type Page } from '@playwright/test';
import {
  computedColors,
  disable,
  dynamicDiagnostics,
  enable,
  flushDynamic,
  hasStylesheet,
  launchExtension,
  refresh,
  settle,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';
import {
  expectConsistent,
  expectEquivalentToFullRescan,
  expectNoWork,
  load,
  ORIGINAL_BAD,
  rule,
  ruleTotal,
} from './r1-kit';

/**
 * M4.R1 sections 2, 3, 6, 7, 8, 9 and 11, real Chromium: self-mutation and
 * hostile-page attacks, budget boundaries, reentrancy, lifecycle, retention
 * proxies and the two scheduler paths. Deterministic: structural counters and
 * computed styles only.
 */
let server: PageServer;
let ext: ExtensionSession;

test.beforeAll(async () => {
  server = await startPageServer();
  ext = await launchExtension();
});
test.afterEach(async () => {
  await Promise.all(ext.context.pages().map((page) => page.close()));
});
test.afterAll(async () => {
  await ext.close();
  await server.close();
});

const blank = () => load(ext, server, 'r1-blank.html');

test.describe('R1-2. self-mutation / feedback-loop attack', () => {
  test('120 hostile cycles: every external mutation is bounded work, then silence', async () => {
    test.setTimeout(420_000);
    const { page, natural, diag } = await blank();
    const base = await diag();
    expect(base.rules).toBe(0);
    expect(await hasStylesheet(page)).toBe(false);

    const CYCLES = 120;
    const start = await diag();
    for (let i = 0; i < CYCLES; i += 1) {
      // 1. an external mutation creates the owned stylesheet and tags two elements
      await page.evaluate(
        (n) => document.getElementById('app')!.append(window.rows(`h${n}-`, 2)),
        i,
      );
      let d = await natural();
      expect(d, `cycle ${i} insert`).toMatchObject({
        incrementalPasses: 1,
        fullRescans: 0,
        rulesAdded: 2,
        stylesheetRepairs: 0,
        batches: 1,
      });
      expect(d.observerCallbacks).toBeLessThanOrEqual(2);

      // 2. the page deletes our stylesheet: repaired, no analysis
      await page.evaluate(() => document.getElementById('coloradapt-stylesheet')!.remove());
      d = await natural();
      expect(d, `cycle ${i} repair`).toMatchObject({
        incrementalPasses: 0,
        fullRescans: 0,
        stylesheetRepairs: 1,
      });
      expect(await hasStylesheet(page)).toBe(true);

      // 3. another external mutation after the recreation
      await page.evaluate(
        (n) => document.getElementById('app')!.append(window.rows(`k${n}-`, 1)),
        i,
      );
      d = await natural();
      expect(d, `cycle ${i} after recreation`).toMatchObject({
        incrementalPasses: 1,
        fullRescans: 0,
        rulesAdded: 1,
      });

      // 4. rule replacement: out and back in
      await page.evaluate((n) => (document.getElementById(`h${n}-0`)!.className = 'good'), i);
      d = await natural();
      expect(d, `cycle ${i} rule out`).toMatchObject({ incrementalPasses: 1, rulesRemoved: 1 });
      await page.evaluate((n) => (document.getElementById(`h${n}-0`)!.className = 'bad'), i);
      d = await natural();
      expect(d, `cycle ${i} rule in`).toMatchObject({ incrementalPasses: 1, rulesAdded: 1 });

      // 5. removal of the last rules: the stylesheet goes with them
      await page.evaluate(() => document.getElementById('app')!.replaceChildren());
      d = await natural();
      expect(d, `cycle ${i} removal`).toMatchObject({
        incrementalPasses: 1,
        rulesRemoved: 3,
        fullRescans: 0,
      });
      expect(await hasStylesheet(page)).toBe(false);
      expect((await diag()).rules).toBe(0);
    }

    // Nothing is left running: more frames, no further work.
    const end = await diag();
    await settle(page);
    await settle(page);
    await settle(page);
    const silent = await diag();
    expect(silent.incrementalPasses).toBe(end.incrementalPasses);
    expect(silent.mutationRecords).toBe(end.mutationRecords);
    expect(silent.observerCallbacks).toBe(end.observerCallbacks);
    expect(silent).toMatchObject({
      state: 'IDLE',
      queuedRecords: 0,
      deferredRoots: 0,
      pendingRescan: null,
      throttleTimerActive: false,
      rules: 0,
      trackedElements: base.trackedElements,
    });

    // Structural totals for the whole attack (the report records them).
    const total = (
      key:
        | 'incrementalPasses'
        | 'fullRescans'
        | 'stylesheetRepairs'
        | 'stylesheetRepairsDeferred'
        | 'batches'
        | 'observerCallbacks'
        | 'mutationRecords'
        | 'selfMutationsIgnored',
    ) => end[key] - start[key];
    expect(total('incrementalPasses')).toBe(5 * CYCLES);
    expect(total('fullRescans')).toBe(0);
    expect(total('stylesheetRepairs')).toBe(CYCLES);
    // Causal, not wall-clock: a repair that falls inside the 500 ms spacing is deferred to one timer,
    // and that timer costs exactly one extra batch. Whether a cycle was fast enough to be deferred is
    // timing; that each deferral costs exactly one batch, and at most one per repair, is the invariant.
    expect(total('stylesheetRepairsDeferred')).toBeLessThanOrEqual(CYCLES);
    expect(total('batches')).toBe(6 * CYCLES + total('stylesheetRepairsDeferred'));
    expect(total('observerCallbacks')).toBeLessThanOrEqual(12 * CYCLES);
    test.info().annotations.push({
      type: 'counters',
      description: `R1-2 totals over ${CYCLES} cycles: passes=${total('incrementalPasses')} rescans=${total('fullRescans')} repairs=${total('stylesheetRepairs')} deferred=${total('stylesheetRepairsDeferred')} batches=${total('batches')} observerCallbacks=${total('observerCallbacks')} records=${total('mutationRecords')} ownIgnored=${total('selfMutationsIgnored')}`,
    });
  });

  test('page writes to data-coloradapt-id are never delivered: no work, no loop; refresh reconciles', async () => {
    const { page, step, diag, natural } = await blank();
    await page.evaluate(() => document.getElementById('app')!.append(window.rows('t', 3)));
    await step();
    const tracked = (await diag()).trackedElements;

    const before = await diag();
    await page.evaluate(() => {
      const a = document.getElementById('t0')!;
      const b = document.getElementById('t1')!;
      b.setAttribute('data-coloradapt-id', a.getAttribute('data-coloradapt-id')!); // collision
      document.getElementById('t2')!.removeAttribute('data-coloradapt-id'); // erased
      document.getElementById('title')!.setAttribute('data-coloradapt-id', 'ca-forged'); // forged
      document.getElementById('title')!.setAttribute('data-coloradapt-flag', '1');
    });
    const delta = await step();
    expect(delta.mutationRecords).toBe(0);
    expectNoWork(delta);
    await settle(page);
    expect((await diag()).observerCallbacks).toBe(before.observerCallbacks);

    // The page fought with our private attribute: the incremental path does not repair that
    // (documented). A full refresh does.
    await refresh(ext.worker, page);
    await settle(page);
    await natural();
    await expectConsistent(page);
    for (const id of ['t0', 't1', 't2']) expect(await rule(page, id), id).toBe(true);
    expect((await diag()).trackedElements).toBe(tracked);
  });

  test('a page that keeps deleting our <style> costs bounded repairs, and the sheet returns when it stops', async () => {
    const { page, diag, natural } = await blank();
    await page.evaluate(() => document.getElementById('app')!.append(window.rows('f', 3)));
    await natural();
    const FRAMES = 90;
    const before = await diag();

    await page.evaluate(() => {
      const w = window as unknown as { fighter: MutationObserver };
      w.fighter = new MutationObserver(() =>
        document.getElementById('coloradapt-stylesheet')?.remove(),
      );
      w.fighter.observe(document.head, { childList: true });
      document.getElementById('coloradapt-stylesheet')!.remove(); // start the fight
    });
    await page.evaluate(
      (frames) =>
        new Promise<void>((resolve) => {
          let left = frames;
          const tick = () => (left-- > 0 ? requestAnimationFrame(tick) : resolve());
          tick();
        }),
      FRAMES,
    );
    const fighting = await diag();
    const repairs = fighting.stylesheetRepairs - before.stylesheetRepairs;
    // One repair per frame would be a livelock; the repairs are spaced out instead.
    expect(repairs).toBeLessThanOrEqual(1 + FRAMES / 4);
    expect(fighting.fullRescans).toBe(before.fullRescans);
    test.info().annotations.push({
      type: 'counters',
      description: `R1-3 repairs during ${FRAMES} frames of a style-deleting page: ${repairs}`,
    });

    await page.evaluate(() =>
      (window as unknown as { fighter: MutationObserver }).fighter.disconnect(),
    );
    await natural();
    await expect.poll(() => hasStylesheet(page)).toBe(true);
    await expectConsistent(page);
    expect(await ruleTotal(page)).toBe(3);
    expect((await computedColors(page, ['f0']))['f0']).not.toBe(ORIGINAL_BAD);
    const end = await diag();
    expect(end).toMatchObject({ state: 'IDLE', pendingRescan: null, throttleTimerActive: false });
  });
});

test.describe('R1-3. the page fights the extension (it mutates right after every ColorAdapt write)', () => {
  type Reaction = 'inline-important' | 'class-good' | 'delete-style' | 'move-and-clone';

  /** A page script that reacts, once per element, the moment ColorAdapt tags it with an id. */
  async function fight(page: Page, reaction: Reaction): Promise<void> {
    await page.evaluate((kind) => {
      const seen = new WeakSet<Element>();
      const react = (el: HTMLElement): void => {
        switch (kind) {
          case 'inline-important':
            el.style.setProperty('color', '#c0392b', 'important');
            break;
          case 'class-good':
            if (el.id === 'r1') el.className = 'good';
            break;
          case 'delete-style':
            document.getElementById('coloradapt-stylesheet')?.remove();
            break;
          case 'move-and-clone':
            if (el.id.startsWith('r') && !el.id.endsWith('-copy')) {
              const app = document.getElementById('app')!;
              app.append(el);
              const copy = el.cloneNode(true) as HTMLElement;
              copy.id = `${el.id}-copy`;
              app.append(copy);
            }
            break;
        }
      };
      new MutationObserver((records) => {
        for (const r of records) {
          const el = r.target as HTMLElement;
          if (!seen.has(el)) {
            seen.add(el);
            react(el);
          }
        }
      }).observe(document.documentElement, {
        attributes: true,
        subtree: true,
        attributeFilter: ['data-coloradapt-id'],
      });
    }, reaction);
  }

  const insert = (page: Page) =>
    page.evaluate(() => document.getElementById('app')!.append(window.rows('r', 4)));

  test('inline !important right after the write: the override wins, is detected (notApplied), and the page can recover it', async () => {
    const { page, natural, diag } = await blank();
    await fight(page, 'inline-important');
    await insert(page);
    const delta = await natural();
    expect(delta.incrementalPasses).toBeLessThanOrEqual(2);
    expect(delta.fullRescans).toBe(0);
    for (const id of ['r0', 'r3']) {
      expect(await rule(page, id), id).toBe(false); // cannot win: no stale rule
      expect((await computedColors(page, [id]))[id]).toBe(ORIGINAL_BAD);
    }
    await expectConsistent(page);
    expect((await diag()).rules).toBe(0);
    expect(await hasStylesheet(page)).toBe(false);

    // The page lets go of one element: it is adapted again by an incremental pass.
    await page.evaluate(() => document.getElementById('r1')!.style.removeProperty('color'));
    const recovered = await natural();
    expect(recovered.incrementalPasses).toBe(1);
    expect(await rule(page, 'r1')).toBe(true);
    expect((await computedColors(page, ['r1']))['r1']).not.toBe(ORIGINAL_BAD);
    expect(await rule(page, 'r2')).toBe(false);
    await expectConsistent(page);
    await expectEquivalentToFullRescan(ext, page);
  });

  test('page removes the inline style / changes the class right after the write', async () => {
    const { page, natural } = await blank();
    await page.evaluate(() => {
      document.getElementById('app')!.append(window.rows('s', 2));
    });
    await natural();
    await fight(page, 'class-good');
    await insert(page);
    await natural();
    expect(await rule(page, 'r0')).toBe(true);
    expect(await rule(page, 'r1')).toBe(false); // the page switched it to an accessible class
    expect((await computedColors(page, ['r1']))['r1']).toBe('rgb(0, 0, 0)');
    await expectConsistent(page);
    await expectEquivalentToFullRescan(ext, page);
  });

  test('page replaces every adapted node right after the write: no stale rule survives', async () => {
    const { page, natural, diag } = await blank();
    // each node is replaced by its clone (which still carries the old id attribute), three times over
    await page.evaluate(() => {
      const budget = { n: 3 };
      new MutationObserver((records) => {
        for (const r of records) {
          const el = r.target as HTMLElement;
          if (budget.n > 0 && el.id.startsWith('r') && el.isConnected) {
            budget.n -= 1;
            el.replaceWith(el.cloneNode(true));
          }
        }
      }).observe(document.documentElement, {
        attributes: true,
        subtree: true,
        attributeFilter: ['data-coloradapt-id'],
      });
    });
    await insert(page);
    const delta = await natural();
    expect(delta.fullRescans).toBe(0);
    expect(delta.incrementalPasses).toBeLessThanOrEqual(6);
    await expectConsistent(page);
    expect(await ruleTotal(page)).toBe(4);
    expect((await diag()).rules).toBe(4);
    await expectEquivalentToFullRescan(ext, page);
  });

  test('page deletes our <style> right after the write: repaired, converged', async () => {
    const { page, natural } = await blank();
    await fight(page, 'delete-style');
    await insert(page);
    const delta = await natural();
    await expect.poll(() => hasStylesheet(page)).toBe(true);
    expect(delta.stylesheetRepairs).toBeGreaterThanOrEqual(1);
    expect(delta.stylesheetRepairs).toBeLessThanOrEqual(4);
    expect(await ruleTotal(page)).toBe(4);
    await expectConsistent(page);
  });

  test('page moves and clones every adapted node right after the write', async () => {
    const { page, natural } = await blank();
    await fight(page, 'move-and-clone');
    await insert(page);
    const delta = await natural();
    expect(delta.fullRescans).toBe(0);
    expect(delta.incrementalPasses).toBeLessThanOrEqual(4);
    await expectConsistent(page);
    expect(await ruleTotal(page)).toBe(8); // four originals, four clones: one rule each
    for (const id of ['r0', 'r0-copy', 'r3', 'r3-copy'])
      expect(await rule(page, id), id).toBe(true);
    await expectEquivalentToFullRescan(ext, page);
  });
});

test.describe('R1-6. budget boundaries', () => {
  async function fresh() {
    const loaded = await blank();
    return loaded;
  }

  for (const [roots, rescan] of [
    [511, false],
    [512, false],
    [513, true],
  ] as const) {
    test(`affected roots ${roots}: ${rescan ? 'one too-many-roots rescan' : 'one incremental pass'}`, async () => {
      const { page, step } = await fresh();
      await page.evaluate((n) => window.appendEach('b', n), roots);
      const delta = await step();
      if (rescan) {
        expect(delta.fullRescansByReason).toEqual({ 'too-many-roots': 1 });
        expect(delta.incrementalPasses).toBe(0);
      } else {
        expect(delta.incrementalPasses).toBe(1);
        expect(delta.fullRescans).toBe(0);
        expect(delta.affectedRoots).toBe(roots);
        expect(delta.elementsProcessed).toBe(roots);
      }
      expect(delta.rootsDeferred).toBe(0);
      expect(await ruleTotal(page)).toBe(roots);
      await expectConsistent(page);
    });
  }

  for (const [records, overflow] of [
    [4999, false],
    [5000, false],
    [5001, true],
  ] as const) {
    test(`queued mutation records ${records}: ${overflow ? 'queue-overflow rescan' : 'incremental'}`, async () => {
      const { page, step, diag } = await fresh();
      await page.evaluate(() => document.getElementById('app')!.append(window.rows('q', 1)));
      await step();
      await page.evaluate((n) => {
        const el = document.getElementById('q0')!;
        for (let i = 0; i < n; i += 1) el.className = `bad c${i}`;
        el.className = 'bad';
      }, records - 1); // `records - 1` flips + the final reset = `records` records
      const delta = await step();
      expect(delta.mutationRecords - delta.selfMutationsIgnored).toBe(records);
      if (overflow) {
        expect(delta.queueOverflows).toBe(1);
        expect(delta.fullRescansByReason).toEqual({ 'queue-overflow': 1 });
        expect(delta.incrementalPasses).toBe(0);
      } else {
        expect(delta.queueOverflows).toBe(0);
        expect(delta.fullRescans).toBe(0);
        // net change of the element's classes is nothing: one batch, no analysis needed
        expect(delta.batches).toBe(1);
      }
      expect(await rule(page, 'q0')).toBe(true);
      expect((await diag()).queuedRecords).toBe(0);
      await expectConsistent(page);
    });
  }

  for (const [count, truncated] of [
    [1499, false],
    [1500, false],
    [1501, true],
  ] as const) {
    test(`analyzer elements ${count} in one root: ${truncated ? 'truncated at 1500' : 'complete'}`, async () => {
      const { page, step } = await fresh();
      await page.evaluate((n) => window.appendBig('big', n), count);
      const delta = await step();
      expect(delta.incrementalPasses).toBe(1);
      expect(delta.affectedRoots).toBe(1);
      expect(delta.truncatedPasses).toBe(truncated ? 1 : 0);
      expect(delta.elementsProcessed).toBe(Math.min(count, 1500));
      const adapted = Math.min(count, 1500);
      expect(await ruleTotal(page)).toBe(adapted);
      expect(await rule(page, `big-${adapted - 1}`)).toBe(true);
      expect(await rule(page, `big-${count - 1}`)).toBe(count <= 1500);
      expect(delta.rootsDeferred).toBe(0);
      await expectConsistent(page);
    });
  }

  test('several roots over the element budget: unstarted roots are requeued, a straddling root is retried whole, all complete', async () => {
    const { page, step, natural, diag } = await fresh();
    // four sibling roots of 600 candidates (2400 > 1500)
    await page.evaluate(() => {
      for (let r = 0; r < 4; r += 1) window.appendBig(`root${r}`, 600);
    });
    const firstDiag = await diag();
    void firstDiag;
    const delta = await natural();
    expect(delta.incrementalPasses).toBe(2);
    expect(delta.truncatedPasses).toBe(0); // no root was cut: the straddling one was retried whole
    expect(delta.rootsDeferred).toBeGreaterThanOrEqual(1);
    expect(delta.fullRescans).toBe(0);
    expect(await ruleTotal(page)).toBe(2400);
    for (let r = 0; r < 4; r += 1)
      expect(await rule(page, `root${r}-599`), `root${r} tail`).toBe(true);
    expect((await diag()).deferredRoots).toBe(0);
    await expectConsistent(page);
    void step;
  });

  test('no starvation: three roots that each exceed the budget are consumed one per pass', async () => {
    const { page, natural, diag } = await fresh();
    await page.evaluate(() => {
      for (let r = 0; r < 3; r += 1) window.appendBig(`huge${r}`, 1600);
    });
    const delta = await natural();
    expect(delta.incrementalPasses).toBe(3); // at least one root progresses per pass
    expect(delta.truncatedPasses).toBe(3); // each is larger than the budget by itself (documented)
    expect(delta.rootsDeferred).toBeGreaterThanOrEqual(3);
    expect((await diag()).deferredRoots).toBe(0);
    expect(await ruleTotal(page)).toBe(4500); // 1500 of each root
    expect(await rule(page, 'huge0-0')).toBe(true);
    expect(await rule(page, 'huge2-1499')).toBe(true);
    expect(await rule(page, 'huge2-1500')).toBe(false); // the documented truncated tail
  });
});

test.describe('R1-7. reentrancy: the page mutates while a pass is RUNNING', () => {
  test('IDLE -> SCHEDULED -> RUNNING -> DIRTY -> later flush -> RUNNING -> IDLE, no overlap, nothing lost', async () => {
    const { page, natural, diag } = await blank();
    await page.evaluate(() => {
      window.installSpy(() => document.getElementById('app')!.append(window.rows('spawned', 1)));
      window.idLog.length = 0;
      document
        .getElementById('app')!
        .insertAdjacentHTML('beforeend', '<x-spy id="spy" class="bad badge">spy</x-spy>');
    });
    const delta = await natural();
    expect(delta).toMatchObject({
      incrementalPasses: 2,
      fullRescans: 0,
      batches: 2,
      affectedRoots: 2,
      elementsProcessed: 2,
      rulesAdded: 2,
    });
    expect(delta.state).toBe('IDLE');
    expect(await rule(page, 'spy')).toBe(true);
    expect(await rule(page, 'spawned0')).toBe(true);

    // The two passes are separate flushes: the page sees their id writes in different deliveries.
    const log = await page.evaluate(() => window.idLog);
    const spy = log.find((e) => e.id === 'spy')!;
    const spawned = log.find((e) => e.id === 'spawned0')!;
    expect(spawned.delivery).toBeGreaterThan(spy.delivery);
    expect((await diag()).queuedRecords).toBe(0);
    await expectConsistent(page);
  });

  test('burst: 25 spies spawn 25 rows mid-pass; still two separate passes and nothing lost', async () => {
    const { page, natural } = await blank();
    await page.evaluate(() => {
      window.installSpy((spy) =>
        document.getElementById('app')!.append(window.rows(`from-${spy.id}-`, 1)),
      );
      const app = document.getElementById('app')!;
      for (let i = 0; i < 25; i += 1) {
        app.insertAdjacentHTML('beforeend', `<x-spy id="sp${i}" class="bad badge">spy</x-spy>`);
      }
    });
    const delta = await natural();
    expect(delta.incrementalPasses).toBe(2);
    expect(delta.batches).toBe(2);
    expect(delta.affectedRoots).toBe(50);
    expect(await ruleTotal(page)).toBe(50);
    expect(await rule(page, 'from-sp24-0')).toBe(true);
    expect(delta.state).toBe('IDLE');
    await expectConsistent(page);
  });

  test('forced flush: the spawned work is handled by a second flush inside the same call', async () => {
    const { page, step } = await blank();
    await page.evaluate(() => {
      window.installSpy(() => document.getElementById('app')!.append(window.rows('spawned', 1)));
      document
        .getElementById('app')!
        .insertAdjacentHTML('beforeend', '<x-spy id="spy" class="bad badge">spy</x-spy>');
    });
    const delta = await step();
    expect(delta).toMatchObject({ incrementalPasses: 2, batches: 2, rulesAdded: 2 });
    expect(delta.state).toBe('IDLE');
  });

  test('a chain of five spawns resolves in five sequential passes, never nested', async () => {
    const { page, natural } = await blank();
    await page.evaluate(() => {
      let depth = 0;
      window.installSpy(() => {
        depth += 1;
        if (depth < 5) {
          document
            .getElementById('app')!
            .insertAdjacentHTML(
              'beforeend',
              `<x-spy id="sp${depth}" class="bad badge">spy</x-spy>`,
            );
        }
      });
      window.idLog.length = 0;
      document
        .getElementById('app')!
        .insertAdjacentHTML('beforeend', '<x-spy id="sp0" class="bad badge">spy</x-spy>');
    });
    const delta = await natural();
    expect(delta.incrementalPasses).toBe(5);
    expect(await ruleTotal(page)).toBe(5);
    const log = await page.evaluate(() => window.idLog);
    const deliveries = log.map((e) => e.delivery);
    expect(new Set(deliveries).size).toBe(5); // one delivery (one pass) per link of the chain
    expect(deliveries).toEqual([...deliveries].sort((a, b) => a - b));
    await expectConsistent(page);
  });
});

test.describe('R1-8. OFF / ON lifecycle', () => {
  test('ON, mutation, OFF, mutations while OFF, ON, mutation, OFF, ON', async () => {
    const { page, step, diag } = await blank();
    const base = await diag();
    expect(base.observerStarts).toBe(1);

    await page.evaluate(() => document.getElementById('app')!.append(window.rows('a', 2)));
    expect((await step()).incrementalPasses).toBe(1);

    await disable(ext.worker, page);
    const off = await diag();
    expect(off).toMatchObject({
      state: 'STOPPED',
      queuedRecords: 0,
      pendingLinks: 0,
      deferredRoots: 0,
      rules: 0,
      trackedElements: 0,
    });
    expect(await hasStylesheet(page)).toBe(false);

    await page.evaluate(() => {
      document.getElementById('app')!.append(window.rows('off', 3));
      document.getElementById('a0')!.className = 'good';
    });
    await settle(page);
    const whileOff = await flushDynamic(ext.worker, page);
    expect(whileOff.mutationRecords).toBe(off.mutationRecords); // not delivered, not queued
    expect(whileOff.observerCallbacks).toBe(off.observerCallbacks);
    expect(whileOff.queuedRecords).toBe(0);
    expect(whileOff.state).toBe('STOPPED');
    expect(await hasStylesheet(page)).toBe(false);

    await enable(ext.worker, page); // ON: a full synchronization sees the page as it is now
    await settle(page);
    const on = await diag();
    expect(on.observerStarts).toBe(2);
    expect(await rule(page, 'off0')).toBe(true);
    expect(await rule(page, 'a1')).toBe(true);
    expect(await rule(page, 'a0')).toBe(false); // changed while OFF
    expect(on.state).toBe('IDLE');

    await page.evaluate(() => document.getElementById('app')!.append(window.rows('on', 2)));
    const delta = await step();
    expect(delta.incrementalPasses).toBe(1); // exactly one observer, exactly one pass
    expect(delta.observerCallbacks).toBe(1);

    await disable(ext.worker, page);
    await enable(ext.worker, page);
    await page.evaluate(() => document.getElementById('app')!.append(window.rows('again', 2)));
    const again = await step();
    expect(again.incrementalPasses).toBe(1);
    expect(again.observerCallbacks).toBe(1);
    await expectConsistent(page);
    await expectEquivalentToFullRescan(ext, page);
  });

  test('100 ON/OFF cycles: one observer start per ON, no stacking, clean diagnostics', async () => {
    test.setTimeout(240_000);
    const { page, step, diag } = await blank();
    await page.evaluate(() => document.getElementById('app')!.append(window.rows('c', 3)));
    await step();
    const before = await diag();

    for (let i = 0; i < 100; i += 1) {
      await disable(ext.worker, page);
      await enable(ext.worker, page);
    }
    await settle(page);
    const after = await diag();
    expect(after.observerStarts - before.observerStarts).toBe(100);
    expect(after).toMatchObject({
      state: 'IDLE',
      queuedRecords: 0,
      deferredRoots: 0,
      pendingLinks: 0,
      pendingRescan: null,
      throttleTimerActive: false,
    });
    expect(after.rules).toBe(3);
    expect(after.trackedElements).toBe(before.trackedElements);
    expect(after.stylesheetRepairs).toBe(before.stylesheetRepairs);

    await page.evaluate(() => document.getElementById('app')!.append(window.rows('post', 2)));
    const delta = await step();
    expect(delta.incrementalPasses).toBe(1); // 100 cycles later: still exactly one subscription
    expect(delta.observerCallbacks).toBe(1);
    expect(delta.rulesAdded).toBe(2);
    await expectConsistent(page);
  });

  test('the last OFF leaves nothing running: later page mutations cause no ColorAdapt work', async () => {
    const { page, diag } = await blank();
    await page.evaluate(() => document.getElementById('app')!.append(window.rows('x', 3)));
    await disable(ext.worker, page);
    const off = await diag();
    await page.evaluate(() => {
      document.getElementById('app')!.append(window.rows('later', 50));
      const style = document.createElement('style');
      style.textContent = '.later { color: red }';
      document.head.append(style);
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    await settle(page);
    await settle(page);
    const after = await diag();
    expect(after).toEqual(off); // every counter and gauge untouched
    expect(await hasStylesheet(page)).toBe(false);
    // no new element was tagged after the last OFF (the old ids stay, as in M3)
    expect(
      await page.evaluate(
        () => document.querySelectorAll('[id^="later"][data-coloradapt-id]').length,
      ),
    ).toBe(0);
  });
});

test.describe('R1-9. memory / retention proxies', () => {
  test('5000 nodes created, adapted and removed in cycles: bookkeeping returns to baseline', async () => {
    test.setTimeout(240_000);
    const { page, step, diag } = await blank();
    const base = await diag();
    expect(base).toMatchObject({ rules: 0, pendingLinks: 0, queuedRecords: 0, deferredRoots: 0 });

    for (let cycle = 0; cycle < 5; cycle += 1) {
      // one wrapper = one root (1000 sibling roots would be, by design, a too-many-roots rescan)
      await page.evaluate((c) => window.appendBig(`n${c}`, 1000), cycle);
      const added = await step();
      expect(added).toMatchObject({ incrementalPasses: 1, rulesAdded: 1000, fullRescans: 0 });
      expect((await diag()).trackedElements).toBe(base.trackedElements + 1000);

      // alternate how the nodes leave: wholesale replaceChildren, then parent removal
      await page.evaluate((c) => {
        const app = document.getElementById('app')!;
        if (c % 2 === 0) app.replaceChildren();
        else {
          const holder = document.createElement('section');
          holder.append(...app.childNodes);
          app.append(holder);
          holder.remove();
        }
      }, cycle);
      const removed = await step();
      expect(removed.rulesRemoved).toBe(1000);
      const d = await diag();
      expect(d).toMatchObject({
        rules: 0,
        trackedElements: base.trackedElements,
        pendingLinks: 0,
        queuedRecords: 0,
        deferredRoots: 0,
        pendingRescan: null,
        throttleTimerActive: false,
        state: 'IDLE',
      });
      expect(await hasStylesheet(page)).toBe(false);
    }
    expect(
      await page.evaluate(() => document.querySelectorAll('[data-coloradapt-id]').length),
    ).toBe(1); // only the <h1>
  });

  test('hundreds of pending links created and removed leave no listener behind', async () => {
    const { page, step, diag } = await blank();
    await page.evaluate(() => {
      for (let i = 0; i < 300; i += 1) {
        const link = document.createElement('link');
        link.id = `pl${i}`;
        link.rel = 'stylesheet';
        link.href = `/slow-ret${i % 6}.css`;
        document.head.append(link);
      }
    });
    await step();
    expect((await diag()).pendingLinks).toBe(300);
    await page.evaluate(() => {
      for (let i = 0; i < 300; i += 1) document.getElementById(`pl${i}`)!.remove();
    });
    await step();
    const d = await diag();
    expect(d.pendingLinks).toBe(0);
    for (let i = 0; i < 6; i += 1) server.release(`ret${i}`);
  });

  test('queue, roots and timers are empty once a flush completes', async () => {
    const { page, natural, diag } = await blank();
    await page.evaluate(() => {
      window.appendEach('e', 300);
      const s = document.createElement('style');
      s.textContent = '.nothing { color: #000 }';
      document.head.append(s);
    });
    await natural();
    expect(await diag()).toMatchObject({
      queuedRecords: 0,
      deferredRoots: 0,
      pendingLinks: 0,
      pendingRescan: null,
      throttleTimerActive: false,
      state: 'IDLE',
    });
  });
});

test.describe('R1-11. scheduler: visible (requestAnimationFrame) and hidden (setTimeout 0)', () => {
  test('visible page: the pipeline is flushed by requestAnimationFrame, before the next paint', async () => {
    const { page, natural } = await blank();
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
    // A page-side rAF callback registered after the mutation runs in the same frame, after
    // ColorAdapt's own: by then the content is already adapted (adapted before it is painted).
    const adaptedBeforePaint = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          document.getElementById('app')!.append(window.rows('v', 1));
          queueMicrotask(() =>
            requestAnimationFrame(() => {
              resolve(
                getComputedStyle(document.getElementById('v0')!).color !== 'rgb(192, 57, 43)',
              );
            }),
          );
        }),
    );
    expect(adaptedBeforePaint).toBe(true);
    await natural();
    expect(await rule(page, 'v0')).toBe(true);
  });

  test('hidden page: requestAnimationFrame is paused, the setTimeout(0) path still adapts', async () => {
    const { page, natural } = await blank();
    const other = await ext.context.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    const hidden = await page.evaluate(() => document.visibilityState);
    test.skip(
      hidden !== 'hidden',
      'NOT_VERIFIED: this Chromium build does not report background tabs as hidden',
    );
    // rAF really is paused for this page (so only the timeout path can have run).
    const rafRan = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          requestAnimationFrame(() => resolve(true));
          setTimeout(() => resolve(false), 300);
        }),
    );
    expect(rafRan).toBe(false);

    await page.evaluate(() => document.getElementById('app')!.append(window.rows('hid', 2)));
    await expect
      .poll(async () => (await dynamicDiagnostics(ext.worker, page)).incrementalPasses)
      .toBe(1);
    expect(await rule(page, 'hid0')).toBe(true);
    await page.bringToFront();
    await natural();
    expect(await rule(page, 'hid1')).toBe(true);
  });
});
