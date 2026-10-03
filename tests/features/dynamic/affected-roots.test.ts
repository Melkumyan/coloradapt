import { afterEach, describe, expect, it } from 'vitest';
import { analyzeDocument } from '@core/analysis';
import {
  collectRemovedIds,
  normalizeRoots,
  resolveAffectedRoots,
  type ClassifiedMutation,
} from '@features/dynamic-analysis';
import { CONFLICT_STYLE, html } from './helpers';

const options = { doc: document, maxRoots: 512 };
const byId = (id: string) => document.getElementById(id)!;

const added = (element: Element): ClassifiedMutation => ({ kind: 'NODE_ADDED', element });
const attribute = (element: Element): ClassifiedMutation => ({
  kind: 'STYLE_AFFECTING_ATTRIBUTE',
  element,
  attribute: 'class',
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('normalizeRoots', () => {
  it('keeps only the outermost of parent / child / grandchild', () => {
    html('<div id="p"><div id="c"><span id="g"></span></div></div>');
    const roots = normalizeRoots([
      { element: byId('g'), scope: 'subtree' },
      { element: byId('c'), scope: 'subtree' },
      { element: byId('p'), scope: 'subtree' },
    ]);
    expect(roots.map((root) => root.element.id)).toEqual(['p']);
  });

  it('keeps unrelated roots in first-seen order', () => {
    html('<div id="a"></div><div id="b"></div><div id="c"></div>');
    const roots = normalizeRoots(
      ['b', 'a', 'c'].map((id) => ({ element: byId(id), scope: 'subtree' as const })),
    );
    expect(roots.map((root) => root.element.id)).toEqual(['b', 'a', 'c']);
  });

  it('merges duplicates, and a subtree root beats a self root on the same element', () => {
    html('<div id="a"></div>');
    const roots = normalizeRoots([
      { element: byId('a'), scope: 'self' },
      { element: byId('a'), scope: 'subtree' },
      { element: byId('a'), scope: 'self' },
    ]);
    expect(roots).toEqual([{ element: byId('a'), scope: 'subtree' }]);
  });

  it('a self root inside a subtree root is dropped, a self root of the ancestor is not', () => {
    html('<div id="p"><p id="c">t</p></div>');
    expect(
      normalizeRoots([
        { element: byId('p'), scope: 'subtree' },
        { element: byId('c'), scope: 'self' },
      ]).map((root) => root.element.id),
    ).toEqual(['p']);
    expect(
      normalizeRoots([
        { element: byId('p'), scope: 'self' },
        { element: byId('c'), scope: 'subtree' },
      ]).map((root) => `${root.element.id}:${root.scope}`),
    ).toEqual(['p:self', 'c:subtree']);
  });

  it('is linear-ish: 2000 siblings are handled without quadratic blowup', () => {
    html('<div id="host"></div>');
    const nodes = Array.from({ length: 2000 }, () => document.createElement('p'));
    byId('host').append(...nodes);
    const roots = normalizeRoots(nodes.map((element) => ({ element, scope: 'subtree' as const })));
    expect(roots).toHaveLength(2000);
  });
});

describe('resolveAffectedRoots', () => {
  it('turns an added node into a subtree root', () => {
    html('<div id="host"><p id="n">x</p></div>');
    const batch = resolveAffectedRoots([added(byId('n'))], options);
    expect(batch.roots).toEqual([{ element: byId('n'), scope: 'subtree' }]);
    expect(batch.fullRescan).toBeNull();
  });

  it('collapses nested added nodes into the outermost one', () => {
    html('<div id="p"><div id="c"><p id="g">x</p></div></div>');
    const batch = resolveAffectedRoots(
      [added(byId('g')), added(byId('c')), added(byId('p'))],
      options,
    );
    expect(batch.roots.map((root) => root.element.id)).toEqual(['p']);
  });

  it('a style-affecting attribute invalidates the target subtree (descendants may change)', () => {
    html('<div id="p"><span id="c">x</span></div>');
    const batch = resolveAffectedRoots([attribute(byId('p'))], options);
    expect(batch.roots).toEqual([{ element: byId('p'), scope: 'subtree' }]);
  });

  it('a text change only re-analyzes that element', () => {
    html('<div id="p"><span id="c">x</span></div>');
    const batch = resolveAffectedRoots([{ kind: 'TEXT_CHANGE', element: byId('p') }], options);
    expect(batch.roots).toEqual([{ element: byId('p'), scope: 'self' }]);
  });

  it('skips nodes that are detached or live outside <body>', () => {
    html('<div id="p"></div>');
    const detached = document.createElement('div');
    const head = document.createElement('div');
    document.head.appendChild(head);
    const batch = resolveAffectedRoots([added(detached), added(head)], options);
    expect(batch.roots).toHaveLength(0);
    head.remove();
  });

  it.each(['stylesheet', 'document-root'] as const)(
    'escalates %s changes to a full rescan',
    (reason) => {
      html('<div id="p"></div>');
      const mutations: ClassifiedMutation[] =
        reason === 'stylesheet'
          ? [{ kind: 'STYLESHEET_CHANGE' }]
          : [attribute(document.documentElement)];
      const batch = resolveAffectedRoots([added(byId('p')), ...mutations], options);
      expect(batch.fullRescan).toBe(reason);
      expect(batch.roots).toHaveLength(0);
    },
  );

  it('a change to <body> is a document-root full rescan', () => {
    const batch = resolveAffectedRoots([attribute(document.body)], options);
    expect(batch.fullRescan).toBe('document-root');
  });

  it('too many distinct roots become one full rescan', () => {
    html('<div id="host"></div>');
    const nodes = Array.from({ length: 11 }, () => document.createElement('p'));
    byId('host').append(...nodes);
    const mutations = nodes.map(added);
    expect(resolveAffectedRoots(mutations, { doc: document, maxRoots: 11 }).fullRescan).toBeNull();
    expect(resolveAffectedRoots(mutations, { doc: document, maxRoots: 10 }).fullRescan).toBe(
      'too-many-roots',
    );
  });

  it('many nodes under one already-affected ancestor do not count against the budget', () => {
    html('<div id="host"></div>');
    const nodes = Array.from({ length: 50 }, () => document.createElement('p'));
    byId('host').append(...nodes);
    const batch = resolveAffectedRoots([attribute(byId('host')), ...nodes.map(added)], {
      doc: document,
      maxRoots: 3,
    });
    expect(batch.fullRescan).toBeNull();
    expect(batch.roots).toHaveLength(1);
  });

  it('removed nodes are returned only if they really left the document', () => {
    html('<div id="a"><p id="gone">x</p></div><div id="b"></div>');
    const gone = byId('gone');
    const moved = document.createElement('p');
    byId('b').appendChild(moved);
    gone.remove();
    const batch = resolveAffectedRoots(
      [
        { kind: 'NODE_REMOVED', element: gone },
        { kind: 'NODE_REMOVED', element: moved },
      ],
      options,
    );
    expect(batch.removed).toEqual([gone]);
  });
});

describe('collectRemovedIds', () => {
  it('collects the owned ids of a detached subtree, but not foreign or cloned ones', () => {
    html(
      `<div id="box"><p style="${CONFLICT_STYLE}">a</p><p style="${CONFLICT_STYLE}">b</p></div>`,
    );
    analyzeDocument({ root: document, now: () => 0 });
    const box = byId('box');
    const ownIds = [...box.querySelectorAll('[data-coloradapt-id]')].map((e) =>
      e.getAttribute('data-coloradapt-id'),
    );
    const foreign = document.createElement('p');
    foreign.setAttribute('data-coloradapt-id', 'ca-not-mine');
    box.appendChild(foreign);
    box.remove();

    expect(collectRemovedIds([box]).sort()).toEqual([...ownIds].sort());
  });
});

describe('resolveAffectedRoots: semantic changes (M6)', () => {
  it('a semantic change re-examines only that element, not its subtree', () => {
    html('<div id="tab" role="tab"><span id="inner">x</span></div>');
    const resolved = resolveAffectedRoots(
      [{ kind: 'SEMANTIC_CHANGE', element: byId('tab'), attribute: 'aria-selected' }],
      options,
    );
    expect(resolved.fullRescan).toBeNull();
    expect(resolved.roots).toEqual([{ element: byId('tab'), scope: 'self' }]);
  });

  it('many semantic changes under one subtree root are swallowed by it', () => {
    html('<ul id="list"><li id="a" role="tab"></li><li id="b" role="tab"></li></ul>');
    const resolved = resolveAffectedRoots(
      [
        { kind: 'SEMANTIC_CHANGE', element: byId('a'), attribute: 'aria-selected' },
        { kind: 'SEMANTIC_CHANGE', element: byId('b'), attribute: 'aria-selected' },
        added(byId('list')),
      ],
      options,
    );
    expect(resolved.roots.map((root) => root.element.id)).toEqual(['list']);
  });

  it('a semantic change on a detached element is ignored', () => {
    html('<div id="a"></div>');
    const gone = document.createElement('div');
    const resolved = resolveAffectedRoots(
      [{ kind: 'SEMANTIC_CHANGE', element: gone, attribute: 'aria-invalid' }],
      options,
    );
    expect(resolved.roots).toEqual([]);
  });
});
