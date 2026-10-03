import { afterEach, describe, expect, it } from 'vitest';
import { analyzeDocument, analyzeSubtrees, collectOwnedIds } from '@core/analysis';
import { createFakeEngine, mount } from '../svg/fake-engine';

/**
 * The SVG layer inside the generic analyzer: an inline <svg> is one candidate
 * (one descriptor), everything inside it belongs to that unit, and the whole
 * batch shares one style probe.
 */
function setup(markup: string, extra: { probe?: boolean } = {}) {
  mount(markup);
  const engine = createFakeEngine(document, { probe: extra.probe });
  const options = {
    getStyle: engine.getStyle,
    ...(engine.env.probe ? { probeStyles: engine.env.probe } : {}),
    now: () => 0,
  };
  return { engine, options };
}

afterEach(() => {
  document.body.innerHTML = '';
});

const PAGE = `
  <p id="text" style="color: #c0392b">Hello</p>
  <button id="btn" style="color: #c0392b">
    <svg id="icon" style="color: #c0392b" width="16" height="16">
      <path id="icon-p" class="tag status badge" fill="currentColor"/>
      <svg id="nested"><circle id="nested-c" fill="currentColor"/></svg>
    </svg>
    Go
  </button>
  <a id="link" href="#"><svg id="in-link"><rect id="in-link-r" fill="#000"/></svg></a>`;

describe('analyzeDocument with inline SVG', () => {
  it('an <svg> is one element of the analysis; nothing inside it is analyzed on its own', () => {
    const { options } = setup(PAGE);
    const { elements } = analyzeDocument({ root: document, ...options });
    const ids = elements.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const units = elements.filter((e) => e.svg);
    expect(units).toHaveLength(2);
    expect(units.map((e) => e.tagName)).toEqual(['svg', 'svg']);
    // Shapes (even ones whose class name looks like a badge/status) are not separate descriptors.
    for (const id of ['icon-p', 'nested', 'nested-c', 'in-link-r']) {
      const tag = document.getElementById(id)!.getAttribute('data-coloradapt-id');
      expect(elements.find((e) => e.id === tag && !e.svg)).toBeUndefined();
    }
    // HTML around them is analyzed as before.
    expect(elements.some((e) => e.tagName === 'p')).toBe(true);
    expect(elements.some((e) => e.tagName === 'button')).toBe(true);
    expect(elements.some((e) => e.tagName === 'a')).toBe(true);
  });

  it('the <svg> descriptor carries its role, paint and rule targets', () => {
    const { options } = setup(PAGE);
    const { elements } = analyzeDocument({ root: document, ...options });
    const icon = elements.find(
      (e) => e.id === document.getElementById('icon')!.getAttribute('data-coloradapt-id'),
    )!;
    expect(icon.role).toBe('icon');
    expect(icon.analysisStatus).toBe('resolved');
    expect(icon.svg?.targets).toEqual([{ elementId: icon.id, property: 'color' }]);
    // Two currentColor shapes (one in a nested <svg>): one paint.
    expect(icon.svg?.paintCount).toBe(1);
    expect(icon.svg?.shapeCount).toBe(2);
  });

  it('one probe for every SVG of the pass', () => {
    const { engine, options } = setup(PAGE);
    analyzeDocument({ root: document, ...options });
    expect(engine.probes).toBe(1);
  });

  it('without a probe SVGs are analyzed as partial and never adapted', () => {
    const { options } = setup(PAGE, { probe: false });
    const { elements } = analyzeDocument({ root: document, ...options });
    const units = elements.filter((e) => e.svg);
    expect(units.every((u) => u.analysisStatus === 'partial')).toBe(true);
    expect(units.every((u) => u.svg?.targets.length === 0)).toBe(true);
  });

  it('SVG units count against the element budget (and say so when it cuts)', () => {
    const many = Array.from({ length: 6 }, () => '<svg><path fill="#c0392b"/></svg>').join('');
    const { options } = setup(many);
    const result = analyzeDocument({ root: document, ...options, maxElements: 4 });
    expect(result.elements.length).toBeLessThanOrEqual(4);
    expect(result.truncated).toBe(true);
    const all = analyzeDocument({ root: document, ...options });
    expect(all.elements).toHaveLength(6);
    expect(all.truncated).toBe(false);
  });

  it('a standalone SVG document (icon.svg opened on its own) is not inline SVG', () => {
    const ns = 'http://www.w3.org/2000/svg';
    const svgDoc = document.implementation.createDocument(ns, 'svg', null);
    const path = svgDoc.createElementNS(ns, 'path');
    path.setAttribute('fill', '#c0392b');
    svgDoc.documentElement.appendChild(path);
    const engine = createFakeEngine(svgDoc);
    const { elements } = analyzeDocument({
      root: svgDoc,
      getStyle: engine.getStyle,
      probeStyles: engine.env.probe,
      now: () => 0,
    });
    expect(elements.filter((e) => e.svg)).toEqual([]);
  });

  it('a hidden <svg> is not an element of the analysis', () => {
    const { options } = setup('<svg style="display: none"><path fill="#c0392b"/></svg><p>x</p>');
    const { elements } = analyzeDocument({ root: document, ...options });
    expect(elements.filter((e) => e.svg)).toEqual([]);
  });
});

describe('analyzeSubtrees with inline SVG', () => {
  it('a region inside an <svg> re-analyzes the whole <svg>, once', () => {
    const { options } = setup(PAGE);
    const sub = analyzeSubtrees(
      [
        { element: document.getElementById('icon-p')!, scope: 'subtree' },
        { element: document.getElementById('nested-c')!, scope: 'self' },
      ],
      options,
    );
    expect(sub.elements).toHaveLength(1);
    expect(sub.elements[0]?.svg).toBeDefined();
    expect(sub.candidatesInspected).toBe(1);
    expect(sub.rootsCompleted).toBe(2);
    expect(sub.truncated).toBe(false);
  });

  it('returns the unit and its rule targets by id, so no document-wide lookup is needed', () => {
    const { options } = setup(
      '<svg id="s"><path id="a" fill="#c0392b"/><path id="b" fill="#c0392b"/></svg>',
    );
    const sub = analyzeSubtrees(
      [{ element: document.getElementById('s')!, scope: 'self' }],
      options,
    );
    expect(sub.nodes.size).toBe(3);
    expect(new Set(sub.nodes.values())).toEqual(
      new Set([
        document.getElementById('s'),
        document.getElementById('a'),
        document.getElementById('b'),
      ]),
    );
  });

  it('an <svg> inside a re-analyzed HTML subtree is picked up with it', () => {
    const { options } = setup(PAGE);
    const sub = analyzeSubtrees(
      [{ element: document.getElementById('btn')!, scope: 'subtree' }],
      options,
    );
    expect(sub.elements.map((e) => e.tagName).sort()).toEqual(['button', 'svg']);
  });

  it('a removed SVG leaves ids to forget: the unit and every tagged shape', () => {
    const { options } = setup(
      '<div id="host"><svg id="s"><path id="a" fill="#c0392b"/><path id="b" fill="#c0392b"/></svg></div>',
    );
    analyzeSubtrees([{ element: document.getElementById('host')!, scope: 'subtree' }], options);
    const svg = document.getElementById('s')!;
    const ids = collectOwnedIds(svg);
    expect(ids).toHaveLength(3);
    svg.remove();
    expect(collectOwnedIds(svg)).toHaveLength(3); // still readable once detached
  });

  it('analysis is repeatable: same ids, same descriptors', () => {
    const { options } = setup(PAGE);
    const first = analyzeDocument({ root: document, ...options });
    const second = analyzeDocument({ root: document, ...options });
    expect(second.elements).toEqual(first.elements);
  });
});
