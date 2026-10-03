import { afterEach, describe, expect, it } from 'vitest';
import {
  OBSERVED_ATTRIBUTES,
  classifyMutations,
  isStyleChangeRelevant,
  resolveAffectedRoots,
  normalizeRoots,
  type ClassifiedMutation,
} from '@features/dynamic-analysis';
import { html } from './helpers';

/** Records exactly as production receives them (same subscription options). */
function record(mutate: () => void): MutationRecord[] {
  const observer = new MutationObserver(() => undefined);
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [...OBSERVED_ATTRIBUTES],
    attributeOldValue: true,
    characterData: true,
    characterDataOldValue: true,
  });
  mutate();
  const records = observer.takeRecords();
  observer.disconnect();
  return records;
}

const classify = (mutate: () => void) =>
  classifyMutations(record(mutate), { doc: document }).mutations;
const kinds = (mutations: readonly ClassifiedMutation[]) => mutations.map((m) => m.kind);
const byId = (id: string) => document.getElementById(id)!;
const options = { doc: document, maxRoots: 512 };

const SVG = `
  <div id="host">
    <svg id="icon" width="24" height="24">
      <g id="g"><path id="p" fill="#c0392b" d="M0 0h10v10z"/></g>
      <text id="t">Label</text>
      <use id="u" href="#nowhere"/>
    </svg>
  </div>`;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('SVG attributes are style-affecting only on SVG elements', () => {
  it.each([
    ['fill', '#2980b9'],
    ['stroke', '#2980b9'],
    ['fill-opacity', '0.5'],
    ['stroke-opacity', '0.5'],
    ['stroke-width', '3'],
    ['opacity', '0.5'],
    ['color', '#2980b9'],
    ['display', 'none'],
    ['visibility', 'hidden'],
    ['filter', 'url(#f)'],
    ['mask', 'url(#m)'],
    ['mix-blend-mode', 'multiply'],
  ])('%s on a shape', (name, value) => {
    html(SVG);
    const mutations = classify(() => byId('p').setAttribute(name, value));
    expect(kinds(mutations)).toEqual(['STYLE_AFFECTING_ATTRIBUTE']);
    expect(mutations[0]).toMatchObject({ element: byId('p'), attribute: name });
  });

  it('href on a <use> (a new target is a new paint)', () => {
    html(SVG);
    const mutations = classify(() => byId('u').setAttribute('href', '#other'));
    expect(kinds(mutations)).toEqual(['STYLE_AFFECTING_ATTRIBUTE']);
  });

  it('class and inline style on a shape, as for any element', () => {
    html(SVG);
    expect(kinds(classify(() => byId('p').setAttribute('class', 'x')))).toEqual([
      'STYLE_AFFECTING_ATTRIBUTE',
    ]);
    expect(kinds(classify(() => byId('p').setAttribute('style', 'fill: #2980b9')))).toEqual([
      'STYLE_AFFECTING_ATTRIBUTE',
    ]);
  });

  it('an inline style that only moves the shape is irrelevant', () => {
    html(SVG);
    byId('p').setAttribute('style', 'fill: #c0392b');
    expect(
      kinds(classify(() => byId('p').setAttribute('style', 'fill: #c0392b; transform: scale(2)'))),
    ).toEqual(['IRRELEVANT']);
  });

  it('the same attribute names on HTML elements are not delivered work', () => {
    html('<p id="html">x</p>');
    for (const name of ['fill', 'stroke', 'opacity', 'color', 'display', 'href']) {
      expect(kinds(classify(() => byId('html').setAttribute(name, 'x')))).toEqual(['IRRELEVANT']);
    }
  });

  it('setting an attribute to the value it has is no change', () => {
    html(SVG);
    expect(kinds(classify(() => byId('p').setAttribute('fill', '#c0392b')))).toEqual([
      'IRRELEVANT',
    ]);
  });

  it('inline style relevance knows the SVG paint properties', () => {
    expect(isStyleChangeRelevant('fill: red', 'fill: blue')).toBe(true);
    expect(isStyleChangeRelevant('stroke: red', 'stroke: blue')).toBe(true);
    expect(isStyleChangeRelevant(null, 'fill-opacity: .5')).toBe(true);
    expect(isStyleChangeRelevant(null, 'stroke-opacity: .5')).toBe(true);
    expect(isStyleChangeRelevant(null, 'stroke-width: 2px')).toBe(true);
    expect(isStyleChangeRelevant(null, 'mask-image: url(#m)')).toBe(true);
    expect(isStyleChangeRelevant(null, 'marker-start: url(#m)')).toBe(true);
    expect(isStyleChangeRelevant(null, 'transform: rotate(1deg)')).toBe(false);
    expect(isStyleChangeRelevant(null, 'stroke-dasharray: 2')).toBe(false);
  });
});

describe('SVG node and text mutations', () => {
  it('a child removed from an SVG reports where it was removed from', () => {
    html(SVG);
    const path = byId('p');
    const mutations = classify(() => path.remove());
    expect(mutations).toEqual([{ kind: 'NODE_REMOVED', element: path, parent: byId('g') }]);
  });

  it('an element added to an SVG is NODE_ADDED', () => {
    html(SVG);
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    expect(kinds(classify(() => byId('g').appendChild(rect)))).toEqual(['NODE_ADDED']);
  });

  it('SVG text changing between empty and non-empty is a TEXT_CHANGE; rewording is not', () => {
    html(SVG);
    expect(
      kinds(classify(() => (byId('t').firstChild as Text).replaceData(0, 5, 'Other'))),
    ).toEqual(['IRRELEVANT']);
    expect(kinds(classify(() => (byId('t').firstChild as Text).replaceData(0, 5, '')))).toEqual([
      'TEXT_CHANGE',
    ]);
    expect(
      classify(() => {
        byId('t').textContent = 'Back';
      }).map((m) => m.kind),
    ).toContain('TEXT_CHANGE');
  });
});

describe('SVG regions: anything inside an inline SVG is the SVG', () => {
  const roots = (mutations: ClassifiedMutation[]) =>
    resolveAffectedRoots(mutations, options).roots.map(
      (root) => `${root.element.id}:${root.scope}`,
    );

  it('an attribute change deep inside is a self region of the <svg>', () => {
    html(SVG);
    expect(
      roots([{ kind: 'STYLE_AFFECTING_ATTRIBUTE', element: byId('p'), attribute: 'fill' }]),
    ).toEqual(['icon:self']);
  });

  it('a node added inside re-analyzes the <svg>, not the inserted node', () => {
    html(SVG);
    expect(roots([{ kind: 'NODE_ADDED', element: byId('p') }])).toEqual(['icon:self']);
  });

  it('a whole <svg> added is a subtree region of itself', () => {
    html(SVG);
    expect(roots([{ kind: 'NODE_ADDED', element: byId('icon') }])).toEqual(['icon:subtree']);
  });

  it('an attribute change on the <svg> itself keeps its scope (it may hold HTML in foreignObject)', () => {
    html(SVG);
    expect(
      roots([{ kind: 'STYLE_AFFECTING_ATTRIBUTE', element: byId('icon'), attribute: 'class' }]),
    ).toEqual(['icon:subtree']);
  });

  it('text change inside <text> is a self region of the <svg>', () => {
    html(SVG);
    expect(roots([{ kind: 'TEXT_CHANGE', element: byId('t') }])).toEqual(['icon:self']);
  });

  it('a child removed from an SVG re-analyzes the SVG and still reports the removal', () => {
    html(SVG);
    const path = byId('p');
    const parent = byId('g');
    path.remove();
    const resolved = resolveAffectedRoots(
      [{ kind: 'NODE_REMOVED', element: path, parent }],
      options,
    );
    expect(resolved.roots.map((root) => `${root.element.id}:${root.scope}`)).toEqual(['icon:self']);
    expect(resolved.removed).toEqual([path]);
  });

  it('a whole <svg> removed from HTML is only a removal', () => {
    html(SVG);
    const icon = byId('icon');
    const parent = byId('host');
    icon.remove();
    const resolved = resolveAffectedRoots(
      [{ kind: 'NODE_REMOVED', element: icon, parent }],
      options,
    );
    expect(resolved.roots).toEqual([]);
    expect(resolved.removed).toEqual([icon]);
  });

  it('several changes in one SVG are one region', () => {
    html(SVG);
    expect(
      roots([
        { kind: 'STYLE_AFFECTING_ATTRIBUTE', element: byId('p'), attribute: 'fill' },
        { kind: 'STYLE_AFFECTING_ATTRIBUTE', element: byId('g'), attribute: 'class' },
        { kind: 'TEXT_CHANGE', element: byId('t') },
      ]),
    ).toEqual(['icon:self']);
  });

  it('an SVG region inside a changed HTML subtree is covered by that subtree', () => {
    html(SVG);
    const merged = normalizeRoots(
      resolveAffectedRoots(
        [
          { kind: 'STYLE_AFFECTING_ATTRIBUTE', element: byId('host'), attribute: 'class' },
          { kind: 'STYLE_AFFECTING_ATTRIBUTE', element: byId('p'), attribute: 'fill' },
        ],
        options,
      ).roots,
    );
    expect(merged.map((root) => `${root.element.id}:${root.scope}`)).toEqual(['host:subtree']);
  });
});

describe('SVGs that instantiate content defined elsewhere', () => {
  const SPRITE = `
    <svg id="sprite" style="display: none"><symbol id="s"><path id="sp" fill="currentColor"/></symbol></svg>
    <svg id="a"><use id="ua" href="#s"/></svg>
    <svg id="b"><use id="ub" href="#s"/></svg>
    <svg id="c"><use id="uc" href="#elsewhere"/></svg>
    <svg id="plain"><path id="pp"/></svg>`;

  const roots = (mutations: ClassifiedMutation[]) =>
    resolveAffectedRoots(mutations, options).roots.map(
      (root) => `${root.element.id}:${root.scope}`,
    );

  it('a change inside the sprite re-analyzes every instance of what it defines', () => {
    html(SPRITE);
    expect(
      roots([{ kind: 'STYLE_AFFECTING_ATTRIBUTE', element: byId('sp'), attribute: 'class' }]),
    ).toEqual(['sprite:self', 'a:self', 'b:self']);
  });

  it('a sprite added late re-analyzes the instances waiting for it', () => {
    html(SPRITE);
    expect(roots([{ kind: 'NODE_ADDED', element: byId('sprite') }])).toEqual([
      'sprite:subtree',
      'a:self',
      'b:self',
    ]);
  });

  it('an SVG that defines no ids costs no document-wide lookup and has no dependents', () => {
    html(SPRITE);
    expect(
      roots([{ kind: 'STYLE_AFFECTING_ATTRIBUTE', element: byId('pp'), attribute: 'fill' }]),
    ).toEqual(['plain:self']);
  });

  it('changing a <use> re-analyzes its own SVG only', () => {
    html(SPRITE);
    expect(
      roots([{ kind: 'STYLE_AFFECTING_ATTRIBUTE', element: byId('ua'), attribute: 'href' }]),
    ).toEqual(['a:self']);
  });
});
