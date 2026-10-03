import { afterEach, describe, expect, it } from 'vitest';
import { createDynamicContentController } from '@features/dynamic-analysis';
import {
  CONFLICT_STYLE,
  DEUTAN,
  FINE_STYLE,
  createManualScheduler,
  html,
  isAdapted,
  microtasks,
  ruleCount,
  sheetRuleIds,
} from './helpers';

let current: ReturnType<typeof createDynamicContentController> | null = null;

function setup(markup: string, options: { now?: () => number; head?: string } = {}) {
  document.head.innerHTML = options.head ?? '';
  html(markup);
  const scheduler = createManualScheduler();
  const controller = createDynamicContentController(
    document,
    { now: () => 0 },
    { scheduler, now: options.now },
  );
  current = controller;
  const initial = controller.enableAdaptation('https://example.com', DEUTAN);
  return { controller, scheduler, dynamic: controller.dynamic, initial };
}

function el(tag: string, attrs: Record<string, string>, text = ''): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.textContent = text;
  return node;
}

const conflictP = (id: string) => el('p', { id, style: CONFLICT_STYLE }, id);
const byId = (id: string) => document.getElementById(id)!;

afterEach(() => {
  current?.dynamic.dispose();
  current?.disableAdaptation();
  current = null;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('added nodes', () => {
  it('adapts a conflicting node added later and analyzes only the new subtree', () => {
    const { dynamic } = setup(`<div id="host"></div><p id="old" style="${CONFLICT_STYLE}">old</p>`);
    expect(ruleCount()).toBe(1);

    byId('host').appendChild(conflictP('fresh'));
    const diag = dynamic.flush();

    expect(isAdapted(byId('fresh'))).toBe(true);
    expect(ruleCount()).toBe(2);
    expect(diag.incrementalPasses).toBe(1);
    expect(diag.fullRescans).toBe(0);
    expect(diag.elementsProcessed).toBe(1);
    expect(diag.rulesAdded).toBe(1);
  });

  it('leaves an accessible node unchanged', () => {
    const { dynamic } = setup('<div id="host"></div>');
    byId('host').appendChild(el('p', { id: 'ok', style: FINE_STYLE }, 'fine'));

    const diag = dynamic.flush();

    expect(isAdapted(byId('ok'))).toBe(false);
    expect(ruleCount()).toBe(0);
    expect(diag.rulesAdded).toBe(0);
    expect(diag.incrementalPasses).toBe(1);
  });

  it('analyzes the whole added subtree, not just its root', () => {
    const { dynamic } = setup('<div id="host"></div>');
    const card = el('div', { id: 'card' });
    card.append(conflictP('a'), conflictP('b'));
    byId('host').appendChild(card);

    dynamic.flush();

    expect(isAdapted(byId('a'))).toBe(true);
    expect(isAdapted(byId('b'))).toBe(true);
  });

  it('does not re-analyze existing siblings when content is appended', () => {
    const rows = Array.from(
      { length: 20 },
      (_, i) => `<p id="r${i}" style="${CONFLICT_STYLE}">r</p>`,
    );
    const { dynamic } = setup(`<div id="list">${rows.join('')}</div>`);
    expect(ruleCount()).toBe(20);

    byId('list').appendChild(conflictP('r20'));
    const diag = dynamic.flush();

    expect(diag.elementsProcessed).toBe(1);
    expect(diag.fullRescans).toBe(0);
    expect(ruleCount()).toBe(21);
  });
});

describe('removed nodes', () => {
  it('drops the rule and bookkeeping of a removed adapted node', () => {
    const { dynamic, controller } = setup(
      `<p id="a" style="${CONFLICT_STYLE}">a</p><p id="b" style="${CONFLICT_STYLE}">b</p>`,
    );
    const idA = byId('a').getAttribute('data-coloradapt-id')!;
    expect(controller.incremental.trackedCount()).toBe(2);

    byId('a').remove();
    const diag = dynamic.flush();

    expect(sheetRuleIds()).not.toContain(idA);
    expect(ruleCount()).toBe(1);
    expect(controller.incremental.trackedCount()).toBe(1);
    expect(diag.rulesRemoved).toBe(1);
    expect(diag.fullRescans).toBe(0);
  });

  it('removes every adapted descendant of a removed container', () => {
    const { dynamic, controller } = setup(
      `<div id="box"><p style="${CONFLICT_STYLE}">1</p><p style="${CONFLICT_STYLE}">2</p></div>`,
    );
    expect(ruleCount()).toBe(2);

    byId('box').remove();
    dynamic.flush();

    expect(ruleCount()).toBe(0);
    expect(controller.incremental.trackedCount()).toBe(0);
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
  });

  it('keeps a node that was moved (removed and re-added) adapted', () => {
    const { dynamic } = setup(
      `<div id="one"><p id="p" style="${CONFLICT_STYLE}">x</p></div><div id="two"></div>`,
    );
    byId('two').appendChild(byId('p'));

    dynamic.flush();

    expect(isAdapted(byId('p'))).toBe(true);
    expect(ruleCount()).toBe(1);
  });

  it('forgets nodes that were added and removed within the same batch', () => {
    const { dynamic, controller } = setup('<div id="host"></div>');
    const temp = conflictP('temp');
    byId('host').appendChild(temp);
    temp.remove();

    const diag = dynamic.flush();

    expect(ruleCount()).toBe(0);
    expect(controller.incremental.trackedCount()).toBe(0);
    expect(diag.elementsProcessed).toBe(0);
  });
});

describe('replacement (React/Vue style)', () => {
  it('replaceWith: old rule removed, new node adapted, exactly one rule', () => {
    const { dynamic } = setup(`<div id="host"><p id="v1" style="${CONFLICT_STYLE}">v1</p></div>`);
    const oldId = byId('v1').getAttribute('data-coloradapt-id')!;

    byId('v1').replaceWith(conflictP('v2'));
    dynamic.flush();

    expect(sheetRuleIds()).not.toContain(oldId);
    expect(isAdapted(byId('v2'))).toBe(true);
    expect(ruleCount()).toBe(1);
  });

  it('replaceChildren re-renders a whole subtree without leaking rules', () => {
    const { dynamic, controller } = setup(
      `<div id="host"><p style="${CONFLICT_STYLE}">1</p><p style="${CONFLICT_STYLE}">2</p></div>`,
    );
    for (let round = 0; round < 5; round += 1) {
      byId('host').replaceChildren(conflictP(`n${round}a`), conflictP(`n${round}b`));
      dynamic.flush();
      expect(ruleCount()).toBe(2);
      expect(controller.incremental.trackedCount()).toBe(2);
    }
    expect(dynamic.diagnostics().fullRescans).toBe(0);
  });

  it('a cloned adapted element gets an id of its own (no shared rule)', () => {
    const { dynamic } = setup(`<div id="host"><p id="orig" style="${CONFLICT_STYLE}">x</p></div>`);
    const clone = byId('orig').cloneNode(true) as HTMLElement;
    clone.id = 'copy';
    byId('host').appendChild(clone);

    dynamic.flush();

    const ids = [byId('orig'), clone].map((n) => n.getAttribute('data-coloradapt-id'));
    expect(new Set(ids).size).toBe(2);
    expect(ruleCount()).toBe(2);
  });
});

describe('attribute changes', () => {
  const CSS = `<style>
    .bad { color: #c0392b; background-color: #27ae60; }
    .good { color: #000000; background-color: #ffffff; }
  </style>`;

  it('class change re-analyzes the element: adapted -> fine -> adapted', () => {
    const { dynamic } = setup(`<p id="t" class="bad">text</p>`, { head: CSS });
    expect(isAdapted(byId('t'))).toBe(true);

    byId('t').className = 'good';
    dynamic.flush();
    expect(isAdapted(byId('t'))).toBe(false);
    expect(ruleCount()).toBe(0);

    byId('t').className = 'bad';
    dynamic.flush();
    expect(isAdapted(byId('t'))).toBe(true);
    expect(ruleCount()).toBe(1);
    expect(dynamic.diagnostics().fullRescans).toBe(0);
  });

  it('updating the same element 100 times leaves one current rule', () => {
    const { dynamic } = setup(`<p id="t" class="bad">text</p>`, { head: CSS });
    for (let i = 0; i < 100; i += 1) {
      byId('t').className = i % 2 === 0 ? 'good' : 'bad';
      dynamic.flush();
    }
    // 100 flips ending on 'bad'.
    expect(ruleCount()).toBeLessThanOrEqual(1);
    expect(sheetRuleIds().length).toBe(new Set(sheetRuleIds()).size);
    expect(document.querySelectorAll('#coloradapt-stylesheet').length).toBeLessThanOrEqual(1);
  });

  it('rapid class changes in one frame cost one pass and use the final state', () => {
    const { dynamic } = setup(`<p id="t" class="good">text</p>`, { head: CSS });
    const t = byId('t');
    t.className = 'bad';
    t.className = 'good';
    t.className = 'bad';
    t.className = 'bad extra';

    const diag = dynamic.flush();

    expect(diag.incrementalPasses).toBe(1);
    expect(isAdapted(t)).toBe(true);
  });

  it('a class change that nets out to nothing triggers no pass', () => {
    const { dynamic } = setup(`<p id="t" class="good">text</p>`, { head: CSS });
    const t = byId('t');
    t.className = 'bad';
    t.className = 'good';

    const diag = dynamic.flush();

    expect(diag.incrementalPasses).toBe(0);
    expect(isAdapted(t)).toBe(false);
  });

  it('ignores attributes ColorAdapt does not care about', () => {
    const { dynamic } = setup(`<p id="t" style="${CONFLICT_STYLE}">text</p>`);
    byId('t').setAttribute('data-foo', '1');
    byId('t').setAttribute('tabindex', '0');
    byId('t').style.transform = 'translateX(3px)';

    const diag = dynamic.flush();

    expect(diag.incrementalPasses).toBe(0);
    expect(diag.fullRescans).toBe(0);
  });

  it('hidden: display none removes the rule, display block brings it back', () => {
    const { dynamic } = setup(`<p id="t" style="${CONFLICT_STYLE}">text</p>`);
    expect(isAdapted(byId('t'))).toBe(true);

    byId('t').style.display = 'none';
    dynamic.flush();
    expect(ruleCount()).toBe(0);

    byId('t').style.display = 'block';
    dynamic.flush();
    expect(isAdapted(byId('t'))).toBe(true);
  });

  it('the hidden attribute is handled the same way', () => {
    const { dynamic } = setup(`<p id="t" style="${CONFLICT_STYLE}">text</p>`);
    byId('t').hidden = true;
    byId('t').style.display = 'none';
    dynamic.flush();
    expect(ruleCount()).toBe(0);
    byId('t').hidden = false;
    byId('t').style.display = '';
    dynamic.flush();
    expect(isAdapted(byId('t'))).toBe(true);
  });

  it('disabled state changes update eligibility (disabled controls are skipped)', () => {
    const { dynamic } = setup(`<button id="b" style="${CONFLICT_STYLE}">Go</button>`);
    expect(isAdapted(byId('b'))).toBe(true);

    byId('b').setAttribute('disabled', '');
    dynamic.flush();
    expect(isAdapted(byId('b'))).toBe(false);

    byId('b').removeAttribute('disabled');
    dynamic.flush();
    expect(isAdapted(byId('b'))).toBe(true);
  });
});

describe('ancestor changes (bounded subtree invalidation)', () => {
  const CSS = `<style>
    .white { background-color: #ffffff; }
    .green { background-color: #27ae60; }
    .dim { opacity: 0.5; }
  </style>`;

  it('parent background white -> green re-adapts the child without a full scan', () => {
    const { dynamic } = setup(
      `<div id="parent" class="white"><span id="child" style="color:#c0392b">Hello</span></div>
       <p id="unrelated" style="${CONFLICT_STYLE}">other</p>`,
      { head: CSS },
    );
    expect(isAdapted(byId('child'))).toBe(false);

    byId('parent').className = 'green';
    const diag = dynamic.flush();

    expect(isAdapted(byId('child'))).toBe(true);
    expect(isAdapted(byId('unrelated'))).toBe(true);
    expect(diag.fullRescans).toBe(0);
    expect(diag.elementsProcessed).toBe(1);

    byId('parent').className = 'white';
    dynamic.flush();
    expect(isAdapted(byId('child'))).toBe(false);
  });

  it('parent inline style background change invalidates descendants', () => {
    const { dynamic } = setup(
      `<div id="parent" style="background-color:#ffffff"><span id="child" style="color:#c0392b">Hi</span></div>`,
    );
    byId('parent').style.backgroundColor = '#27ae60';
    dynamic.flush();
    expect(isAdapted(byId('child'))).toBe(true);
  });

  it('parent opacity change invalidates descendants', () => {
    const { dynamic } = setup(
      `<div id="parent" class="green"><span id="child" style="color:#c0392b">Hi</span></div>`,
      { head: CSS },
    );
    const before = ruleCount();
    byId('parent').classList.add('dim');
    const diag = dynamic.flush();
    expect(diag.incrementalPasses).toBe(1);
    expect(diag.elementsProcessed).toBe(1);
    // Under opacity the effective foreground differs from the computed color: fail-safe, no rule.
    expect(ruleCount()).toBeLessThanOrEqual(before);
  });

  it('a CSS variable change on an ancestor invalidates its subtree only', () => {
    const { dynamic } = setup(
      `<div id="a" style="--c:#ffffff"><span id="child" style="color:#c0392b">Hi</span></div><p id="other" style="${FINE_STYLE}">x</p>`,
    );
    byId('a').style.setProperty('--c', '#27ae60');
    const diag = dynamic.flush();
    expect(diag.incrementalPasses).toBe(1);
    expect(diag.fullRescans).toBe(0);
    expect(diag.elementsProcessed).toBe(1);
  });
});

describe('text changes', () => {
  it('empty text becoming non-empty makes an element eligible', () => {
    const { dynamic } = setup(`<p id="t" style="${CONFLICT_STYLE}"></p>`);
    expect(isAdapted(byId('t'))).toBe(false);

    byId('t').textContent = 'now has text';
    dynamic.flush();
    expect(isAdapted(byId('t'))).toBe(true);

    byId('t').textContent = '';
    dynamic.flush();
    expect(isAdapted(byId('t'))).toBe(false);
  });

  it('editing an existing text node via data only matters when it flips empty/non-empty', () => {
    const { dynamic } = setup(`<p id="t" style="${CONFLICT_STYLE}">hello</p>`);
    const text = byId('t').firstChild as Text;

    text.data = 'a different greeting';
    expect(dynamic.flush().incrementalPasses).toBe(0);

    text.data = '   ';
    expect(dynamic.flush().incrementalPasses).toBe(1);
    expect(isAdapted(byId('t'))).toBe(false);

    text.data = 'back';
    dynamic.flush();
    expect(isAdapted(byId('t'))).toBe(true);
  });
});

describe('stylesheets', () => {
  it('a page <style> added later triggers one full rescan', () => {
    const { dynamic } = setup(`<p id="t" class="x">text</p>`);
    expect(isAdapted(byId('t'))).toBe(false);

    const style = document.createElement('style');
    style.textContent = '.x { color: #c0392b; background-color: #27ae60; }';
    document.head.appendChild(style);
    const diag = dynamic.flush();

    expect(diag.fullRescans).toBe(1);
    expect(diag.fullRescansByReason.stylesheet).toBe(1);
    expect(isAdapted(byId('t'))).toBe(true);
  });

  it('text edits inside a page <style> trigger a full rescan', () => {
    const { dynamic } = setup(`<p id="t" class="x">text</p>`, {
      head: '<style id="pg">.x { color: #000; background-color: #fff; }</style>',
    });
    expect(isAdapted(byId('t'))).toBe(false);

    byId('pg').textContent = '.x { color: #c0392b; background-color: #27ae60; }';
    const diag = dynamic.flush();

    expect(diag.fullRescansByReason.stylesheet).toBe(1);
    expect(isAdapted(byId('t'))).toBe(true);
  });

  it('a <link rel=stylesheet> waits for its load event, then rescans once', () => {
    const { dynamic } = setup(`<p id="t">text</p>`);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://example.invalid/theme.css';
    document.head.appendChild(link);

    expect(dynamic.flush().fullRescans).toBe(0);

    link.dispatchEvent(new Event('load'));
    const diag = dynamic.flush();
    expect(diag.fullRescansByReason.stylesheet).toBe(1);

    // The listener is one-shot.
    link.dispatchEvent(new Event('load'));
    expect(dynamic.flush().fullRescans).toBe(1);
  });

  it('removing a page stylesheet rescans', () => {
    const { dynamic } = setup(`<p id="t" class="x">text</p>`, {
      head: '<style id="pg">.x { color: #c0392b; background-color: #27ae60; }</style>',
    });
    expect(isAdapted(byId('t'))).toBe(true);

    byId('pg').remove();
    const diag = dynamic.flush();

    expect(diag.fullRescansByReason.stylesheet).toBe(1);
    expect(isAdapted(byId('t'))).toBe(false);
  });

  it('a theme attribute switch on <html> is a full rescan', () => {
    const { dynamic } = setup(`<p id="t" class="x">text</p>`, {
      head: `<style>
        .x { color: #000; background-color: #fff; }
        html[data-theme="dark"] .x { color: #c0392b; background-color: #27ae60; }
      </style>`,
    });
    expect(isAdapted(byId('t'))).toBe(false);

    document.documentElement.setAttribute('data-theme', 'dark');
    const diag = dynamic.flush();

    expect(diag.fullRescansByReason['document-root']).toBe(1);
    expect(isAdapted(byId('t'))).toBe(true);
    document.documentElement.removeAttribute('data-theme');
  });

  it('other attributes on <html> are ignored', () => {
    const { dynamic } = setup(`<p id="t" style="${FINE_STYLE}">text</p>`);
    document.documentElement.setAttribute('data-scroll-lock', '1');
    document.documentElement.setAttribute('lang', 'de');
    expect(dynamic.flush().fullRescans).toBe(0);
    document.documentElement.removeAttribute('data-scroll-lock');
    document.documentElement.removeAttribute('lang');
  });
});

describe('self-mutation filtering and loop safety', () => {
  it('one external mutation yields one pass and then silence', async () => {
    const { dynamic, scheduler } = setup('<div id="host"></div>');
    byId('host').appendChild(conflictP('x'));

    await microtasks();
    expect(scheduler.pending).toBe(1);
    scheduler.runFrame();
    // Our own stylesheet writes must not schedule anything further.
    await microtasks();
    expect(scheduler.pending).toBe(0);
    await microtasks();
    scheduler.runFrame();

    const diag = dynamic.diagnostics();
    expect(diag.incrementalPasses).toBe(1);
    expect(diag.fullRescans).toBe(0);
    expect(diag.state).toBe('IDLE');
  });

  it('writing the targeting attribute or our style is never treated as page activity', async () => {
    const { dynamic, scheduler } = setup(`<p id="t" style="${CONFLICT_STYLE}">x</p>`);
    byId('t').setAttribute('data-coloradapt-id', 'ca-zzz');
    document.getElementById('coloradapt-stylesheet')!.textContent += '\n/* poke */';
    await microtasks();
    expect(scheduler.pending).toBe(0);
    expect(dynamic.diagnostics().incrementalPasses).toBe(0);
    expect(dynamic.diagnostics().selfMutationsIgnored).toBeGreaterThan(0);
  });

  it('an explicit analyze() (which rewrites our sheet) leaves nothing behind', async () => {
    const { controller, dynamic, scheduler } = setup(`<p id="t" style="${CONFLICT_STYLE}">x</p>`);
    controller.analyze('https://example.com', DEUTAN);
    await microtasks();
    expect(scheduler.pending).toBe(0);
    expect(dynamic.diagnostics().incrementalPasses).toBe(0);
  });

  it('the page deleting our <style> element gets the rules put back', async () => {
    const { dynamic, scheduler } = setup(`<p id="t" style="${CONFLICT_STYLE}">x</p>`);
    document.getElementById('coloradapt-stylesheet')!.remove();
    await microtasks();
    scheduler.runFrame();

    expect(document.getElementById('coloradapt-stylesheet')).not.toBeNull();
    expect(isAdapted(byId('t'))).toBe(true);
    expect(dynamic.diagnostics().stylesheetRepairs).toBe(1);
  });

  it('a page that keeps deleting our <style> gets spaced-out repairs, never a repair per frame', async () => {
    let clock = 10_000;
    const { dynamic, scheduler } = setup(`<p id="t" style="${CONFLICT_STYLE}">x</p>`, {
      now: () => clock,
    });
    const deleteSheet = async () => {
      document.getElementById('coloradapt-stylesheet')?.remove();
      await microtasks();
      scheduler.runFrame();
    };

    await deleteSheet();
    expect(dynamic.diagnostics().stylesheetRepairs).toBe(1); // the first repair is immediate
    expect(document.getElementById('coloradapt-stylesheet')).not.toBeNull();

    for (let i = 0; i < 5; i += 1) {
      clock += 16; // one frame later, again
      await deleteSheet();
    }
    const fighting = dynamic.diagnostics();
    expect(fighting.stylesheetRepairs).toBe(1); // postponed, not performed
    expect(fighting.throttleTimerActive).toBe(true);
    expect(scheduler.timers).toHaveLength(1); // one timer, however many deletions
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();

    clock += 600;
    scheduler.runTimers();
    scheduler.runFrame();
    const after = dynamic.diagnostics();
    expect(after.stylesheetRepairs).toBe(2); // owed, so done: never dropped
    expect(after.throttleTimerActive).toBe(false);
    expect(document.getElementById('coloradapt-stylesheet')).not.toBeNull();
    expect(isAdapted(byId('t'))).toBe(true);
  });

  it('a forced flush repairs a deleted <style> without waiting out the interval', async () => {
    let clock = 10_000;
    const { dynamic } = setup(`<p id="t" style="${CONFLICT_STYLE}">x</p>`, { now: () => clock });
    document.getElementById('coloradapt-stylesheet')!.remove();
    await microtasks();
    dynamic.flush();
    clock += 16;
    document.getElementById('coloradapt-stylesheet')!.remove();
    await microtasks();
    const diag = dynamic.flush();
    expect(diag.stylesheetRepairs).toBe(2);
    expect(document.getElementById('coloradapt-stylesheet')).not.toBeNull();
  });

  describe('repair scheduler (M5.R1: causal, clock injected)', () => {
    /** One deletion cycle: delete, let the frame run. */
    async function deleteAndFrame(scheduler: ReturnType<typeof createManualScheduler>) {
      document.getElementById('coloradapt-stylesheet')?.remove();
      await microtasks();
      scheduler.runFrame();
    }

    it('a repair inside the spacing costs exactly one extra batch; outside it, none (the old 720/721 flake)', async () => {
      let clock = 10_000;
      const { dynamic, scheduler } = setup(`<p id="t" style="${CONFLICT_STYLE}">x</p>`, {
        now: () => clock,
      });
      await deleteAndFrame(scheduler); // first repair: immediate
      const slow0 = dynamic.diagnostics();
      expect(slow0).toMatchObject({ stylesheetRepairs: 1, stylesheetRepairsDeferred: 0 });

      // A slow cycle (past the interval): one batch, one repair, nothing deferred.
      clock += 600;
      const b0 = dynamic.diagnostics().batches;
      await deleteAndFrame(scheduler);
      let d = dynamic.diagnostics();
      expect(d.batches - b0).toBe(1);
      expect(d).toMatchObject({ stylesheetRepairs: 2, stylesheetRepairsDeferred: 0 });

      // A fast cycle (inside the interval): the repair is deferred, its timer adds one batch.
      clock += 16;
      const b1 = d.batches;
      await deleteAndFrame(scheduler);
      expect(dynamic.diagnostics().stylesheetRepairsDeferred).toBe(1);
      clock += 600;
      scheduler.runTimers();
      scheduler.runFrame();
      d = dynamic.diagnostics();
      expect(d.batches - b1).toBe(2);
      expect(d).toMatchObject({ stylesheetRepairs: 3, stylesheetRepairsDeferred: 1 });
      // The invariant the E2E asserts: batches = work batches + deferred repairs.
      expect(d.batches).toBe(3 + d.stylesheetRepairsDeferred);
    });

    it('rapid deletions coalesce: one timer, one deferral, one repair, not one per mutation', async () => {
      let clock = 10_000;
      const { dynamic, scheduler } = setup(`<p id="t" style="${CONFLICT_STYLE}">x</p>`, {
        now: () => clock,
      });
      await deleteAndFrame(scheduler);
      for (let i = 0; i < 50; i += 1) {
        clock += 1;
        await deleteAndFrame(scheduler);
      }
      expect(scheduler.timers).toHaveLength(1);
      expect(dynamic.diagnostics()).toMatchObject({
        stylesheetRepairs: 1,
        stylesheetRepairsDeferred: 1,
      });
      clock += 600;
      scheduler.runTimers();
      scheduler.runFrame();
      expect(dynamic.diagnostics()).toMatchObject({
        stylesheetRepairs: 2,
        throttleTimerActive: false,
      });
      expect(document.getElementById('coloradapt-stylesheet')).not.toBeNull();
    });

    it('a repair does not feed the observer: after it nothing is scheduled and nothing is queued', async () => {
      const { dynamic, scheduler } = setup(`<p id="t" style="${CONFLICT_STYLE}">x</p>`);
      await deleteAndFrame(scheduler);
      await microtasks();
      expect(scheduler.pending).toBe(0);
      expect(scheduler.timers).toHaveLength(0);
      expect(dynamic.diagnostics()).toMatchObject({ state: 'IDLE', queuedRecords: 0 });
      const callbacks = dynamic.diagnostics().observerCallbacks;
      await microtasks();
      scheduler.runFrame();
      expect(dynamic.diagnostics().observerCallbacks).toBe(callbacks);
    });

    it('OFF cancels a pending repair: no timer, no repair, no sheet', async () => {
      let clock = 10_000;
      const { controller, dynamic, scheduler } = setup(
        `<p id="t" style="${CONFLICT_STYLE}">x</p>`,
        { now: () => clock },
      );
      await deleteAndFrame(scheduler);
      clock += 1;
      await deleteAndFrame(scheduler);
      expect(dynamic.diagnostics().throttleTimerActive).toBe(true);

      controller.disableAdaptation();
      expect(dynamic.diagnostics().throttleTimerActive).toBe(false);
      expect(scheduler.timers).toHaveLength(0);
      const repairs = dynamic.diagnostics().stylesheetRepairs;
      clock += 600;
      scheduler.runTimers();
      scheduler.runFrame();
      expect(dynamic.diagnostics().stylesheetRepairs).toBe(repairs);
      expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
    });

    it('dispose cancels a pending repair', async () => {
      let clock = 10_000;
      const { dynamic, scheduler } = setup(`<p id="t" style="${CONFLICT_STYLE}">x</p>`, {
        now: () => clock,
      });
      await deleteAndFrame(scheduler);
      clock += 1;
      await deleteAndFrame(scheduler);
      expect(scheduler.timers).toHaveLength(1);
      dynamic.dispose();
      expect(scheduler.timers).toHaveLength(0);
      expect(dynamic.diagnostics().throttleTimerActive).toBe(false);
      clock += 600;
      scheduler.runTimers();
      scheduler.runFrame();
      expect(dynamic.diagnostics().stylesheetRepairs).toBe(1);
    });

    it('ON after OFF with a repair pending creates a single timer and a single repair', async () => {
      let clock = 10_000;
      const { controller, dynamic, scheduler } = setup(
        `<p id="t" style="${CONFLICT_STYLE}">x</p>`,
        { now: () => clock },
      );
      await deleteAndFrame(scheduler);
      clock += 1;
      await deleteAndFrame(scheduler);
      controller.disableAdaptation();
      controller.enableAdaptation('https://example.com', DEUTAN);
      expect(scheduler.timers).toHaveLength(0); // the rescan rebuilt the sheet; nothing is owed
      expect(document.getElementById('coloradapt-stylesheet')).not.toBeNull();

      clock += 1;
      await deleteAndFrame(scheduler);
      await deleteAndFrame(scheduler);
      expect(scheduler.timers.length).toBeLessThanOrEqual(1);
      clock += 600;
      scheduler.runTimers();
      scheduler.runFrame();
      expect(dynamic.diagnostics().throttleTimerActive).toBe(false);
      expect(document.getElementById('coloradapt-stylesheet')).not.toBeNull();
    });
  });

  it('re-analysis reads original colors: repeated passes never drift', () => {
    const { dynamic } = setup(`<div id="host"><p id="t" style="${CONFLICT_STYLE}">x</p></div>`);
    const first = document.getElementById('coloradapt-stylesheet')!.textContent;
    for (let i = 0; i < 6; i += 1) {
      byId('t').className = `c${i}`;
      byId('host').appendChild(conflictP(`extra${i}`));
      dynamic.flush();
    }
    // The first element's rule is byte-identical to the one planned from the original page.
    const id = byId('t').getAttribute('data-coloradapt-id')!;
    const rule = (text: string | null) =>
      text?.split('\n').find((line) => line.includes(`"${id}"`)) ?? '';
    expect(rule(document.getElementById('coloradapt-stylesheet')!.textContent)).toBe(rule(first));
  });
});

describe('batching and budgets', () => {
  it('500 synchronous inserts become one pass, not 500', () => {
    const { dynamic } = setup('<div id="host"></div>');
    const host = byId('host');
    for (let i = 0; i < 500; i += 1) host.appendChild(conflictP(`n${i}`));

    const diag = dynamic.flush();

    expect(diag.incrementalPasses).toBe(1);
    expect(diag.fullRescans).toBe(0);
    expect(diag.affectedRoots).toBe(500);
    expect(diag.elementsProcessed).toBe(500);
    expect(ruleCount()).toBe(500);
  });

  it('inserts beyond the root budget collapse into exactly one full rescan', () => {
    const { dynamic } = setup('<div id="host"></div>');
    const host = byId('host');
    for (let i = 0; i < 600; i += 1) host.appendChild(conflictP(`n${i}`));

    const diag = dynamic.flush();

    expect(diag.fullRescans).toBe(1);
    expect(diag.fullRescansByReason['too-many-roots']).toBe(1);
    expect(diag.incrementalPasses).toBe(0);
    expect(ruleCount()).toBe(600);
  });

  it('a mutation storm beyond the queue limit coalesces into one full rescan', async () => {
    const scheduler = createManualScheduler();
    document.body.innerHTML = '<div id="host"></div>';
    const controller = createDynamicContentController(
      document,
      { now: () => 0 },
      { scheduler, budget: { maxQueuedRecords: 50 } },
    );
    current = controller;
    controller.enableAdaptation('https://example.com', DEUTAN);

    const host = byId('host');
    for (let i = 0; i < 40; i += 1) host.appendChild(conflictP(`a${i}`));
    await microtasks(); // delivers 40 records
    for (let i = 0; i < 40; i += 1) host.appendChild(conflictP(`b${i}`));
    await microtasks(); // 80 > 50: overflow
    scheduler.runFrame();

    const diag = controller.dynamic.diagnostics();
    expect(diag.queueOverflows).toBe(1);
    expect(diag.fullRescansByReason['queue-overflow']).toBe(1);
    expect(ruleCount()).toBe(80);
  });

  it('a pass that exhausts its element budget re-queues the remaining roots', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const scheduler = createManualScheduler();
    const controller = createDynamicContentController(
      document,
      { now: () => 0, maxElements: 3 },
      { scheduler },
    );
    current = controller;
    controller.enableAdaptation('https://example.com', DEUTAN);
    const host = byId('host');
    for (let i = 0; i < 8; i += 1) host.appendChild(conflictP(`n${i}`));

    const diag = controller.dynamic.flush();

    expect(diag.incrementalPasses).toBeGreaterThan(1);
    expect(diag.rootsDeferred).toBeGreaterThan(0);
    expect(ruleCount()).toBe(8);
  });

  it('a root that does not fit next to others is retried whole in the next pass, never cut', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const scheduler = createManualScheduler();
    const controller = createDynamicContentController(
      document,
      { now: () => 0, maxElements: 5 },
      { scheduler },
    );
    current = controller;
    controller.enableAdaptation('https://example.com', DEUTAN);
    const host = byId('host');
    for (let r = 0; r < 3; r += 1) {
      const group = el('div', { id: `g${r}` });
      group.append(conflictP(`g${r}a`), conflictP(`g${r}b`), conflictP(`g${r}c`));
      host.appendChild(group);
    }

    const diag = controller.dynamic.flush();

    expect(ruleCount()).toBe(9); // nothing lost
    expect(diag.incrementalPasses).toBe(3); // 3 + 3 > 5, so one group per pass
    expect(diag.truncatedPasses).toBe(0);
    expect(diag.rootsDeferred).toBeGreaterThan(0);
    expect(diag.deferredRoots).toBe(0);
  });

  it('full rescans are spaced out by the throttle, never dropped', async () => {
    let clock = 10_000;
    const { dynamic, scheduler } = setup(`<p id="t">x</p>`, { now: () => clock });
    const addStyle = (css: string) => {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    };

    addStyle('.a { color: red; }');
    await microtasks();
    scheduler.runFrame();
    expect(dynamic.diagnostics().fullRescans).toBe(1);

    clock += 100;
    addStyle('.b { color: blue; }');
    await microtasks();
    scheduler.runFrame();
    expect(dynamic.diagnostics().fullRescans).toBe(1);
    expect(dynamic.diagnostics().fullRescansThrottled).toBe(1);
    expect(scheduler.timers).toHaveLength(1);

    clock += 1_000;
    scheduler.runTimers();
    scheduler.runFrame();
    expect(dynamic.diagnostics().fullRescans).toBe(2);
  });
});

describe('pending stylesheet links', () => {
  const addLink = (id: string, href = 'https://example.invalid/a.css') => {
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
    return link;
  };

  it('a pending link is waited on, and released as soon as it leaves the document', async () => {
    const { dynamic } = setup('<p id="t">x</p>');
    const link = addLink('l1');
    await microtasks();
    dynamic.flush();
    expect(dynamic.diagnostics()).toMatchObject({ pendingLinks: 1, fullRescans: 0 });

    link.remove();
    await microtasks();
    const diag = dynamic.flush();
    expect(diag.pendingLinks).toBe(0); // no detached node is kept
    expect(diag.fullRescansByReason.stylesheet).toBe(1); // the removal itself is a stylesheet change
  });

  it('disabling a pending link releases its listener', async () => {
    const { dynamic } = setup('<p id="t">x</p>');
    const link = addLink('l1');
    await microtasks();
    dynamic.flush();
    expect(dynamic.diagnostics().pendingLinks).toBe(1);
    link.setAttribute('disabled', '');
    await microtasks();
    expect(dynamic.flush().pendingLinks).toBe(0);
  });

  it('turning OFF with links pending leaves no listener behind', async () => {
    const { controller, dynamic } = setup('<p id="t">x</p>');
    addLink('l1');
    addLink('l2', 'https://example.invalid/b.css');
    await microtasks();
    dynamic.flush();
    expect(dynamic.diagnostics().pendingLinks).toBe(2);
    controller.disableAdaptation();
    expect(dynamic.diagnostics().pendingLinks).toBe(0);
  });

  it('a load event ends the wait with one rescan', async () => {
    const { dynamic, scheduler } = setup('<p id="t">x</p>');
    const link = addLink('l1');
    await microtasks();
    scheduler.runFrame();
    expect(dynamic.diagnostics().pendingLinks).toBe(1);
    link.dispatchEvent(new Event('load'));
    scheduler.runFrame();
    const diag = dynamic.diagnostics();
    expect(diag).toMatchObject({ pendingLinks: 0, fullRescans: 1 });
    expect(diag.fullRescansByReason).toEqual({ stylesheet: 1 });
  });
});

describe('lifecycle', () => {
  it('ON/OFF/ON never stacks observers', () => {
    const { controller, dynamic } = setup(`<div id="host"></div>`);
    expect(dynamic.running).toBe(true);

    controller.disableAdaptation();
    expect(dynamic.running).toBe(false);

    controller.enableAdaptation('https://example.com', DEUTAN);
    controller.enableAdaptation('https://example.com', DEUTAN);
    expect(dynamic.running).toBe(true);

    byId('host').appendChild(conflictP('x'));
    const diag = dynamic.flush();
    expect(diag.incrementalPasses).toBe(1); // one subscription -> one pass
    expect(diag.observerStarts).toBe(2); // the initial start and the one after OFF
  });

  it('mutations while OFF are ignored and ON picks up the page as it is', () => {
    const { controller, dynamic } = setup(`<div id="host"></div>`);
    controller.disableAdaptation();

    byId('host').appendChild(conflictP('while-off'));
    expect(dynamic.flush().incrementalPasses).toBe(0);
    expect(ruleCount()).toBe(0);
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();

    controller.enableAdaptation('https://example.com', DEUTAN);
    expect(isAdapted(byId('while-off'))).toBe(true);
  });

  it('a site-disabled page runs no observer and adapts nothing', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const controller = createDynamicContentController(document, { now: () => 0 });
    current = controller;

    controller.enableAdaptation('https://example.com', { ...DEUTAN, enabled: false });
    expect(controller.dynamic.running).toBe(false);

    byId('host').appendChild(conflictP('x'));
    expect(controller.dynamic.flush().incrementalPasses).toBe(0);
    expect(ruleCount()).toBe(0);
  });

  it('a settings change is a full refresh that re-plans from the original styles', () => {
    const { controller, dynamic } = setup(`<p id="t" style="${CONFLICT_STYLE}">x</p>`);
    const deutanRule = document.getElementById('coloradapt-stylesheet')!.textContent;

    controller.enableAdaptation('https://example.com', { ...DEUTAN, visionProfile: 'protanopia' });
    controller.enableAdaptation('https://example.com', DEUTAN);

    expect(document.getElementById('coloradapt-stylesheet')!.textContent).toBe(deutanRule);
    expect(ruleCount()).toBe(1);
    // Later incremental passes use the new settings.
    controller.enableAdaptation('https://example.com', { ...DEUTAN, adaptationStrength: 0 });
    byId('t').insertAdjacentElement('afterend', conflictP('later'));
    dynamic.flush();
    expect(ruleCount()).toBe(0);
  });

  it('refresh() requests a full rescan through the normal path', () => {
    const { dynamic } = setup(`<p id="t" style="${CONFLICT_STYLE}">x</p>`);
    dynamic.refresh();
    const diag = dynamic.flush();
    expect(diag.fullRescansByReason.manual).toBe(1);
    expect(ruleCount()).toBe(1);
  });

  it('dispose() stops for good', () => {
    const { dynamic } = setup(`<div id="host"></div>`);
    dynamic.dispose();
    dynamic.start();
    expect(dynamic.running).toBe(false);
    byId('host').appendChild(conflictP('x'));
    expect(dynamic.flush().incrementalPasses).toBe(0);
  });

  it('dispose() leaves no observer, listener, timer or queued work, and later mutations cost nothing', async () => {
    let clock = 10_000;
    const { dynamic, scheduler } = setup('<div id="host"></div>', { now: () => clock });
    // owe a throttled rescan, a throttled repair, a pending link and queued records
    const addStyle = () => document.head.appendChild(document.createElement('style'));
    addStyle();
    await microtasks();
    scheduler.runFrame();
    clock += 10;
    addStyle();
    await microtasks();
    scheduler.runFrame();
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://example.invalid/a.css';
    document.head.appendChild(link);
    await microtasks();
    scheduler.runFrame();
    byId('host').appendChild(conflictP('queued'));
    await microtasks();
    const busy = dynamic.diagnostics();
    expect(busy.throttleTimerActive).toBe(true);
    expect(busy.pendingLinks).toBe(1);
    expect(busy.queuedRecords).toBeGreaterThan(0);

    dynamic.dispose();

    const off = dynamic.diagnostics();
    expect(off).toMatchObject({
      state: 'STOPPED',
      pendingLinks: 0,
      queuedRecords: 0,
      deferredRoots: 0,
      pendingRescan: null,
      throttleTimerActive: false,
    });
    expect(scheduler.pending).toBe(0);
    expect(scheduler.timers).toHaveLength(0);
    // the link's listener is really gone: its load event does nothing
    link.dispatchEvent(new Event('load'));
    byId('host').appendChild(conflictP('later'));
    await microtasks();
    scheduler.runFrame();
    scheduler.runTimers();
    expect(dynamic.diagnostics()).toEqual(off);
    expect(dynamic.running).toBe(false);
  });
});

describe('cleanup', () => {
  it('removing hundreds of adapted nodes leaves no rules or bookkeeping behind', () => {
    const { dynamic, controller } = setup('<div id="host"></div>');
    const host = byId('host');
    for (let i = 0; i < 300; i += 1) host.appendChild(conflictP(`n${i}`));
    dynamic.flush();
    expect(ruleCount()).toBe(300);
    expect(controller.incremental.trackedCount()).toBe(300);

    host.replaceChildren();
    const diag = dynamic.flush();

    expect(ruleCount()).toBe(0);
    expect(controller.incremental.ruleCount).toBe(0);
    expect(controller.incremental.trackedCount()).toBe(0);
    expect(diag.trackedElements).toBe(0);
    expect(diag.rulesRemoved).toBe(300);
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
  });

  it('keeps the page-level summary in step with incremental changes', () => {
    const { dynamic, controller } = setup(
      `<div id="host"><p style="${CONFLICT_STYLE}">1</p></div>`,
    );
    expect(controller.incremental.summary().adapted).toBe(1);

    byId('host').append(conflictP('b'), el('p', { style: FINE_STYLE }, 'fine'));
    dynamic.flush();
    expect(controller.incremental.summary()).toMatchObject({ adapted: 2, unchanged: 1 });

    byId('host').replaceChildren();
    dynamic.flush();
    expect(controller.incremental.summary()).toMatchObject({ adapted: 0, unchanged: 0 });
  });
});
