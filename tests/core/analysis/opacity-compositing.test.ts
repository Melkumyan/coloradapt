import { describe, expect, it } from 'vitest';
import { analyzeDocument } from '@core/analysis';

type Layer = { color?: string; bg?: string; opacity?: string };

/**
 * Builds a nested chain (outermost first) ending in a text-bearing leaf and
 * analyzes it with fully mocked computed styles. Expected values in each
 * test are derived by hand from CSS group-opacity semantics:
 *   group = opacity * (content over own background), then over the white page.
 */
function analyzeChain(layers: Layer[]) {
  document.body.innerHTML = '';
  const styles = new Map<Element, Partial<CSSStyleDeclaration>>();
  let parent: HTMLElement = document.body;
  styles.set(document.body, {
    color: 'rgb(0,0,0)',
    backgroundColor: 'rgba(0,0,0,0)',
    opacity: '1',
  });
  let leaf = parent;
  layers.forEach((layer, i) => {
    const el = document.createElement(i === layers.length - 1 ? 'span' : 'div');
    if (i === layers.length - 1) el.textContent = 'text';
    parent.appendChild(el);
    styles.set(el, {
      color: layer.color ?? 'rgb(0,0,0)',
      backgroundColor: layer.bg ?? 'rgba(0,0,0,0)',
      backgroundImage: 'none',
      opacity: layer.opacity ?? '1',
      display: 'block',
      visibility: 'visible',
    });
    parent = el;
    leaf = el;
  });
  const getStyle = (el: Element) =>
    ({
      display: 'block',
      visibility: 'visible',
      backgroundImage: 'none',
      ...styles.get(el),
    }) as CSSStyleDeclaration;
  const { elements } = analyzeDocument({ root: document.body, getStyle });
  const descriptor = elements.find((e) => e.hasTextContent);
  expect(descriptor).toBeDefined();
  void leaf;
  return descriptor!;
}

const RED = 'rgb(255,0,0)';
const near = (actual: { r: number; g: number; b: number }, r: number, g: number, b: number) => {
  expect(actual.r).toBeCloseTo(r, 5);
  expect(actual.g).toBeCloseTo(g, 5);
  expect(actual.b).toBeCloseTo(b, 5);
};

describe('opacity group compositing', () => {
  it('A: opaque black parent at opacity .5 dims text and background together', () => {
    const d = analyzeChain([{ bg: 'rgb(0,0,0)', opacity: '0.5' }, { color: RED }]);
    near(d.colorPair.foreground, 1, 0.5, 0.5); // .5 red + .5 white (NOT red over gray)
    near(d.colorPair.background, 0.5, 0.5, 0.5);
    expect(d.analysisStatus).toBe('resolved');
  });

  it('B: translucent black parent bg + opacity .5', () => {
    const d = analyzeChain([{ bg: 'rgba(0,0,0,0.5)', opacity: '0.5' }, { color: RED }]);
    near(d.colorPair.foreground, 1, 0.5, 0.5); // opaque red text covers bg inside group
    near(d.colorPair.background, 0.75, 0.75, 0.75); // .25 black + .75 white
  });

  it('C: ancestor opacities multiply (.5 * .5) exactly once', () => {
    const d = analyzeChain([{ opacity: '0.5' }, { opacity: '0.5' }, { color: RED }]);
    near(d.colorPair.foreground, 1, 0.75, 0.75); // .25 red + .75 white
    near(d.colorPair.background, 1, 1, 1);
  });

  it('D: ancestor opacity multiplies with the color alpha', () => {
    const d = analyzeChain([{ opacity: '0.5' }, { color: 'rgba(255,0,0,0.5)' }]);
    near(d.colorPair.foreground, 1, 0.75, 0.75); // .25 red + .75 white
  });

  it('E: nested backgrounds under ancestor opacity', () => {
    const d = analyzeChain([
      { bg: 'rgb(0,0,255)', opacity: '0.5' },
      { bg: 'rgba(255,255,0,0.5)', opacity: '0.5' },
      { color: 'rgb(0,0,0)' },
    ]);
    // inside-out: text(black) -> *.5 -> over blue -> *.5 -> over white
    near(d.colorPair.foreground, 0.5, 0.5, 0.75);
    near(d.colorPair.background, 0.625, 0.625, 0.875);
  });

  it('own opacity applies once to own text and background', () => {
    const d = analyzeChain([{ color: RED, bg: 'rgb(0,0,0)', opacity: '0.5' }]);
    near(d.colorPair.foreground, 1, 0.5, 0.5);
    near(d.colorPair.background, 0.5, 0.5, 0.5);
  });

  it('opacity 1 everywhere is unchanged by group modelling', () => {
    const d = analyzeChain([{ bg: 'rgba(0,0,0,0.5)' }, { color: 'rgba(255,0,0,0.5)' }]);
    // text over bg: red .5 over (.5 black over white = .5 gray) = (.75,.25,.25)
    near(d.colorPair.foreground, 0.75, 0.25, 0.25);
    near(d.colorPair.background, 0.5, 0.5, 0.5);
  });

  it('marks results partial when body/html opacity makes canvas propagation ambiguous', () => {
    document.body.innerHTML = '<p>text</p>';
    const getStyle = (el: Element) =>
      ({
        color: 'rgb(0,0,0)',
        backgroundColor: 'rgba(0,0,0,0)',
        backgroundImage: 'none',
        display: 'block',
        visibility: 'visible',
        opacity: el === document.body ? '0.5' : '1',
      }) as CSSStyleDeclaration;
    const { elements } = analyzeDocument({ root: document.body, getStyle });
    const p = elements.find((e) => e.tagName === 'p');
    expect(p?.analysisStatus).toBe('partial');
  });
});
