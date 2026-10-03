import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_USER_SETTINGS } from '@domain/models';
import { createDynamicContentController } from '@features/dynamic-analysis';
import { SEMANTIC_LIMITS, defaultFactsEnvironment } from '@features/semantics';
import {
  $,
  CUE_ATTRIBUTE,
  SETTINGS,
  createManualScheduler,
  cueCount,
  cueOf,
  describeCue,
  mount,
  sheetText,
  simulatedBrowser,
  teardown,
} from './kit';

/**
 * M6.R1: peer grouping and peer invalidation. Whether color is the *only* difference between
 * two elements depends on both of them, so a change at one (or its removal) must re-examine the
 * other, and elements that are not comparable must never be compared.
 */
const CSS = `
  .status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
  .status.online { background-color: #27ae60; }
  .status.offline { background-color: #c0392b; }
  .badge { display: inline-block; padding: 2px 6px; color: #ffffff; background-color: #7f8c8d; }
  .badge.success { background-color: #1e8449; }
  .badge.error { background-color: #c0392b; }
  .tab { color: #555555; border: 0; background: none; font: inherit; }
  .tab[aria-selected="true"] { color: #0645ad; }
  .item { color: #555555; text-decoration: none; }
  .item.active { color: #0645ad; }
  .f { border-top: 1px solid #888888; }
  .f[aria-invalid="true"], .f:invalid { border-top-color: #c0392b; }
`;

afterEach(() => {
  teardown();
  vi.restoreAllMocks();
});

const node = (markup: string): HTMLElement => {
  const holder = document.createElement('div');
  holder.innerHTML = markup.trim();
  return holder.firstElementChild as HTMLElement;
};
const cues = (): string[] =>
  [...document.querySelectorAll(`[${CUE_ATTRIBUTE}]`)].map(
    (el) => `${el.id}:${describeCue(el.getAttribute(CUE_ATTRIBUTE))}`,
  );

describe('M6.R1 a peer leaving the page', () => {
  it('two badges that differed by color only: the remaining one has nothing to be compared with', () => {
    const rig = mount(
      '<div id="box"><span id="a" class="badge success">Order 1</span><span id="b" class="badge error">Order 2</span></div>',
      CSS,
    );
    expect(cues()).toEqual(['a:after ✓', 'b:after ×']);

    $('#b').remove();
    rig.flush();
    // The success badge has no peer in another state any more: its old cue must not stay behind.
    expect(cueOf('#a')).toBeNull();
    expect(cueCount()).toBe(0);
    expect(rig.controller.dynamic.diagnostics().semantic.semanticPeerSearches).toBeGreaterThan(0);
  });

  it('two status dots, one removed: a dot is color-only by construction, so the remaining one keeps its single cue', () => {
    const rig = mount(
      '<div id="box"><span id="on" class="status online"></span><span id="off" class="status offline"></span></div>',
      CSS,
    );
    expect(cues()).toEqual(['on:inner ✓', 'off:inner ×']);
    $('#off').remove();
    rig.flush();
    expect(cues()).toEqual(['on:inner ✓']);
    $('#on').remove();
    rig.flush();
    expect(cueCount()).toBe(0);
  });

  it('removal is followed when the node sits several levels below the group scope', () => {
    const rig = mount(
      '<ul id="list"><li><span id="a" class="badge success">Order 1</span></li><li id="li2"><span id="b" class="badge error">Order 2</span></li></ul>',
      CSS,
    );
    expect(cueCount()).toBe(2);
    $('#li2').remove();
    rig.flush();
    expect(cueCount()).toBe(0);
  });

  it('removing a neutral peer: the success badge was compared with it, and keeps its cue only if another exists', () => {
    const rig = mount(
      '<span id="a" class="badge success">Order 1</span><span id="n1" class="badge">Order 2</span><span id="n2" class="badge">Order 3</span>',
      CSS,
    );
    expect(cues()).toEqual(['a:after ✓']);
    $('#n1').remove();
    rig.flush();
    expect(cues()).toEqual(['a:after ✓']);
    $('#n2').remove();
    rig.flush();
    expect(cueCount()).toBe(0);
  });
});

describe('M6.R1 removal-only batches', () => {
  it('a batch that only removes nodes is one semantic pass for their peers', () => {
    const rig = mount(
      '<div id="box"><span id="a" class="status online"></span><span id="b" class="status offline"></span></div>',
      CSS,
    );
    rig.flush();
    const before = rig.controller.dynamic.diagnostics();
    $('#b').remove();
    const after = rig.flush();
    expect(after.semantic.semanticPasses - before.semantic.semanticPasses).toBe(1);
    expect(after.fullRescans).toBe(before.fullRescans);
    expect(after.semantic.semanticPeerSearches).toBeGreaterThan(
      before.semantic.semanticPeerSearches,
    );
    expect(cues()).toEqual(['a:inner ✓']);
  });

  it('with semantic cues off a removal costs the semantic layer nothing', () => {
    const rig = mount(
      '<div id="box"><span class="badge success">A</span><span id="b" class="badge error">B</span></div>',
      CSS,
      { ...SETTINGS, semanticCuesEnabled: false },
    );
    $('#b').remove();
    const after = rig.flush();
    expect(after.semantic.semanticPasses).toBe(0);
    expect(after.semantic.semanticPeerSearches).toBe(0);
  });
});

describe('M6.R1 a peer changing state', () => {
  it('only the peer is touched: the element next to it loses (and regains) its cue', () => {
    const rig = mount(
      '<span id="a" class="badge success">Order 1</span><span id="b" class="badge error">Order 2</span>',
      CSS,
    );
    expect(cues()).toEqual(['a:after ✓', 'b:after ×']);

    // b becomes a success too: nothing differs between the two any more. a is not touched.
    $('#b').className = 'badge success';
    rig.flush();
    expect(cueCount()).toBe(0);

    $('#b').className = 'badge error';
    rig.flush();
    expect(cues()).toEqual(['a:after ✓', 'b:after ×']);
  });

  it('a contrasting peer inserted next to a lone element gives it its cue', () => {
    const rig = mount('<div id="box"><span id="a" class="badge success">Order 1</span></div>', CSS);
    expect(cueCount()).toBe(0);
    $('#box').appendChild(node('<span id="b" class="badge error">Order 2</span>'));
    rig.flush();
    expect(cues()).toEqual(['a:after ✓', 'b:after ×']);
  });

  it('selected A / unselected B becomes selected B / unselected A in one incremental pass', () => {
    const rig = mount(
      '<div role="tablist"><button id="a" role="tab" class="tab" aria-selected="true">One</button><button id="b" role="tab" class="tab" aria-selected="false">Two</button><button id="c" role="tab" class="tab" aria-selected="false">Three</button></div>',
      CSS,
    );
    expect(cues()).toEqual(['a:underline']);
    rig.flush();
    const before = rig.controller.dynamic.diagnostics();

    $('#a').setAttribute('aria-selected', 'false');
    $('#b').setAttribute('aria-selected', 'true');
    const after = rig.flush();

    expect(cues()).toEqual(['b:underline']);
    expect(after.incrementalPasses - before.incrementalPasses).toBe(1);
    expect(after.fullRescans).toBe(before.fullRescans);
  });

  it('the same switch in two separate batches ends in the same state, nothing stale in between', () => {
    const rig = mount(
      '<div role="tablist"><button id="a" role="tab" class="tab" aria-selected="true">One</button><button id="b" role="tab" class="tab" aria-selected="false">Two</button></div>',
      CSS,
    );
    $('#a').setAttribute('aria-selected', 'false');
    rig.flush();
    expect(cueCount()).toBe(0); // nobody is selected: nobody is underlined
    $('#b').setAttribute('aria-selected', 'true');
    rig.flush();
    expect(cues()).toEqual(['b:underline']);
  });

  it('insert, remove, reorder and replace leave one cue per cued element and nothing else', () => {
    const rig = mount(
      '<div id="box"><span id="a" class="badge success">A</span><span id="b" class="badge error">B</span><span id="c" class="badge">C</span></div>',
      CSS,
    );
    const box = $('#box');
    expect(cues()).toEqual(['a:after ✓', 'b:after ×']);

    // reorder: move the first badge to the end
    box.appendChild($('#a'));
    rig.flush();
    expect(cues().sort()).toEqual(['a:after ✓', 'b:after ×']);

    // replace: a new node with the same class takes the place of the old one
    $('#b').replaceWith(node('<span id="b2" class="badge error">B2</span>'));
    rig.flush();
    expect(cues().sort()).toEqual(['a:after ✓', 'b2:after ×']);

    // insert in the middle, remove the original
    box.insertBefore(node('<span id="d" class="badge error">D</span>'), $('#c'));
    $('#b2').remove();
    rig.flush();
    expect(cues().sort()).toEqual(['a:after ✓', 'd:after ×']);

    // remove everything but one
    $('#d').remove();
    $('#c').remove();
    rig.flush();
    expect(cueCount()).toBe(0);
  });
});

describe('M6.R1 a plain peer joining or leaving', () => {
  const LIST =
    '<ul id="nav"><li><a id="m1" class="item active" aria-current="page" href="#">Home</a></li></ul>';

  it('a plain element that is not a candidate itself still makes a lone current link comparable, and its removal takes the cue away', () => {
    const rig = mount(LIST, CSS);
    expect(cueCount()).toBe(0); // nothing to compare with
    $('#nav').appendChild(node('<li id="l2"><a id="m2" class="item" href="#">Docs</a></li>'));
    rig.flush();
    expect(cues()).toEqual(['m1:underline']);
    $('#l2').remove();
    rig.flush();
    expect(cueCount()).toBe(0);
  });
});

describe('M6.R1 what is not a peer', () => {
  it('a change in one list does not re-examine the other list', () => {
    const rig = mount(
      '<div><ul class="main"><li><a id="m1" class="item active" aria-current="page" href="#">Home</a></li><li><a id="m2" class="item" href="#">About</a></li></ul>' +
        '<ul class="footer"><li><a id="f1" class="item" href="#">Terms</a></li><li><a id="f2" class="item" href="#">Privacy</a></li></ul></div>',
      CSS,
    );
    expect(cues()).toEqual(['m1:underline']);
    rig.flush();
    const before = rig.controller.dynamic.diagnostics().semantic;
    $('#f1').setAttribute('aria-current', 'page');
    $('#f1').className = 'item active';
    rig.flush();
    const after = rig.controller.dynamic.diagnostics().semantic;
    // f1 is compared with f2 only: a footer change examines f1, f2 and nothing of the main list.
    expect(cues().sort()).toEqual(['f1:underline', 'm1:underline']);
    expect(after.semanticPeersReexamined - before.semanticPeersReexamined).toBeLessThanOrEqual(1);
  });

  it('a tab is never compared with a same-class element of another role', () => {
    const rig = mount(
      '<div><button id="a" role="tab" class="tab" aria-selected="true">One</button><button id="b" class="tab" type="button">Plain</button></div>',
      CSS,
    );
    expect(cueCount()).toBe(0); // the only possible "peer" has another role
    expect(rig.controller.inspectSemantics($('#a')).decision).toMatchObject({
      action: 'none',
      reason: 'not-color-only',
    });
  });

  it('wrappers must match too: items in <ul class="nav"> and <ul class="aside"> are two components', () => {
    const rig = mount(
      '<div><ul class="nav"><li><a id="a" class="item active" aria-current="page" href="#">Home</a></li></ul><ul class="aside"><li><a class="item" href="#">Docs</a></li></ul></div>',
      CSS,
    );
    expect(cueCount()).toBe(0);
    expect(rig.controller.inspectSemantics($('#a')).decision).toMatchObject({
      action: 'none',
      detail: expect.stringContaining('cannot-compare'),
    });
  });

  it('the same wrappers on both sides are one component (rows of a list)', () => {
    mount(
      '<div><ul class="nav"><li><a id="a" class="item active" aria-current="page" href="#">Home</a></li><li><a class="item" href="#">Docs</a></li></ul></div>',
      CSS,
    );
    expect(cues()).toEqual(['a:underline']);
  });
});

describe('M6.R1 invalidation is bounded', () => {
  it('a group much larger than the limit: one change re-examines at most the limit, never the document', () => {
    const rows = Array.from(
      { length: 300 },
      (_, i) => `<span id="r${i}" class="badge ${i === 0 ? 'error' : 'success'}">Row ${i}</span>`,
    ).join('');
    const rig = mount(`<div id="box">${rows}</div>`, CSS);
    rig.flush();
    const before = rig.controller.dynamic.diagnostics();

    $('#r150').className = 'badge error';
    const after = rig.flush();

    const examined =
      after.semantic.semanticPeersReexamined - before.semantic.semanticPeersReexamined;
    expect(examined).toBeLessThanOrEqual(SEMANTIC_LIMITS.expansionPeers);
    expect(
      after.semantic.semanticCandidates - before.semantic.semanticCandidates,
    ).toBeLessThanOrEqual(SEMANTIC_LIMITS.expansionPeers + 3);
    expect(after.fullRescans).toBe(before.fullRescans);
    expect(
      after.semantic.semanticPeerSearches - before.semantic.semanticPeerSearches,
    ).toBeLessThanOrEqual(SEMANTIC_LIMITS.maxPeerSearches);
  });

  it('a whole-document pass searches no peers (every candidate is already in it)', () => {
    const rig = mount(
      '<span class="badge success">A</span><span class="badge error">B</span>',
      CSS,
    );
    expect(rig.controller.dynamic.diagnostics().semantic.semanticPeerSearches).toBe(0);
  });

  it('removing many nodes of one kind from one parent is one search, not one per node', () => {
    const rows = Array.from(
      { length: 80 },
      (_, i) => `<span id="r${i}" class="badge success">R${i}</span>`,
    );
    const rig = mount(
      `<div id="box">${rows.join('')}<span id="keep" class="badge error">Keep</span></div>`,
      CSS,
    );
    rig.flush();
    const before = rig.controller.dynamic.diagnostics().semantic;
    for (let i = 0; i < 80; i += 1) $(`#r${i}`).remove();
    rig.flush();
    const after = rig.controller.dynamic.diagnostics().semantic;
    expect(after.semanticPeerSearches - before.semanticPeerSearches).toBe(1);
    expect(cueCount()).toBe(0);
  });
});

describe('M6.R1 the native-validity bridge lifecycle', () => {
  const FORM =
    '<form id="form"><input id="e" type="email" required class="f"><input id="o" class="f"></form>';
  const NAMES = ['input', 'change', 'focusout', 'invalid', 'reset'];

  const listenerCalls = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter(([name]) => NAMES.includes(String(name))).length;

  it('one set of listeners however often the page is refreshed, none while off, one set again when on', () => {
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');
    const rig = mount(FORM, CSS);
    expect(listenerCalls(added)).toBe(NAMES.length);
    expect(rig.controller.semanticBridge).toEqual({ listening: true, listeners: NAMES.length });

    for (let i = 0; i < 5; i += 1) rig.refresh();
    expect(listenerCalls(added)).toBe(NAMES.length);
    expect(listenerCalls(removed)).toBe(0);

    rig.refresh({ ...SETTINGS, semanticCuesEnabled: false });
    expect(listenerCalls(removed)).toBe(NAMES.length);
    expect(rig.controller.semanticBridge).toEqual({ listening: false, listeners: 0 });
    // While off, form events cause no work at all.
    const email = $('#e') as HTMLInputElement;
    email.value = 'x';
    email.dispatchEvent(new Event('input', { bubbles: true }));
    const passes = rig.controller.dynamic.diagnostics().semantic.semanticPasses;
    expect(rig.flush().semanticInvalidations).toBe(0);
    expect(rig.controller.dynamic.diagnostics().semantic.semanticPasses).toBe(passes);

    rig.refresh({ ...SETTINGS, semanticCuesEnabled: true });
    expect(listenerCalls(added)).toBe(NAMES.length * 2);
    expect(rig.controller.semanticBridge.listeners).toBe(NAMES.length);

    rig.controller.disableAdaptation();
    expect(listenerCalls(removed)).toBe(NAMES.length * 2);
    expect(rig.controller.semanticBridge.listeners).toBe(0);
  });

  it('disposed with the pipeline: no listener is left on the document', () => {
    const rig = mount(FORM, CSS);
    rig.controller.dynamic.dispose();
    rig.controller.disableAdaptation();
    expect(rig.controller.semanticBridge.listeners).toBe(0);
  });

  it('untouched required -> invalid -> valid -> invalid again: the cue follows the policy exactly', () => {
    const rig = mount(FORM, CSS);
    const email = $('#e') as HTMLInputElement;
    const type = (value: string, event = 'input') => {
      email.value = value;
      email.dispatchEvent(new Event(event, { bubbles: true }));
      rig.flush();
    };
    // untouched, required: a requirement, never an invalid cue
    expect(cueOf('#e')).toBeNull();
    type('not-an-email');
    expect(cueOf('#e')).toBe('outline:dashed'); // touched and invalid
    type('a@b.co');
    expect(cueOf('#e')).toBeNull(); // valid again
    type('nope', 'change');
    expect(cueOf('#e')).toBe('outline:dashed'); // invalid again
    type('');
    expect(cueOf('#e')).toBeNull(); // emptied: required, not invalid
  });

  it('form.reset() returns the field to untouched and takes the cue off, with no event on the field', () => {
    const rig = mount(FORM, CSS);
    const email = $('#e') as HTMLInputElement;
    email.value = 'bad';
    email.dispatchEvent(new Event('input', { bubbles: true }));
    rig.flush();
    expect(cueOf('#e')).toBe('outline:dashed');

    ($('#form') as HTMLFormElement).reset();
    rig.flush();
    expect(email.value).toBe('');
    expect(cueOf('#e')).toBeNull();
  });

  it('a reset names the form fields, no more than the cap', () => {
    const fields = Array.from({ length: 250 }, (_, i) => `<input id="i${i}" class="f">`).join('');
    const rig = mount(`<form id="form">${fields}</form>`, CSS);
    rig.flush();
    const before = rig.controller.dynamic.diagnostics().semanticInvalidations;
    ($('#form') as HTMLFormElement).reset();
    const after = rig.flush().semanticInvalidations;
    expect(after - before).toBe(200);
  });
});

describe('M6.R1 no feedback loop and nothing retained', () => {
  it('cue add / remove / update x 60: one semantic pass per real change, none from the cues themselves', () => {
    const rig = mount(
      '<span id="a" class="badge success">A</span><span id="b" class="badge error">B</span>',
      CSS,
    );
    rig.flush();
    for (let cycle = 0; cycle < 60; cycle += 1) {
      const before = rig.controller.dynamic.diagnostics();
      $('#a').className = cycle % 2 === 0 ? 'badge error' : 'badge success';
      const changed = rig.flush();
      expect(changed.semantic.semanticPasses - before.semantic.semanticPasses).toBe(1);
      const settled = rig.flush();
      expect(settled.semantic.semanticPasses).toBe(changed.semantic.semanticPasses);
      expect(settled.batches).toBe(changed.batches);
      expect(settled.queuedRecords).toBe(0);
    }
    expect(cueCount()).toBe(2); // the last change made `a` a success again: contrast, so two cues
  });

  it('500 semantic components created, classified, cued and removed, five times: nothing left', () => {
    const rig = mount('<div id="host"></div>', CSS);
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const html = Array.from(
        { length: 500 },
        (_, i) => `<span class="badge ${i % 2 === 0 ? 'success' : 'error'}">Item ${i}</span>`,
      ).join('');
      const host = $('#host');
      host.innerHTML = html;
      rig.flush();
      expect(cueCount()).toBeGreaterThan(0);
      host.replaceChildren();
      rig.flush();
      const d = rig.controller.dynamic.diagnostics();
      expect(cueCount()).toBe(0);
      expect(d.semantic.cuesActive).toBe(0);
      expect(d.queuedRecords).toBe(0);
      expect(d.deferredRoots).toBe(0);
      expect(d.pendingRescan).toBeNull();
      expect(document.querySelectorAll(`[${CUE_ATTRIBUTE}]`).length).toBe(0);
      expect(rig.controller.semanticBridge.listeners).toBe(5);
    }
    // The cue rules are gone with the last cue.
    expect(sheetText()).not.toContain(CUE_ATTRIBUTE);
  });

  it('diagnostic counters agree with the page once it settles', () => {
    const rig = mount(
      '<span id="a" class="badge success">A</span><span id="b" class="badge error">B</span><span id="c" class="badge">C</span><span id="d" class="badge success error">D</span>',
      CSS,
    );
    const d = rig.controller.dynamic.diagnostics().semantic;
    expect(d.cuesActive).toBe(cueCount());
    expect(d.cuesApplied - d.cuesRemoved).toBe(d.cuesActive);
    expect(d.cuesApplied + d.cuesNotApplied).toBe(d.cuesPlanned);
    expect(d.semanticClassified + d.semanticUnknown + d.semanticConflicts).toBe(
      d.semanticCandidates,
    );
    expect(d.semanticConflicts).toBeGreaterThanOrEqual(1);
  });
});

describe('M6.R1 placement is verified, not assumed', () => {
  /** A browser whose layout answers can be scripted per element: jsdom has none. */
  function mountScripted(
    markup: string,
    script: (el: HTMLElement, cued: boolean) => Partial<Record<string, number>>,
  ) {
    document.head.innerHTML = `<style>${CSS} .clip { overflow-x: hidden; overflow-y: hidden; }</style>`;
    document.body.innerHTML = markup;
    for (const el of document.querySelectorAll<HTMLElement>('.badge')) {
      const read = (name: string) => script(el, el.hasAttribute(CUE_ATTRIBUTE))[name] ?? 0;
      for (const name of ['scrollWidth', 'clientWidth', 'scrollHeight', 'clientHeight']) {
        Object.defineProperty(el, name, { configurable: true, get: () => read(name) });
      }
      el.getBoundingClientRect = () => ({
        x: 0,
        y: 0,
        left: read('left'),
        top: read('top'),
        width: read('width'),
        height: read('height'),
        right: 0,
        bottom: 0,
        toJSON: () => ({}),
      });
    }
    const base = simulatedBrowser(document);
    const controller = createDynamicContentController(
      document,
      { now: () => 0 },
      { scheduler: createManualScheduler() },
      { env: base },
    );
    controller.enableAdaptation('https://example.com', {
      ...DEFAULT_USER_SETTINGS,
      visionProfile: 'deuteranopia',
    });
    return controller;
  }

  const PAIR =
    '<span id="a" class="badge success CLASS">Order 1</span><span id="b" class="badge error">Order 2</span>';
  const room = { width: 60, height: 20, clientWidth: 100, clientHeight: 20, scrollHeight: 20 };

  it('baseline: a glyph beside text that fits is applied', () => {
    const controller = mountScripted(PAIR.replace('CLASS', ''), () => ({
      ...room,
      scrollWidth: 60,
    }));
    try {
      expect(cueOf('#a')).not.toBeNull();
      expect(controller.dynamic.diagnostics().semantic.cuesNotApplied).toBe(0);
    } finally {
      controller.dynamic.dispose();
      controller.disableAdaptation();
    }
  });

  it('a host that clips its overflow and has no room for the glyph: not applied, not claimed', () => {
    const controller = mountScripted(PAIR.replace('CLASS', 'clip'), (el, cued) => ({
      ...room,
      clientWidth: 60,
      // the glyph makes the content wider than the clipping box
      scrollWidth: el.id === 'a' && cued ? 74 : 58,
    }));
    try {
      expect(cueOf('#a')).toBeNull();
      const semantic = controller.dynamic.diagnostics().semantic;
      expect(semantic.cuesNotApplied).toBe(1);
      expect(semantic.cuesApplied).toBe(1); // the error badge, which has room
      expect(semantic.cuesActive).toBe(1);
    } finally {
      controller.dynamic.dispose();
      controller.disableAdaptation();
    }
  });

  it('an ellipsized label (already wider than its box): the glyph would sit in the cut-off part', () => {
    const controller = mountScripted(PAIR.replace('CLASS', 'clip'), () => ({
      ...room,
      clientWidth: 60,
      scrollWidth: 140,
    }));
    try {
      expect(cueOf('#a')).toBeNull();
      expect(controller.dynamic.diagnostics().semantic.cuesNotApplied).toBe(1);
    } finally {
      controller.dynamic.dispose();
      controller.disableAdaptation();
    }
  });

  it('a cue that would make its host taller (the glyph wraps onto a new line): not applied', () => {
    const controller = mountScripted(PAIR.replace('CLASS', ''), (el, cued) => ({
      ...room,
      scrollWidth: 60,
      height: el.id === 'a' && cued ? 40 : 20,
    }));
    try {
      expect(cueOf('#a')).toBeNull();
      expect(cueOf('#b')).not.toBeNull();
      expect(controller.dynamic.diagnostics().semantic.cuesNotApplied).toBe(1);
    } finally {
      controller.dynamic.dispose();
      controller.disableAdaptation();
    }
  });

  it("a neighbor's glyph moving this host sideways or down is not this host's problem", () => {
    const controller = mountScripted(PAIR.replace('CLASS', ''), (el, cued) => ({
      ...room,
      scrollWidth: 60,
      top: el.id === 'b' && cued ? 12 : 0,
      left: el.id === 'b' && cued ? 30 : 0,
    }));
    try {
      expect(cueOf('#a')).not.toBeNull();
      expect(cueOf('#b')).not.toBeNull();
      expect(controller.dynamic.diagnostics().semantic.cuesNotApplied).toBe(0);
    } finally {
      controller.dynamic.dispose();
      controller.disableAdaptation();
    }
  });
});

describe('M6.R1 unsupported placements are decided before anything is written', () => {
  it('a grid host gets no glyph (it would land in a new row); a flex host does', () => {
    const rig = mount(
      '<div><span id="g1" class="badge success grid">Order 1</span><span id="g2" class="badge error grid">Order 2</span></div>' +
        '<div><span id="f1" class="badge success flex">Order 1</span><span id="f2" class="badge error flex">Order 2</span></div>',
      `${CSS} .grid { display: inline-grid; } .flex { display: inline-flex; }`,
    );
    expect(cueOf('#g1')).toBeNull();
    expect(cueOf('#g2')).toBeNull();
    expect(cueOf('#f1')).not.toBeNull();
    expect(cueOf('#f2')).not.toBeNull();
    expect(rig.controller.inspectSemantics($('#g1')).decision).toMatchObject({
      action: 'none',
      reason: 'no-safe-placement',
      detail: 'grid-host',
    });
    // Nothing was planned for them, so nothing is reported as applied or not applied.
    const { semantic } = rig.controller.dynamic.diagnostics();
    expect(semantic.cuesPlanned).toBe(2);
    expect(semantic.cuesNotApplied).toBe(0);
  });
});

describe('M6.R1 the environment the tests rely on', () => {
  it('jsdom has no pseudo-element layout: the default environment says so instead of guessing', () => {
    const env = defaultFactsEnvironment(document);
    expect(env.pseudoBox?.(document.body, '::after')).toBeNull();
    expect(env.pseudoContent(document.body, '::after')).toBe('none');
  });
});
