import { expect, test, type Page } from '@playwright/test';
import {
  launchExtension,
  startPageServer,
  type ExtensionSession,
  type PageServer,
} from './harness';
import { load } from './r1-kit';
import { INITIAL_CUES, SETTINGS, cues } from './semantic-kit';

/**
 * M6.R1 in a real browser, part 3: dynamic peers. Whether color is the only difference between
 * two elements depends on both, so a change to (or the removal of) one must re-examine the other;
 * and a page full of changing state must cost bounded, batched, loop-free work.
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

const BASE = Object.keys(INITIAL_CUES).length;

/** Puts `html` into the page's dynamic region (replacing what was there). */
const inject = (page: Page, html: string) =>
  page.evaluate((markup) => {
    document.getElementById('rows')!.innerHTML = markup;
  }, html);

const cueCount = async (page: Page) => Object.keys(await cues(page)).length;

test.describe('M6.R1 peer invalidation in Chromium', () => {
  test('a peer removed: the badge it differed from loses its cue, and a dot keeps its (construction) cue', async () => {
    const { page, step } = await load(ext, server, 'semantic.html', SETTINGS);
    await inject(
      page,
      '<div id="pair"><span id="pa" class="badge success">P1</span><span id="pb" class="badge error">P2</span></div>' +
        '<div id="dots"><span id="pd1" class="status online"></span><span id="pd2" class="status offline"></span></div>',
    );
    await step();
    let now = await cues(page);
    expect(now['pa']).toBe('after:2713');
    expect(now['pb']).toBe('after:d7');
    expect(now['pd1']).toMatch(/^inner:2713/);

    await page.evaluate(() => {
      document.getElementById('pb')!.remove();
      document.getElementById('pd2')!.remove();
    });
    await step();
    now = await cues(page);
    expect(now['pa'], 'nothing left to be compared with').toBeUndefined();
    expect(now['pb']).toBeUndefined();
    expect(now['pd1'], 'a dot is color-only by construction').toMatch(/^inner:2713/);
    expect(await cueCount(page)).toBe(BASE + 1); // + the lone dot
  });

  test('a peer that changes state: only it is touched, the other one is re-evaluated', async () => {
    const { page, step } = await load(ext, server, 'semantic.html', SETTINGS);
    await inject(
      page,
      '<div id="pair"><span id="pa" class="badge success">P1</span><span id="pb" class="badge error">P2</span></div>',
    );
    await step();
    expect((await cues(page))['pa']).toBe('after:2713');

    await page.evaluate(() => (document.getElementById('pb')!.className = 'badge success'));
    await step();
    let now = await cues(page);
    expect(now['pa']).toBeUndefined();
    expect(now['pb']).toBeUndefined();

    await page.evaluate(() => (document.getElementById('pb')!.className = 'badge error'));
    await step();
    now = await cues(page);
    expect(now['pa']).toBe('after:2713');
    expect(now['pb']).toBe('after:d7');
  });

  test('selected A / unselected B -> selected B / unselected A: one pass, no stale underline', async () => {
    const { page, step, diag } = await load(ext, server, 'semantic.html', SETTINGS);
    expect((await cues(page))['tab1']).toBe('underline');
    const before = await diag();
    await page.evaluate(() => {
      document.getElementById('tab1')!.setAttribute('aria-selected', 'false');
      document.getElementById('tab2')!.setAttribute('aria-selected', 'true');
    });
    await step();
    const now = await cues(page);
    expect(now['tab1']).toBeUndefined();
    expect(now['tab2']).toBe('underline');
    const after = await diag();
    expect(after.incrementalPasses - before.incrementalPasses).toBe(1);
    expect(after.fullRescans).toBe(before.fullRescans);
    expect(await cueCount(page)).toBe(BASE);
  });

  test('insert, remove, reorder and replace keep exactly one correct cue per element', async () => {
    const { page, step } = await load(ext, server, 'semantic.html', SETTINGS);
    await inject(
      page,
      '<div id="box"><span id="za" class="badge success">A</span><span id="zb" class="badge error">B</span><span id="zc" class="badge">C</span></div>',
    );
    await step();
    const state = async () => {
      const now = await cues(page);
      return ['za', 'zb', 'zc', 'zb2', 'zd'].map((id) => `${id}:${now[id] ?? '-'}`).join(' ');
    };
    expect(await state()).toBe('za:after:2713 zb:after:d7 zc:- zb2:- zd:-');

    await page.evaluate(() =>
      document.getElementById('box')!.appendChild(document.getElementById('za')!),
    );
    await step();
    expect(await state()).toBe('za:after:2713 zb:after:d7 zc:- zb2:- zd:-');

    await page.evaluate(() => {
      const fresh = document.createElement('span');
      fresh.id = 'zb2';
      fresh.className = 'badge error';
      fresh.textContent = 'B2';
      document.getElementById('zb')!.replaceWith(fresh);
    });
    await step();
    expect(await state()).toBe('za:after:2713 zb:- zc:- zb2:after:d7 zd:-');

    await page.evaluate(() => {
      const d = document.createElement('span');
      d.id = 'zd';
      d.className = 'badge error';
      d.textContent = 'D';
      document.getElementById('box')!.insertBefore(d, document.getElementById('zc'));
      document.getElementById('zb2')!.remove();
    });
    await step();
    expect(await state()).toBe('za:after:2713 zb:- zc:- zb2:- zd:after:d7');

    await page.evaluate(() => {
      document.getElementById('zd')!.remove();
      document.getElementById('zc')!.remove();
    });
    await step();
    expect(await state()).toBe('za:- zb:- zc:- zb2:- zd:-');
  });

  test('elements that are not peers are never compared, even when they share a parent', async () => {
    const { page, step } = await load(ext, server, 'semantic.html', SETTINGS);
    await inject(
      page,
      '<style>.chip{display:inline-block;padding:2px 8px;color:#fff;background:#c0392b}' +
        '.item{color:#555;text-decoration:none}.item.active{color:#0645ad}</style>' +
        '<div id="mix"><span id="x" class="badge success">X</span><span id="y" class="chip error">Y</span>' +
        '<ul class="main"><li><a id="m1" class="item active" aria-current="page" href="#">Home</a></li></ul>' +
        '<ul class="aside"><li><a id="m2" class="item" href="#">Docs</a></li></ul></div>',
    );
    await step();
    let now = await cues(page);
    expect(now['x']).toBeUndefined(); // the only other thing nearby is a chip
    expect(now['m1']).toBeUndefined(); // the other list is another component

    // The control: the same two items in the same kind of list ARE one component.
    await page.evaluate(() =>
      document
        .querySelector('#mix ul.main')!
        .appendChild(document.querySelector('#mix ul.aside li')!),
    );
    await step();
    now = await cues(page);
    expect(now['m1']).toBe('underline');
  });
});

test.describe('M6.R1 100 elements: flips, insertions, removals, reorders', () => {
  test('batched incremental work, no document scan, no duplicate and no stale cue', async () => {
    const { page, step, diag } = await load(ext, server, 'semantic.html', SETTINGS);
    await page.evaluate(() => window.sem.rows(100, 'online'));
    await step();
    expect(await cueCount(page)).toBe(BASE + 100);

    const counters = async () => {
      const d = await diag();
      return {
        passes: d.incrementalPasses,
        batches: d.batches,
        full: d.fullRescans,
        elements: d.elementsProcessed,
        candidates: d.semantic.semanticCandidates,
        searches: d.semantic.semanticPeerSearches,
        semanticPasses: d.semantic.semanticPasses,
        active: d.semantic.cuesActive,
      };
    };
    const dotCues = async () => {
      const now = await page.evaluate(() =>
        [...document.querySelectorAll('#rows .status')].map(
          (el) => el.getAttribute('data-coloradapt-cue') ?? '',
        ),
      );
      return now;
    };

    // 100 simultaneous flips
    let before = await counters();
    await page.evaluate(() => window.sem.flipRows('offline'));
    await step();
    let after = await counters();
    expect(after.passes - before.passes).toBe(1);
    expect(after.full).toBe(before.full);
    expect((await dotCues()).every((cue) => cue.startsWith('inner:d7'))).toBe(true);
    expect(after.active).toBe(BASE + 100);

    // 100 insertions in one go
    before = after;
    await page.evaluate(() => {
      const list = document.querySelector('#rows ul')!;
      for (let i = 0; i < 100; i += 1) {
        const li = document.createElement('li');
        li.innerHTML = `<span class="status online" id="n${i}"></span>new ${i}`;
        list.appendChild(li);
      }
    });
    await step();
    after = await counters();
    expect(after.passes - before.passes).toBe(1);
    expect(after.full).toBe(before.full);
    expect(after.active).toBe(BASE + 200);
    // The structural budget: nowhere near the whole document, and the peer searches are bounded.
    expect(after.candidates - before.candidates).toBeLessThanOrEqual(1500 + 400);
    expect(after.searches - before.searches).toBeLessThanOrEqual(300);

    // 100 reorders: every item moves to the front, one by one
    before = after;
    await page.evaluate(() => {
      const list = document.querySelector('#rows ul')!;
      for (let i = 0; i < 100; i += 1)
        list.insertBefore(list.lastElementChild!, list.firstElementChild);
    });
    await step();
    after = await counters();
    expect(after.full).toBe(before.full);
    expect(after.active).toBe(BASE + 200);

    // 100 removals
    before = after;
    await page.evaluate(() => {
      for (let i = 0; i < 100; i += 1) document.getElementById(`n${i}`)!.parentElement!.remove();
    });
    await step();
    after = await counters();
    // Dots hold no color rule, so nothing for M3 to do: the semantic layer alone re-examines the
    // peers (no incremental pass of its own, but exactly one semantic pass for the whole batch).
    expect(after.passes - before.passes).toBeLessThanOrEqual(1);
    expect(after.semanticPasses - before.semanticPasses).toBe(1);
    expect(after.full).toBe(before.full);
    expect(after.active).toBe(BASE + 100);
    // One cue attribute per element, none on anything that is not a cue host.
    const total = await page.evaluate(
      () => document.querySelectorAll('[data-coloradapt-cue]').length,
    );
    expect(total).toBe(after.active);
  });
});

test.describe('M6.R1 counters, retention and self-mutation', () => {
  test('after a page settles the counters describe the page, and the cue rules are the cues in use', async () => {
    const { page, step, diag } = await load(ext, server, 'semantic.html', SETTINGS);
    await page.evaluate(() => window.sem.rows(40, 'offline'));
    await step();
    const d = (await diag()).semantic;
    expect(d.cuesActive).toBe(
      await page.evaluate(() => document.querySelectorAll('[data-coloradapt-cue]').length),
    );
    expect(d.cuesApplied - d.cuesRemoved).toBe(d.cuesActive);
    expect(d.cuesApplied + d.cuesNotApplied).toBe(d.cuesPlanned);
    expect(d.semanticClassified + d.semanticUnknown + d.semanticConflicts).toBe(
      d.semanticCandidates,
    );
    const rules = await page.evaluate(() => {
      const css = document.getElementById('coloradapt-stylesheet')?.textContent ?? '';
      const keys = new Set(
        [...document.querySelectorAll('[data-coloradapt-cue]')].map(
          (el) => el.getAttribute('data-coloradapt-cue') ?? '',
        ),
      );
      const ruled = new Set(
        [...css.matchAll(/\[data-coloradapt-cue="([^"]+)"\]/g)].map((m) => m[1] ?? ''),
      );
      return { keys: [...keys].sort(), ruled: [...ruled].sort() };
    });
    // Every cue in use has its rule, and a rule exists for nothing else.
    expect(rules.ruled.filter((key) => !rules.keys.includes(key))).toEqual([]);
    for (const key of rules.keys) expect(rules.ruled, key).toContain(key);
  });

  test('500 semantic components created, cued and removed, five cycles: nothing is left behind', async () => {
    const { page, step, diag } = await load(ext, server, 'semantic.html', SETTINGS);
    const baseline = await diag();
    for (let cycle = 0; cycle < 5; cycle += 1) {
      await page.evaluate(() => {
        const host = document.getElementById('rows')!;
        const html: string[] = [];
        for (let i = 0; i < 500; i += 1) {
          html.push(`<span class="badge ${i % 2 === 0 ? 'success' : 'error'}">Item ${i}</span>`);
        }
        host.innerHTML = html.join('');
      });
      await step();
      expect(await cueCount(page), `cycle ${cycle} cued`).toBeGreaterThan(BASE);
      await page.evaluate(() => document.getElementById('rows')!.replaceChildren());
      await step();
      const now = await diag();
      expect(await cueCount(page), `cycle ${cycle}`).toBe(BASE);
      expect(now.semantic.cuesActive).toBe(BASE);
      expect(now.queuedRecords).toBe(0);
      expect(now.deferredRoots).toBe(0);
      expect(now.pendingRescan).toBeNull();
      expect(now.trackedElements).toBe(baseline.trackedElements);
      expect(now.fullRescans).toBe(baseline.fullRescans);
    }
    // The cue rules of the removed cue kinds are gone with them (only the page's own cues remain).
    const kinds = await page.evaluate(() => {
      const css = document.getElementById('coloradapt-stylesheet')?.textContent ?? '';
      return (css.match(/\[data-coloradapt-cue="[^"]+"\]\{/g) ?? []).length;
    });
    const used = await page.evaluate(
      () =>
        new Set(
          [...document.querySelectorAll('[data-coloradapt-cue]')].map((el) =>
            el.getAttribute('data-coloradapt-cue'),
          ),
        ).size,
    );
    expect(kinds).toBeLessThanOrEqual(used + 4); // + the outline/underline helper rules that share a key line
  });

  test('cue add / remove / update x60: one semantic pass per real change, and a settled page does no work', async () => {
    const { page, step, diag, natural } = await load(ext, server, 'semantic.html', SETTINGS);
    for (let cycle = 0; cycle < 60; cycle += 1) {
      const before = (await diag()).semantic.semanticPasses;
      await page.evaluate(
        (flip) => {
          document.getElementById('tab1')!.setAttribute('aria-selected', String(flip));
          document.getElementById('tab2')!.setAttribute('aria-selected', String(!flip));
        },
        cycle % 2 === 1,
      );
      await step();
      const after = await diag();
      expect(after.semantic.semanticPasses - before, `cycle ${cycle}`).toBe(1);
      // The settled page: asking again does nothing.
      await step();
      expect((await diag()).semantic.semanticPasses, `cycle ${cycle} settled`).toBe(
        after.semantic.semanticPasses,
      );
    }
    expect(await cueCount(page)).toBe(BASE);
    // With the real scheduler and observer: no storm of our own making.
    const settled = await diag();
    for (let i = 0; i < 4; i += 1) await natural();
    const now = await diag();
    expect(now.batches).toBe(settled.batches);
    expect(now.semantic.semanticPasses).toBe(settled.semantic.semanticPasses);
    expect(now.queuedRecords).toBe(0);
    expect(now.state).toBe('IDLE');
  });
});
