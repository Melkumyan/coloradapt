import { afterEach, describe, expect, it } from 'vitest';
import {
  ELEMENT_ID_ATTRIBUTE,
  analyzeDocument,
  analyzeSubtrees,
  collectOwnedIds,
  getOwnedElementId,
} from '@core/analysis';
import { createDetailedAdaptationPlan, createAdaptationPlan } from '@core/adaptation';
import { toAnalysisResult } from '@core/analysis';
import { DEFAULT_USER_SETTINGS } from '@domain/models';
import { analyzerOptionsForMode } from '@features/page-analysis';

const STYLE = 'color: #c0392b; background-color: #27ae60;';
const opts = { now: () => 0 };
const byId = (id: string) => document.getElementById(id)!;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('analyzeSubtrees', () => {
  it('analyzes only the given subtree, including the root itself', () => {
    document.body.innerHTML = `
      <p id="outside" style="${STYLE}">outside</p>
      <div id="root"><p id="inside" style="${STYLE}">inside</p><span id="s" style="${STYLE}">s</span></div>
      <p id="self" style="${STYLE}">self</p>`;

    const result = analyzeSubtrees(
      [
        { element: byId('root'), scope: 'subtree' },
        { element: byId('self'), scope: 'subtree' },
      ],
      opts,
    );

    const ids = new Set([...result.nodes.values()].map((node) => node.id));
    expect(ids).toEqual(new Set(['inside', 's', 'self']));
    expect(byId('outside').hasAttribute(ELEMENT_ID_ATTRIBUTE)).toBe(false);
    expect(result.candidatesInspected).toBe(3);
    expect(result.rootsCompleted).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("scope 'self' looks at the element alone", () => {
    document.body.innerHTML = `<p id="p" style="${STYLE}">own <span id="c" style="${STYLE}">child</span></p>`;
    const result = analyzeSubtrees([{ element: byId('p'), scope: 'self' }], opts);
    expect([...result.nodes.values()].map((n) => n.id)).toEqual(['p']);
  });

  it('produces the same descriptors as a full pass for the same elements', () => {
    document.body.innerHTML = `<div id="root"><p id="a" style="${STYLE}">a</p><button id="b" style="${STYLE}">b</button></div>`;
    const full = analyzeDocument({ root: document, ...opts }).elements;
    const part = analyzeSubtrees([{ element: byId('root'), scope: 'subtree' }], opts).elements;
    expect(part).toEqual(full);
  });

  it('skips roots that are no longer connected and counts them as handled', () => {
    document.body.innerHTML = `<div id="root"><p style="${STYLE}">x</p></div>`;
    const root = byId('root');
    root.remove();
    const result = analyzeSubtrees([{ element: root, scope: 'subtree' }], opts);
    expect(result.elements).toHaveLength(0);
    expect(result.rootsCompleted).toBe(1);
  });

  it('starts no new root once the element budget is spent, and always starts the first', () => {
    document.body.innerHTML = Array.from(
      { length: 4 },
      (_, i) => `<div id="r${i}"><p style="${STYLE}">x</p></div>`,
    ).join('');
    const roots = [0, 1, 2, 3].map((i) => ({ element: byId(`r${i}`), scope: 'subtree' as const }));

    const result = analyzeSubtrees(roots, { ...opts, maxElements: 2 });

    expect(result.elements).toHaveLength(2);
    expect(result.rootsCompleted).toBe(2);
    expect(result.truncated).toBe(false);

    const none = analyzeSubtrees(roots, { ...opts, maxElements: 0 });
    expect(none.truncated).toBe(true); // budget zero cuts the first root itself
  });

  it('flags truncation when one root alone exceeds the budget', () => {
    document.body.innerHTML = `<div id="r">${`<p style="${STYLE}">x</p>`.repeat(5)}</div>`;
    const result = analyzeSubtrees([{ element: byId('r'), scope: 'subtree' }], {
      ...opts,
      maxElements: 3,
    });
    expect(result.elements).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.rootsCompleted).toBe(0);
  });

  it('the clock never cuts a root short, but a later root is not started once time is up', () => {
    document.body.innerHTML = `<div id="r1">${`<p style="${STYLE}">x</p>`.repeat(5)}</div><div id="r2"><p style="${STYLE}">y</p></div>`;
    let t = 0;
    const result = analyzeSubtrees(
      [
        { element: byId('r1'), scope: 'subtree' },
        { element: byId('r2'), scope: 'subtree' },
      ],
      { now: () => (t += 60), maxDurationMs: 50 },
    );
    expect(result.elements).toHaveLength(5); // the first root is complete however slow it was
    expect(result.truncated).toBe(false);
    expect(result.rootsCompleted).toBe(1); // r2 is left, whole, for the next pass
  });

  it('R1-5 root cause: on a slow machine the same 100 roots are split by the clock, on the logical clock they are not', () => {
    document.body.innerHTML = Array.from(
      { length: 100 },
      (_, i) => `<p id="p${i}" style="${STYLE}">x</p>`,
    ).join('');
    const roots = Array.from({ length: 100 }, (_, i) => ({
      element: byId(`p${i}`),
      scope: 'self' as const,
    }));
    let t = 0;
    const slow = analyzeSubtrees(roots, { now: () => (t += 60), maxDurationMs: 50 });
    expect(slow.rootsCompleted).toBe(1); // machine-dependent: the budget ran out after the first root
    // The E2E build's analyzer options (src/features/page-analysis/build-mode.ts): structural budgets only.
    const deterministic = analyzeSubtrees(roots, {
      ...analyzerOptionsForMode('e2e'),
      maxDurationMs: 50,
    });
    expect(deterministic.rootsCompleted).toBe(100);
    expect(deterministic.elements).toHaveLength(100);
  });

  it('the shipped build keeps the real clock: only the e2e mode swaps it', () => {
    expect(analyzerOptionsForMode('production')).toEqual({});
    expect(analyzerOptionsForMode(undefined)).toEqual({});
    expect(analyzerOptionsForMode('development')).toEqual({});
    expect(analyzerOptionsForMode('e2e').now?.()).toBe(0);
  });

  it('a root that does not fit next to the others is left whole, never started and cut', () => {
    document.body.innerHTML = [
      `<div id="a">${`<p style="${STYLE}">x</p>`.repeat(3)}</div>`,
      `<div id="b">${`<p style="${STYLE}">x</p>`.repeat(3)}</div>`,
      `<div id="c">${`<p style="${STYLE}">x</p>`.repeat(3)}</div>`,
    ].join('');
    const roots = ['a', 'b', 'c'].map((id) => ({ element: byId(id), scope: 'subtree' as const }));

    // budget 5: a (3) fits; b (3 more) would straddle it -> left whole
    const first = analyzeSubtrees(roots, { ...opts, maxElements: 5 });
    expect(first.rootsCompleted).toBe(1);
    expect(first.truncated).toBe(false);
    expect(first.elements).toHaveLength(3);

    // the next pass starts at b (now the first root) and takes b (3) but not c
    const second = analyzeSubtrees(roots.slice(1), { ...opts, maxElements: 5 });
    expect(second.rootsCompleted).toBe(1);
    expect(second.truncated).toBe(false);
    expect(second.elements).toHaveLength(3);

    const third = analyzeSubtrees(roots.slice(2), { ...opts, maxElements: 5 });
    expect(third.rootsCompleted).toBe(1);
    expect(third.elements).toHaveLength(3);
  });
});

describe('analyzeSubtrees: the slice budget (M12.5)', () => {
  const group = (id: string, rows: number) =>
    `<div id="${id}">${`<p style="${STYLE}">x</p>`.repeat(rows)}</div>`;
  const rootsOf = (...ids: string[]) =>
    ids.map((id) => ({ element: byId(id), scope: 'subtree' as const }));

  it('sliceElements decides how many regions share a pass, never what is analyzed', () => {
    document.body.innerHTML = ['a', 'b', 'c', 'd'].map((id) => group(id, 4)).join('');
    const roots = rootsOf('a', 'b', 'c', 'd');

    const whole = analyzeSubtrees(roots, opts);
    expect(whole.rootsCompleted).toBe(4);

    // slices of 8: two regions per pass, the same sixteen elements in two passes
    const first = analyzeSubtrees(roots, { ...opts, sliceElements: 8 });
    const second = analyzeSubtrees(roots.slice(first.rootsCompleted), {
      ...opts,
      sliceElements: 8,
    });
    expect([first.rootsCompleted, second.rootsCompleted]).toEqual([2, 2]);
    const ids = (pass: ReturnType<typeof analyzeSubtrees>) =>
      [...pass.nodes.values()].map((n) => n.id);
    expect(new Set([...ids(first), ...ids(second)])).toEqual(new Set(ids(whole)));
    expect(first.truncated || second.truncated).toBe(false);
  });

  it('the first region is taken whole whatever the slice budget (the analysis cap is what cuts)', () => {
    document.body.innerHTML = group('big', 12);
    const result = analyzeSubtrees(rootsOf('big'), { ...opts, sliceElements: 1 });
    expect(result.rootsCompleted).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.elements).toHaveLength(12);
  });

  it('the slice budget is capped by the analysis cap', () => {
    document.body.innerHTML = ['a', 'b'].map((id) => group(id, 3)).join('');
    const result = analyzeSubtrees(rootsOf('a', 'b'), {
      ...opts,
      maxElements: 4,
      sliceElements: 1000,
    });
    expect(result.rootsCompleted).toBe(1); // 3 + 3 > 4
  });

  it('a weight makes an element count for more: three heavy elements fill a slice of 30', () => {
    document.body.innerHTML = ['a', 'b', 'c'].map((id) => group(id, 3)).join('');
    const roots = rootsOf('a', 'b', 'c');
    const heavy = { ...opts, sliceElements: 30, sliceWeight: () => 10 };
    // a = 3 x 10 = 30 fills the slice; b would have to fit on top of it
    expect(analyzeSubtrees(roots, heavy).rootsCompleted).toBe(1);
    // the same slice with plain weights holds all three
    expect(analyzeSubtrees(roots, { ...opts, sliceElements: 30 }).rootsCompleted).toBe(3);
  });

  it('weights change only the number of passes: every region is analyzed once, in order', () => {
    document.body.innerHTML = ['a', 'b', 'c'].map((id) => group(id, 3)).join('');
    const roots = rootsOf('a', 'b', 'c');
    const run = (options: Parameters<typeof analyzeSubtrees>[1]) => {
      const analyzed: string[] = [];
      let rest = roots;
      let passes = 0;
      while (rest.length > 0) {
        const pass = analyzeSubtrees(rest, options);
        analyzed.push(...[...pass.nodes.values()].map((node) => node.id));
        rest = rest.slice(Math.max(1, pass.rootsCompleted));
        passes += 1;
      }
      return { passes, analyzed };
    };
    const heavy = run({ ...opts, sliceElements: 30, sliceWeight: () => 10 });
    const plain = run({ ...opts, sliceElements: 30 });
    expect(heavy.passes).toBe(3);
    expect(plain.passes).toBe(1);
    expect(heavy.analyzed).toHaveLength(9);
    expect(new Set(heavy.analyzed)).toEqual(new Set(plain.analyzed));
  });
});

describe('stable element ids', () => {
  it('keeps an element id across re-analysis', () => {
    document.body.innerHTML = `<p id="p" style="${STYLE}">x</p>`;
    const first = analyzeSubtrees([{ element: byId('p'), scope: 'self' }], opts).elements[0]!.id;
    byId('p').className = 'changed';
    const second = analyzeSubtrees([{ element: byId('p'), scope: 'self' }], opts).elements[0]!.id;
    expect(second).toBe(first);
    expect(getOwnedElementId(byId('p'))).toBe(first);
  });

  it('never gives two elements the same id, even for clones carrying the attribute', () => {
    document.body.innerHTML = `<div id="host"><p id="p" style="${STYLE}">x</p></div>`;
    analyzeDocument({ root: document, ...opts });
    const clone = byId('p').cloneNode(true) as HTMLElement;
    clone.id = 'copy';
    byId('host').appendChild(clone);
    expect(clone.getAttribute(ELEMENT_ID_ATTRIBUTE)).toBe(
      byId('p').getAttribute(ELEMENT_ID_ATTRIBUTE),
    );
    expect(getOwnedElementId(clone)).toBeNull();

    analyzeDocument({ root: document, ...opts });

    expect(clone.getAttribute(ELEMENT_ID_ATTRIBUTE)).not.toBe(
      byId('p').getAttribute(ELEMENT_ID_ATTRIBUTE),
    );
    expect(getOwnedElementId(clone)).not.toBeNull();
  });

  it('does not trust an id attribute the page wrote itself', () => {
    document.body.innerHTML = `<p id="p" data-coloradapt-id="ca-1" style="${STYLE}">x</p>`;
    expect(getOwnedElementId(byId('p'))).toBeNull();
    const id = analyzeDocument({ root: document, ...opts }).elements[0]!.id;
    expect(getOwnedElementId(byId('p'))).toBe(id);
  });

  it('collectOwnedIds ignores foreign attributes and honors scope', () => {
    document.body.innerHTML = `<div id="d"><p id="a" style="${STYLE}">a</p><p id="b" style="${STYLE}">b</p></div>`;
    analyzeDocument({ root: document, ...opts });
    const stray = document.createElement('i');
    stray.setAttribute(ELEMENT_ID_ATTRIBUTE, 'ca-stray');
    byId('d').appendChild(stray);

    const ids = collectOwnedIds(byId('d'));
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain('ca-stray');
    expect(collectOwnedIds(byId('d'), 'self')).toEqual([]);
    expect(collectOwnedIds(byId('a'), 'self')).toEqual([getOwnedElementId(byId('a'))]);
  });
});

describe('createDetailedAdaptationPlan', () => {
  it('is the same plan as createAdaptationPlan, with one outcome per element', () => {
    document.body.innerHTML = `
      <p id="bad" style="${STYLE}">bad</p>
      <p id="fine" style="color:#000;background-color:#fff">fine</p>
      <p id="grad" style="color:#c0392b;background-image:linear-gradient(red,blue)">grad</p>
      <img id="img" alt="">`;
    const pass = analyzeDocument({ root: document, ...opts });
    const analysis = toAnalysisResult('https://example.com', pass, [], 0);
    const settings = { ...DEFAULT_USER_SETTINGS, visionProfile: 'deuteranopia' as const };

    const detailed = createDetailedAdaptationPlan(analysis, settings);

    expect(detailed.plan).toEqual(createAdaptationPlan(analysis, settings));
    expect(detailed.outcomes.size).toBe(analysis.elements.length);
    const byKind = (kind: string) =>
      [...detailed.outcomes.values()].filter((outcome) => outcome.kind === kind).length;
    expect(byKind('adapted')).toBe(detailed.plan.summary.adapted);
    expect(byKind('unchanged')).toBe(detailed.plan.summary.unchanged);
    expect(byKind('unresolved')).toBe(detailed.plan.summary.unresolved);
    expect(byKind('skipped')).toBe(detailed.plan.summary.skipped);
  });
});
