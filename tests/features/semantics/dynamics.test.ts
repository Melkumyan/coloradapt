import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_USER_SETTINGS } from '@domain/models';
import { createDynamicContentController } from '@features/dynamic-analysis';
import { defaultFactsEnvironment } from '@features/semantics';
import {
  SETTINGS,
  $,
  CUE_ATTRIBUTE,
  createManualScheduler,
  cueCount,
  cueOf,
  describeCue,
  mount,
  teardown,
} from './kit';

const CSS = `
  .status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
  .status.online { background-color: #27ae60; }
  .status.offline { background-color: #c0392b; }
  .tab { color: #555555; }
  .tab[aria-selected="true"] { color: #0645ad; }
  .nav-link { color: #555555; }
  .nav-link[aria-current="page"] { color: #0645ad; }
  .f { border-top-style: solid; border-top-width: 1px; border-top-color: #888888; }
  .f[aria-invalid="true"] { border-top-color: #c0392b; }
  .toggle { color: #555555; }
  .toggle[aria-pressed="true"] { color: #0645ad; }
  .badge { display: inline-block; padding: 2px 6px; color: #ffffff; }
  .badge.success { background-color: #27ae60; }
  .badge.error { background-color: #c0392b; }
  .badge.pending { background-color: #7f8c8d; }
`;

afterEach(teardown);

const element = (markup: string): HTMLElement => {
  const holder = document.createElement('div');
  holder.innerHTML = markup.trim();
  return holder.firstElementChild as HTMLElement;
};

describe('M6 dynamic semantics through M4', () => {
  it('aria-invalid false -> true -> false: the cue appears and is removed, no stale cue', () => {
    const rig = mount(
      '<input id="a" class="f" aria-invalid="false"><input id="b" class="f"><input id="c" class="f">',
      CSS,
    );
    expect(cueCount()).toBe(0);

    $('#a').setAttribute('aria-invalid', 'true');
    rig.flush();
    expect(cueOf('#a')).toBe('outline:dashed');
    expect(cueCount()).toBe(1);

    $('#a').setAttribute('aria-invalid', 'false');
    rig.flush();
    expect(cueOf('#a')).toBeNull();
    expect(cueCount()).toBe(0);
  });

  it('aria-selected moves between tabs: the underline follows, one cue at a time', () => {
    const rig = mount(
      `<div role="tablist">
        <button id="t1" role="tab" class="tab" aria-selected="true">Home</button>
        <button id="t2" role="tab" class="tab" aria-selected="false">Docs</button>
        <button id="t3" role="tab" class="tab" aria-selected="false">About</button>
      </div>`,
      CSS,
    );
    expect(cueOf('#t1')).toBe('underline');

    $('#t1').setAttribute('aria-selected', 'false');
    $('#t2').setAttribute('aria-selected', 'true');
    rig.flush();
    expect(cueOf('#t1')).toBeNull();
    expect(cueOf('#t2')).toBe('underline');
    expect(cueCount()).toBe(1);

    $('#t2').setAttribute('aria-selected', 'false');
    $('#t3').setAttribute('aria-selected', 'true');
    rig.flush();
    expect([cueOf('#t1'), cueOf('#t2'), cueOf('#t3')]).toEqual([null, null, 'underline']);
  });

  it('aria-current added and removed', () => {
    const rig = mount(
      '<nav><a id="n1" class="nav-link" href="#">Home</a><a id="n2" class="nav-link" href="#">About</a></nav>',
      CSS,
    );
    expect(cueCount()).toBe(0);
    $('#n1').setAttribute('aria-current', 'page');
    rig.flush();
    expect(cueOf('#n1')).toBe('underline');
    $('#n1').removeAttribute('aria-current');
    rig.flush();
    expect(cueCount()).toBe(0);
  });

  it('aria-pressed toggles', () => {
    const rig = mount(
      '<button id="b1" class="toggle" aria-pressed="false">Bold</button><button id="b2" class="toggle" aria-pressed="false">Italic</button>',
      CSS,
    );
    expect(cueCount()).toBe(0);
    $('#b1').setAttribute('aria-pressed', 'true');
    rig.flush();
    expect(cueOf('#b1')).toBe('underline');
    $('#b1').setAttribute('aria-pressed', 'false');
    rig.flush();
    expect(cueCount()).toBe(0);
  });

  it('class success -> error: the old glyph is replaced, not accumulated', () => {
    const rig = mount(
      '<span id="a" class="badge success">Order 1</span><span id="b" class="badge pending">Order 2</span>',
      CSS,
    );
    expect(describeCue(cueOf('#a'))).toBe('after ✓');

    $('#a').className = 'badge error';
    rig.flush();
    expect(describeCue(cueOf('#a'))).toBe('after ×');
    expect(cueCount()).toBe(1);

    $('#a').className = 'badge pending';
    rig.flush();
    expect(cueCount()).toBe(0);
  });

  it('a status node inserted later gets a cue; removing it leaves none behind', () => {
    const rig = mount('<div id="list"><span class="status online"></span></div>', CSS);
    expect(cueCount()).toBe(1);

    const added = element('<span id="new" class="status offline"></span>');
    $('#list').appendChild(added);
    rig.flush();
    expect(describeCue(cueOf('#new'))).toBe('inner ×');
    expect(cueCount()).toBe(2);

    added.remove();
    rig.flush();
    expect(cueCount()).toBe(1);
    expect(document.querySelector('#new')).toBeNull();
  });

  it('state text: "Order 5" -> "Failed" removes the cue (the words now say it), and back', () => {
    const rig = mount(
      '<span id="a" class="badge error">Order 5</span><span id="b" class="badge success">Order 6</span>',
      CSS,
    );
    expect(describeCue(cueOf('#a'))).toBe('after ×');

    $('#a').firstChild!.nodeValue = 'Failed';
    rig.flush();
    expect(cueOf('#a')).toBeNull();

    $('#a').firstChild!.nodeValue = 'Order 5';
    rig.flush();
    expect(describeCue(cueOf('#a'))).toBe('after ×');
  });

  it('state text replaced through textContent behaves the same', () => {
    const rig = mount(
      '<span id="a" class="badge error">Order 5</span><span id="b" class="badge success">Order 6</span>',
      CSS,
    );
    $('#a').textContent = 'Ошибка';
    rig.flush();
    expect(cueOf('#a')).toBeNull();
    $('#a').textContent = 'Order 5';
    rig.flush();
    expect(cueOf('#a')).not.toBeNull();
  });

  it('a change that does not concern semantics does not start a semantic pass', () => {
    const rig = mount(
      '<span id="a" class="badge success">Order 1</span><span class="badge error">x</span>',
      CSS,
    );
    rig.flush();
    const before = rig.controller.dynamic.diagnostics().semantic.semanticPasses;
    $('#a').setAttribute('data-unrelated', '1');
    $('#a').setAttribute('tabindex', '0');
    rig.flush();
    expect(rig.controller.dynamic.diagnostics().semantic.semanticPasses).toBe(before);
  });
});

describe('M6 native form validity (the one event bridge)', () => {
  const FORM =
    '<input id="e" type="email" required class="f"><input id="o" class="f"><input id="p" class="f">';

  it('typing into a field re-examines it without any DOM mutation', () => {
    const rig = mount(FORM, CSS);
    const email = $('#e') as HTMLInputElement;
    // Untouched and required: required, not invalid.
    expect(rig.controller.inspectSemantics(email).result).toMatchObject({
      status: 'classified',
      state: 'required',
    });
    rig.flush();
    const before = rig.controller.dynamic.diagnostics();

    email.value = 'not-an-email'; // no attribute, no child list: nothing for the MutationObserver
    email.dispatchEvent(new Event('input', { bubbles: true }));
    const after = rig.controller.dynamic.flush();

    expect(after.semanticInvalidations).toBe(before.semanticInvalidations + 1);
    expect(after.incrementalPasses).toBe(before.incrementalPasses + 1);
    expect(after.semantic.semanticPasses).toBe(before.semantic.semanticPasses + 1);
    expect(rig.controller.inspectSemantics(email).result).toMatchObject({
      status: 'classified',
      state: 'invalid',
      confidence: 'high',
    });
  });

  it('events from anything that is not a form field are ignored', () => {
    const rig = mount(`${FORM}<p id="x">text</p>`, CSS);
    rig.flush();
    const before = rig.controller.dynamic.diagnostics().semanticInvalidations;
    $('#x').dispatchEvent(new Event('input', { bubbles: true }));
    $('#x').dispatchEvent(new Event('focusout', { bubbles: true }));
    expect(rig.flush().semanticInvalidations).toBe(before);
  });

  it('many keystrokes in one frame are one pass', () => {
    const rig = mount(FORM, CSS);
    rig.flush();
    const before = rig.controller.dynamic.diagnostics();
    const email = $('#e') as HTMLInputElement;
    for (const value of ['a', 'ab', 'abc', 'abcd']) {
      email.value = value;
      email.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const after = rig.flush();
    expect(after.incrementalPasses).toBe(before.incrementalPasses + 1);
  });

  it('the bridge is off with the adaptation: no listener, no work', () => {
    const rig = mount(FORM, CSS);
    rig.controller.disableAdaptation();
    const email = $('#e') as HTMLInputElement;
    email.value = 'x';
    email.dispatchEvent(new Event('input', { bubbles: true }));
    expect(rig.controller.dynamic.diagnostics().semanticInvalidations).toBe(0);
  });

  it('the bridge is not installed when semantic cues are off', () => {
    const rig = mount(FORM, CSS, { ...SETTINGS, semanticCuesEnabled: false });
    const email = $('#e') as HTMLInputElement;
    email.value = 'x';
    email.dispatchEvent(new Event('input', { bubbles: true }));
    expect(rig.flush().semanticInvalidations).toBe(0);
  });
});

describe('M6 batching and budgets', () => {
  it('100 status rows changing state in one batch: one incremental pass, no full rescan', () => {
    const rows = Array.from(
      { length: 100 },
      (_, i) => `<li><span id="d${i}" class="status online"></span></li>`,
    );
    const rig = mount(`<ul id="list">${rows.join('')}</ul>`, CSS);
    expect(cueCount()).toBe(100);
    rig.flush();
    const before = rig.controller.dynamic.diagnostics();

    for (let i = 0; i < 100; i += 1) $(`#d${i}`).className = 'status offline';
    const after = rig.flush();

    expect(after.batches - before.batches).toBe(1);
    expect(after.incrementalPasses - before.incrementalPasses).toBe(1);
    expect(after.fullRescans).toBe(before.fullRescans);
    expect(after.semantic.semanticPasses - before.semantic.semanticPasses).toBe(1);
    expect(cueCount()).toBe(100);
    for (let i = 0; i < 100; i += 1) expect(describeCue(cueOf(`#d${i}`))).toBe('inner ×');
  });

  it('a pass never looks at more than its structural budget', () => {
    const many = Array.from(
      { length: 3000 },
      (_, i) => `<span class="status online" id="m${i}"></span>`,
    );
    const rig = mount(`<div>${many.join('')}</div>`, CSS);
    const { semantic } = rig.controller.dynamic.diagnostics();
    expect(semantic.semanticCandidates).toBeLessThanOrEqual(1500);
    expect(cueCount()).toBeLessThanOrEqual(1500);
  });
});

describe('M6 plan equals actual browser behavior', () => {
  it('when the browser renders no pseudo-element, no cue is kept and none is claimed', () => {
    document.head.innerHTML = `<style>${CSS}</style>`;
    document.body.innerHTML =
      '<span id="a" class="badge success">Order 1</span><span id="b" class="badge error">Order 2</span>';
    const base = defaultFactsEnvironment(document);
    const controller = createDynamicContentController(
      document,
      { now: () => 0 },
      { scheduler: createManualScheduler() },
      { env: { view: base.view, pseudoContent: () => 'none' } },
    );
    try {
      controller.enableAdaptation('https://example.com', {
        ...DEFAULT_USER_SETTINGS,
        visionProfile: 'deuteranopia',
      });
      const { semantic } = controller.dynamic.diagnostics();
      expect(semantic.cuesPlanned).toBe(2);
      expect(semantic.cuesApplied).toBe(0);
      expect(semantic.cuesNotApplied).toBe(2);
      expect(semantic.cuesActive).toBe(0);
      expect(document.querySelectorAll(`[${CUE_ATTRIBUTE}]`).length).toBe(0);
    } finally {
      controller.dynamic.dispose();
      controller.disableAdaptation();
    }
  });
});
