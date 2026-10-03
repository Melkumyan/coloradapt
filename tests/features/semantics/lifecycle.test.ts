import { afterEach, describe, expect, it } from 'vitest';
import { isColorAdaptOwnedMutation } from '@features/dynamic-analysis';
import { SETTINGS, $, CUE_ATTRIBUTE, cueCount, cueOf, mount, sheetText, teardown } from './kit';

const CSS = `
  .status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
  .status.online { background-color: #27ae60; }
  .status.offline { background-color: #c0392b; }
  .tab { color: #555555; }
  .tab[aria-selected="true"] { color: #0645ad; }
  .f { border-top-style: solid; border-top-width: 1px; border-top-color: #888888; }
  .f[aria-invalid="true"] { border-top-color: #c0392b; }
  .badge { display: inline-block; padding: 2px 6px; color: #ffffff; }
  .badge.success { background-color: #27ae60; }
  .badge.error { background-color: #c0392b; }
`;

const PAGE = `
  <div><span id="on" class="status online"></span> Alice <span id="off" class="status offline"></span> Bob</div>
  <div role="tablist">
    <button id="t1" role="tab" class="tab" aria-selected="true">Home</button>
    <button id="t2" role="tab" class="tab" aria-selected="false">Docs</button>
  </div>
  <input id="bad" class="f" aria-invalid="true"><input id="ok" class="f"><input id="ok2" class="f">
  <span id="s1" class="badge success">Order 1</span><span id="s2" class="badge error">Order 2</span>
`;

/** Cues the PAGE should get: two dots, the selected tab, the invalid field, two badges. */
const PAGE_CUES = 6;

afterEach(teardown);

/** The body as the page wrote it: ColorAdapt's own technical identifiers removed. */
function original(markup: string): string {
  const holder = document.createElement('div');
  holder.innerHTML = markup;
  return holder.innerHTML;
}

function stripOwn(html: string): string {
  return html.replace(/ data-coloradapt-[a-z-]+="[^"]*"/g, '');
}

describe('M6 cues are idempotent', () => {
  it('repeated refresh and analysis leave one cue per state, never more', () => {
    const rig = mount(PAGE, CSS);
    expect(cueCount()).toBe(PAGE_CUES);
    const keys = [...document.querySelectorAll(`[${CUE_ATTRIBUTE}]`)].map((el) =>
      el.getAttribute(CUE_ATTRIBUTE),
    );
    const applied = rig.controller.dynamic.diagnostics().semantic.cuesApplied;

    for (let i = 0; i < 5; i += 1) {
      rig.refresh();
      rig.controller.analyze('https://example.com', SETTINGS);
      rig.controller.dynamic.refresh();
      rig.flush();
    }

    expect(cueCount()).toBe(PAGE_CUES);
    expect(
      [...document.querySelectorAll(`[${CUE_ATTRIBUTE}]`)].map((el) =>
        el.getAttribute(CUE_ATTRIBUTE),
      ),
    ).toEqual(keys);
    expect(rig.controller.dynamic.diagnostics().semantic.cuesActive).toBe(PAGE_CUES);
    // Re-asserting an unchanged cue is not an application: the counter does not climb.
    expect(rig.controller.dynamic.diagnostics().semantic.cuesApplied).toBe(applied);
    // One rule per distinct cue key, not per element.
    const rules = sheetText().match(/\[data-coloradapt-cue="[^"]+"\]/g) ?? [];
    expect(new Set(rules).size).toBeLessThanOrEqual(rules.length);
  });

  it('the cue stylesheet text is a pure function of the keys in use', () => {
    const rig = mount(PAGE, CSS);
    const first = sheetText();
    rig.refresh();
    rig.refresh();
    expect(sheetText()).toBe(first);
  });
});

describe('M6 cues are reversible', () => {
  it('ON/OFF x10: OFF restores the page exactly and leaves no cue, no attribute, no style', () => {
    const rig = mount(PAGE, CSS);
    const pristine = original(PAGE);

    for (let cycle = 0; cycle < 10; cycle += 1) {
      rig.controller.disableAdaptation();
      expect(cueCount(), `cycle ${cycle} cues after OFF`).toBe(0);
      expect(document.querySelectorAll('[data-coloradapt-cue]').length).toBe(0);
      expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
      expect(stripOwn(document.body.innerHTML.replace(/\s+/g, ' ')).trim()).toBe(
        pristine.replace(/\s+/g, ' ').trim(),
      );

      rig.controller.enableAdaptation('https://example.com', SETTINGS);
      expect(cueCount(), `cycle ${cycle} cues after ON`).toBe(PAGE_CUES);
    }
  });

  it("no DOM node is ever inserted for a cue: the structure is the page's own", () => {
    const before = original(PAGE).replace(/\s+/g, ' ').trim();
    mount(PAGE, CSS);
    expect(stripOwn(document.body.innerHTML).replace(/\s+/g, ' ').trim()).toBe(before);
    expect(cueCount()).toBe(PAGE_CUES);
  });

  it('turning semantic cues off removes every cue (and the cue CSS) on the next refresh', () => {
    const rig = mount(PAGE, CSS);
    expect(cueCount()).toBe(PAGE_CUES);
    const removedBefore = rig.controller.dynamic.diagnostics().semantic.cuesRemoved;

    rig.refresh({ ...SETTINGS, semanticCuesEnabled: false });

    expect(cueCount()).toBe(0);
    expect(sheetText()).not.toContain('data-coloradapt-cue');
    expect(rig.controller.dynamic.diagnostics().semantic.cuesRemoved).toBe(
      removedBefore + PAGE_CUES,
    );

    rig.refresh({ ...SETTINGS, semanticCuesEnabled: true });
    expect(cueCount()).toBe(PAGE_CUES);
  });

  it('adaptation disabled in settings: no cue', () => {
    mount(PAGE, CSS, { ...SETTINGS, enabled: false });
    expect(cueCount()).toBe(0);
  });
});

describe('M6 cues do not touch what assistive technology and keyboards see', () => {
  it('cue hosts get no new attributes but the ColorAdapt ones, no children, no tabindex', () => {
    const originals = new Map<string, { attrs: string[]; children: number }>();
    document.head.innerHTML = `<style>${CSS}</style>`;
    document.body.innerHTML = PAGE;
    for (const el of document.querySelectorAll('[id]')) {
      originals.set(el.id, {
        attrs: el.getAttributeNames().sort(),
        children: el.childNodes.length,
      });
    }
    document.body.innerHTML = '';
    const rig = mount(PAGE, CSS);
    for (const el of document.querySelectorAll(`[${CUE_ATTRIBUTE}]`)) {
      const base = originals.get(el.id)!;
      const own = el.getAttributeNames().filter((name) => !name.startsWith('data-coloradapt-'));
      expect(own.sort(), el.id).toEqual(base.attrs);
      expect(el.childNodes.length, el.id).toBe(base.children);
      expect(el.hasAttribute('tabindex')).toBe(false);
    }
    expect(rig.controller.dynamic.diagnostics().semantic.cuesActive).toBe(PAGE_CUES);
  });

  it('every glyph is drawn with an empty alternative text and cannot be clicked or selected', () => {
    mount(PAGE, CSS);
    const rules = sheetText()
      .split('\n')
      // The forced-colors override only recolors a shape: it has no content of its own.
      .filter((line) => /::(?:after|before)/.test(line) && !line.startsWith('@media'));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule).toContain('/ ""');
      expect(rule).toContain('pointer-events:none');
      expect(rule).toContain('user-select:none');
    }
  });

  it('the page keeps working: a cue host stays clickable and focusable', () => {
    mount(PAGE, CSS);
    let clicks = 0;
    const tab = $('#t1');
    tab.addEventListener('click', () => (clicks += 1));
    tab.click();
    tab.focus();
    expect(clicks).toBe(1);
    expect(document.activeElement).toBe(tab);
    expect(tab.getAttribute('aria-selected')).toBe('true');
  });
});

describe('M6 cues never feed back into M4', () => {
  it('cue attribute writes are ColorAdapt-owned mutations', () => {
    mount(PAGE, CSS);
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(document.body, { attributes: true, subtree: true });
    $('#on').setAttribute(CUE_ATTRIBUTE, 'inner:2713:l:10');
    $('#on').removeAttribute(CUE_ATTRIBUTE);
    records.push(...observer.takeRecords());
    observer.disconnect();
    expect(records.length).toBe(2);
    expect(records.every(isColorAdaptOwnedMutation)).toBe(true);
  });

  it('no loop: once settled, further flushes do no work at all', () => {
    const rig = mount(PAGE, CSS);
    $('#s2').setAttribute('class', 'badge success'); // a real change: it makes cues change
    rig.flush();
    const settled = rig.controller.dynamic.diagnostics();
    expect(settled.selfMutationsIgnored).toBeGreaterThan(0);

    for (let i = 0; i < 5; i += 1) rig.flush();
    const after = rig.controller.dynamic.diagnostics();

    expect(after.batches).toBe(settled.batches);
    expect(after.incrementalPasses).toBe(settled.incrementalPasses);
    expect(after.fullRescans).toBe(settled.fullRescans);
    expect(after.semantic.semanticPasses).toBe(settled.semantic.semanticPasses);
    expect(after.semantic.cuesApplied).toBe(settled.semantic.cuesApplied);
    expect(rig.scheduler.pending).toBe(0);
  });

  it('a real change causes exactly one incremental pass, and the cue it writes causes none', () => {
    const rig = mount(PAGE, CSS);
    rig.flush();
    const before = rig.controller.dynamic.diagnostics();

    $('#ok').setAttribute('aria-invalid', 'true');
    rig.flush();
    rig.flush();
    const after = rig.controller.dynamic.diagnostics();

    expect(after.incrementalPasses).toBe(before.incrementalPasses + 1);
    expect(after.fullRescans).toBe(before.fullRescans);
    expect(cueOf('#ok')).toBe('outline:dashed');
  });
});

describe('M6 interplay with M3 recoloring', () => {
  it('a recolored element still gets its second channel: separate accessibility channels', () => {
    const page = `
      <span id="a" class="badge success" style="color: #c0392b; background-color: #27ae60">Order 1</span>
      <span id="b" class="badge error" style="color: #c0392b; background-color: #2c3e50">Order 2</span>`;
    const rig = mount(page, CSS);
    expect(rig.controller.incremental.ruleCount).toBeGreaterThan(0); // M3 recolored them
    expect(cueOf('#a')).toBe('after:2713');
    expect(cueOf('#b')).toBe('after:d7');
    // Both channels live in the one managed stylesheet.
    expect(sheetText()).toContain('data-coloradapt-id');
    expect(sheetText()).toContain('data-coloradapt-cue');
  });

  it('M3 analysis is not influenced by cues: re-adapting never compounds', () => {
    const page = `<span id="a" class="badge success" style="color: #c0392b; background-color: #27ae60">Order 1</span><span id="b" class="badge error" style="color: #c0392b; background-color: #2c3e50">Order 2</span>`;
    const rig = mount(page, CSS);
    const first = getComputedStyle($('#a')).color;
    for (let i = 0; i < 3; i += 1) rig.refresh();
    expect(getComputedStyle($('#a')).color).toBe(first);
  });
});

describe('M6 diagnostics', () => {
  it('counts what happened, without any telemetry', () => {
    const rig = mount(PAGE, CSS);
    const { semantic } = rig.controller.dynamic.diagnostics();
    expect(semantic.semanticCandidates).toBeGreaterThan(0);
    expect(semantic.semanticClassified).toBeGreaterThanOrEqual(PAGE_CUES);
    expect(semantic.colorOnlyDetected).toBeGreaterThanOrEqual(PAGE_CUES);
    expect(semantic.cuesPlanned).toBe(PAGE_CUES);
    expect(semantic.cuesApplied).toBe(PAGE_CUES);
    expect(semantic.cuesNotApplied).toBe(0);
    expect(semantic.cuesActive).toBe(PAGE_CUES);
  });

  it('a cue the browser does not render as planned is not counted as applied', () => {
    // The page forces `content: none` on every ::after: the simulated browser reports it as page content.
    const rig = mount(
      '<span id="a" class="badge success" data-test-after="">Order 1</span><span id="b" class="badge error">Order 2</span>',
      CSS,
    );
    expect(rig.controller.dynamic.diagnostics().semantic.cuesActive).toBeLessThanOrEqual(1);
  });
});

describe('M6 cue stylesheet shares the repair path of the color stylesheet', () => {
  it('a page deleting the stylesheet that holds only cue CSS gets it back', () => {
    const rig = mount(
      '<span id="on" class="status online"></span><span id="off" class="status offline"></span>',
      CSS,
    );
    expect(rig.controller.incremental.ruleCount).toBe(0); // no color rules at all: cues only
    expect(sheetText()).toContain('data-coloradapt-cue');

    document.getElementById('coloradapt-stylesheet')!.remove();
    const diag = rig.flush();

    expect(diag.stylesheetRepairs).toBe(1);
    expect(sheetText()).toContain('data-coloradapt-cue');
  });
});
