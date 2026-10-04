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
