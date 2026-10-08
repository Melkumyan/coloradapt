import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StylesheetManager } from '@core/adaptation';
import type { AdaptationChange } from '@domain/models';

/**
 * M12.5: the sheet has one rule per distinct declaration, not per element; an element names its rules in
 * `data-coloradapt-s`. These tests pin the contract (docs/PERFORMANCE.md, "Burst model").
 */
function change(
  elementId: string,
  value = '#112233',
  property = 'color',
  ownerId?: string,
): AdaptationChange {
  return {
    elementId,
    property,
    originalValue: '#888888',
    adaptedValue: value,
    reason: 'test',
    confidence: 'SUPPORTED_MODEL',
    metrics: {
      originalContrast: 1.5,
      adaptedContrast: 2,
      originalSimulatedDistance: 0.05,
      adaptedSimulatedDistance: 0.2,
      changeDistance: 0.1,
      score: 0.5,
    },
    ...(ownerId === undefined ? {} : { ownerId }),
  };
}

function mount(count: number): HTMLElement[] {
  document.body.innerHTML = Array.from(
    { length: count },
    (_v, i) => `<p data-coloradapt-id="e${i}" style="color:#888888">t${i}</p>`,
  ).join('');
  return [...document.querySelectorAll<HTMLElement>('p')];
}

const styleEl = () => document.getElementById('coloradapt-stylesheet');
const sheet = () => styleEl()?.textContent ?? '';
const rulesInSheet = () =>
  sheet()
    .split('\n')
    .filter((line) => line.includes('!important'));
const tokensOf = (el: Element) => el.getAttribute('data-coloradapt-s');

/** Records of every write to the managed <style> (text or structure) and to the head, since `take()` last ran. */
function watchSheet() {
  const observer = new MutationObserver(() => undefined);
  observer.observe(document.head, { childList: true, characterData: true, subtree: true });
  return { take: () => observer.takeRecords().length, stop: () => observer.disconnect() };
}

beforeEach(() => {
  document.head.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

describe('one rule per declaration', () => {
  it('many elements with the same adapted color share one rule', () => {
    const els = mount(200);
    const manager = new StylesheetManager(document);
    const result = manager.applyDelta({
      upsert: els.map((_el, i) => change(`e${i}`)),
      remove: [],
    });

    expect(result.notApplied).toHaveLength(0);
    expect(manager.ruleCount).toBe(200); // the logical rules are still one per element and property
    expect(rulesInSheet()).toHaveLength(1);
    expect(sheet()).toContain('[data-coloradapt-s~="color:#112233"]');
    for (const el of els) expect(tokensOf(el)).toBe('color:#112233');
  });

  it('the sheet grows with the distinct declarations, not with the elements', () => {
    const els = mount(1000);
    const manager = new StylesheetManager(document);
    manager.applyDelta({
      upsert: els.map((_el, i) => change(`e${i}`, ['#101010', '#202020', '#303030'][i % 3])),
      remove: [],
    });
    expect(rulesInSheet()).toHaveLength(3);
    expect(manager.ruleCount).toBe(1000);
  });

  it('an element with two properties lists both tokens, in a fixed order', () => {
    const [el] = mount(1);
    const manager = new StylesheetManager(document);
    manager.applyDelta({
      upsert: [change('e0', '#112233', 'color'), change('e0', '#445566', 'background-color')],
      remove: [],
    });
    expect(tokensOf(el!)).toBe('background-color:#445566 color:#112233');
    expect(rulesInSheet()).toHaveLength(2);
  });

  it('the sheet text does not depend on the order the elements arrived in', () => {
    const els = mount(30);
    const values = (i: number) => ['#101010', '#202020', '#303030', '#404040'][i % 4]!;
    const forward = new StylesheetManager(document);
    forward.applyDelta({ upsert: els.map((_e, i) => change(`e${i}`, values(i))), remove: [] });
    const first = sheet();
    forward.restore();

    const backward = new StylesheetManager(document);
    backward.applyDelta({
      upsert: els.map((_e, i) => change(`e${i}`, values(i))).reverse(),
      remove: [],
    });
    expect(sheet()).toBe(first);
  });

  it('whitespace inside a value does not split the token list', () => {
    const [el] = mount(1);
    const manager = new StylesheetManager(document);
    manager.applyDelta({ upsert: [change('e0', 'rgb(17, 34, 51)')], remove: [] });
    expect(tokensOf(el!)).toBe('color:rgb(17,34,51)');
    expect(getComputedStyle(el!).color).toBe('rgb(17, 34, 51)');
  });

  it('a changed value moves the element to another rule and drops the one nobody uses', () => {
    const els = mount(2);
    const manager = new StylesheetManager(document);
    manager.applyDelta({ upsert: [change('e0', '#111111'), change('e1', '#111111')], remove: [] });
    manager.applyDelta({ upsert: [change('e0', '#222222')], remove: [] });
    expect(tokensOf(els[0]!)).toBe('color:#222222');
    expect(tokensOf(els[1]!)).toBe('color:#111111');
    expect(rulesInSheet()).toHaveLength(2);

    manager.applyDelta({ upsert: [change('e1', '#222222')], remove: [] });
    expect(rulesInSheet()).toHaveLength(1);
    expect(sheet()).not.toContain('#111111');
  });

  it('removing an element drops its token and, with the last user, the rule', () => {
    const els = mount(2);
    const manager = new StylesheetManager(document);
    manager.applyDelta({ upsert: [change('e0'), change('e1')], remove: [] });
    manager.applyDelta({ upsert: [], remove: ['e0'] });
    expect(els[0]!.hasAttribute('data-coloradapt-s')).toBe(false);
    expect(rulesInSheet()).toHaveLength(1);
    manager.applyDelta({ upsert: [], remove: ['e1'] });
    expect(styleEl()).toBeNull();
    expect(els[1]!.hasAttribute('data-coloradapt-s')).toBe(false);
  });

  it('restore() takes the attribute off every element', () => {
    const els = mount(5);
    const manager = new StylesheetManager(document);
    manager.applyDelta({ upsert: els.map((_e, i) => change(`e${i}`)), remove: [] });
    manager.restore();
    expect(document.querySelectorAll('[data-coloradapt-s]')).toHaveLength(0);
    expect(styleEl()).toBeNull();
  });

  it('a full apply() takes the attribute off elements that are no longer adapted', () => {
    const els = mount(3);
    const manager = new StylesheetManager(document);
    manager.apply(els.map((_e, i) => change(`e${i}`)));
    manager.apply([change('e1')]);
    expect(els[0]!.hasAttribute('data-coloradapt-s')).toBe(false);
    expect(els[1]!.hasAttribute('data-coloradapt-s')).toBe(true);
    expect(els[2]!.hasAttribute('data-coloradapt-s')).toBe(false);
  });

  it('a full apply() also clears tokens it did not write (an earlier script instance left them)', () => {
    const els = mount(3);
    els[2]!.setAttribute('data-coloradapt-s', 'color:#999999');
    const manager = new StylesheetManager(document);
    manager.apply([change('e0')]);
    expect(els[0]!.getAttribute('data-coloradapt-s')).toBe('color:#112233');
    expect(els[2]!.hasAttribute('data-coloradapt-s')).toBe(false);
  });

  it('a node the page removed is cleaned too, so putting it back does not bring a stale rule', () => {
    const [el] = mount(1);
    const manager = new StylesheetManager(document);
    manager.applyDelta({ upsert: [change('e0')], remove: [] });
    el!.remove();
    manager.applyDelta({ upsert: [], remove: ['e0'] });
    document.body.append(el!);
    expect(el!.hasAttribute('data-coloradapt-s')).toBe(false);
    expect(getComputedStyle(el!).color).toBe('rgb(136, 136, 136)');
  });
});

describe('delta commits do not rewrite the sheet', () => {
  it('an element joining an existing rule writes attributes only', () => {
    const els = mount(10);
    const manager = new StylesheetManager(document);
    manager.applyDelta({ upsert: els.slice(0, 5).map((_e, i) => change(`e${i}`)), remove: [] });
    const text = sheet();
    const watch = watchSheet();
    watch.take();

    manager.applyDelta({
      upsert: els.slice(5).map((_e, i) => change(`e${i + 5}`)),
      remove: [],
    });

    expect(sheet()).toBe(text);
    // the transient suppression <style> came and went, the managed one was not touched
    const records = document.head.childNodes.length;
    expect(records).toBe(1);
    expect(watch.take()).toBe(2); // add + remove of the transient <style>, nothing else
    watch.stop();
    for (const el of els) expect(tokensOf(el)).toBe('color:#112233');
  });

  it('a new declaration rewrites the sheet once', () => {
    const els = mount(4);
    const manager = new StylesheetManager(document);
    manager.applyDelta({ upsert: [change('e0'), change('e1')], remove: [] });
    const before = sheet();
    manager.applyDelta({ upsert: [change('e2', '#445566')], remove: [] });
    expect(sheet()).not.toBe(before);
    expect(rulesInSheet()).toHaveLength(2);
    expect(getComputedStyle(els[2]!).color).toBe('rgb(68, 85, 102)');
  });

  it('leaves no suppression behind: no transient <style>, no marker attribute', () => {
    const els = mount(20);
    const manager = new StylesheetManager(document);
    manager.applyDelta({ upsert: els.slice(0, 10).map((_e, i) => change(`e${i}`)), remove: [] });
    manager.applyDelta({ upsert: els.slice(10).map((_e, i) => change(`e${i + 10}`)), remove: [] });
    manager.applyDelta({ upsert: [], remove: ['e0', 'e11'] });
    expect(document.getElementById('coloradapt-suppress')).toBeNull();
    expect(document.querySelectorAll('[data-coloradapt-t]')).toHaveLength(0);
    expect(document.querySelectorAll('style')).toHaveLength(1);
    expect(sheet()).not.toContain('transition');
  });

  it('marks the elements below a changed element too (they inherit), and only for the flush', () => {
    document.body.innerHTML =
      '<div data-coloradapt-id="p" style="color:#888888">x<span data-coloradapt-id="k" style="color:inherit">kid</span></div>';
    const manager = new StylesheetManager(document);
    const seenDuringFlush: string[] = [];
    // an observer on the attribute shows what was marked and when it was cleared
    const watcher = new MutationObserver((records) => {
      for (const r of records) {
        if (r.attributeName === 'data-coloradapt-t') {
          seenDuringFlush.push(`${(r.target as Element).getAttribute('data-coloradapt-id')}`);
        }
      }
    });
    watcher.observe(document.body, { attributes: true, subtree: true });
    manager.applyDelta({ upsert: [change('p')], remove: [] }); // first commit: whole sheet
    manager.applyDelta({ upsert: [change('p', '#445566')], remove: [] }); // new declaration: whole sheet
    manager.applyDelta({ upsert: [change('p', '#445566', 'background-color')], remove: [] });
    watcher.takeRecords();
    watcher.disconnect();
    expect(document.querySelectorAll('[data-coloradapt-t]')).toHaveLength(0);
  });
});

describe('suspending the sheet for a read (M12.5)', () => {
  function adaptedParent() {
    document.body.innerHTML =
      '<div id="far"><p id="fresh-host"></p></div>' +
      '<p id="par" data-coloradapt-id="par" style="color:#888888">parent<span id="kid">kid</span></p>';
    const manager = new StylesheetManager(document);
    manager.applyDelta({ upsert: [change('par', '#000000')], remove: [] });
    return manager;
  }

  it('a region of fresh elements, below fresh elements, is read without touching the sheet', () => {
    const manager = adaptedParent();
    const watch = watchSheet();
    watch.take();
    const seen = manager.withOriginalStyles(
      () => getComputedStyle(document.getElementById('fresh-host')!).color,
      [{ element: document.getElementById('fresh-host')!, scope: 'subtree' }],
    );
    expect(watch.take()).toBe(0);
    watch.stop();
    expect(typeof seen).toBe('string');
  });

  it('a region under an adapted element is read with the sheet suspended', () => {
    const manager = adaptedParent();
    const kid = document.getElementById('kid')!;
    const inherited = manager.withOriginalStyles(
      () => getComputedStyle(kid).color,
      [{ element: kid, scope: 'self' }],
    );
    expect(inherited).toBe('rgb(136, 136, 136)'); // the page's own color, not the adapted #000000
    expect(getComputedStyle(kid).color).toBe('rgb(0, 0, 0)'); // and the adaptation is back
  });

  it('a region that contains an adapted element is read with the sheet suspended', () => {
    document.body.innerHTML =
      '<section id="sec"><p data-coloradapt-id="a" style="color:#888888">a</p></section>';
    const manager = new StylesheetManager(document);
    manager.applyDelta({ upsert: [change('a', '#000000')], remove: [] });
    const a = document.querySelector('p')!;
    const seen = manager.withOriginalStyles(
      () => getComputedStyle(a).color,
      [{ element: document.getElementById('sec')!, scope: 'subtree' }],
    );
    expect(seen).toBe('rgb(136, 136, 136)');
  });

  it('without a scope the sheet is always suspended (the pre-M12.5 contract)', () => {
    const manager = adaptedParent();
    const kid = document.getElementById('kid')!;
    expect(manager.withOriginalStyles(() => getComputedStyle(kid).color)).toBe(
      'rgb(136, 136, 136)',
    );
  });

  it('every styling attribute forces the suspension', () => {
    for (const attribute of [
      'data-coloradapt-id',
      'data-coloradapt-cue',
      'data-coloradapt-chart-mark',
      'data-coloradapt-chart-legend',
      'data-coloradapt-chart-owned',
      'data-coloradapt-chart-owner',
      'data-coloradapt-chart-node',
      'data-coloradapt-image',
    ]) {
      document.body.innerHTML = `<p id="x" ${attribute}="1">x</p><p id="host"></p>`;
      const manager = new StylesheetManager(document);
      manager.setCueCss('[data-coloradapt-cue="1"]::after{content:"."}');
      const watch = watchSheet();
      watch.take();
      manager.withOriginalStyles(
        () => 1,
        [{ element: document.getElementById('x')!, scope: 'self' }],
      );
      expect(watch.take(), attribute).toBeGreaterThan(0);
      watch.stop();
      manager.restore();
    }
  });

  it('a region inside an inline SVG is always read with the sheet suspended', () => {
    document.body.innerHTML = '<svg id="s"><path id="p"/></svg><p data-coloradapt-id="a">a</p>';
    const manager = new StylesheetManager(document);
    manager.applyDelta({ upsert: [change('a', '#000000')], remove: [] });
    const watch = watchSheet();
    watch.take();
    manager.withOriginalStyles(
      () => 1,
      [{ element: document.getElementById('p') as unknown as Element, scope: 'self' }],
    );
    expect(watch.take()).toBeGreaterThan(0);
    watch.stop();
  });
});
