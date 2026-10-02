import { describe, expect, it } from 'vitest';
import { analyzeDocument, ELEMENT_ID_ATTRIBUTE } from '@core/analysis';

function setUpDom(): HTMLElement {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  container.innerHTML = `
    <p style="color: rgb(136,136,136); background-color: rgb(255,255,255);">Low contrast text</p>
    <a href="#" style="color: rgb(0,0,0); background-color: rgb(255,255,255);">A link</a>
  `;
  document.body.appendChild(container);
  return container;
}

describe('analyzeDocument', () => {
  it('extracts visible, color-bearing elements and tags them with a stable id', () => {
    const root = setUpDom();
    const { elements, truncated } = analyzeDocument({ root, now: () => 0 });

    expect(truncated).toBe(false);
    expect(elements.length).toBeGreaterThanOrEqual(2);

    const paragraph = root.querySelector('p');
    const id = paragraph?.getAttribute(ELEMENT_ID_ATTRIBUTE);
    expect(id).toBeTruthy();
    expect(elements.some((el) => el.id === id && el.role === 'text')).toBe(true);

    const link = root.querySelector('a');
    const linkDescriptor = elements.find(
      (el) => el.id === link?.getAttribute(ELEMENT_ID_ATTRIBUTE),
    );
    expect(linkDescriptor?.role).toBe('link');
  });

  it('reuses the same id across repeated analysis passes on the same element', () => {
    const root = setUpDom();
    const first = analyzeDocument({ root });
    const second = analyzeDocument({ root });

    const firstIds = first.elements.map((el) => el.id).sort();
    const secondIds = second.elements.map((el) => el.id).sort();
    expect(secondIds).toEqual(firstIds);
  });

  it('respects the maxElements budget', () => {
    const root = setUpDom();
    const { elements, truncated } = analyzeDocument({ root, maxElements: 1 });
    expect(elements).toHaveLength(1);
    expect(truncated).toBe(true);
  });

  it('does not double-count text nested in both a wrapper and an inner element', () => {
    document.body.innerHTML = '';
    const container = document.createElement('div');
    container.innerHTML = '<p id="wrapper"><span id="inner">Hello</span></p>';
    document.body.appendChild(container);

    const { elements } = analyzeDocument({ root: container, now: () => 0 });

    const wrapper = container.querySelector('#wrapper');
    const inner = container.querySelector('#inner');
    const wrapperId = wrapper?.getAttribute(ELEMENT_ID_ATTRIBUTE);
    const innerId = inner?.getAttribute(ELEMENT_ID_ATTRIBUTE);

    expect(elements.some((el) => el.id === innerId)).toBe(true);
    // The wrapper's text is identical to the inner span's — it should never
    // have been assigned an id (and thus never analyzed) at all.
    expect(wrapperId).toBeNull();
    expect(elements.some((el) => el.id === wrapperId)).toBe(false);
  });

  it('marks a gradient background as unsupported rather than guessing a contrast result', () => {
    document.body.innerHTML = '';
    const container = document.createElement('div');
    container.innerHTML =
      '<p id="target" style="color: black; background-image: linear-gradient(red, blue);">Hello</p>';
    document.body.appendChild(container);

    const { elements } = analyzeDocument({ root: container, now: () => 0 });

    const target = elements.find((el) => el.tagName === 'p');
    expect(target?.backgroundKind).toBe('gradient');
    expect(target?.analysisStatus).toBe('unsupported');
  });

  it('marks a plain solid-background element as resolved', () => {
    document.body.innerHTML = '';
    const container = document.createElement('div');
    container.innerHTML = '<p id="target" style="color: black; background: white;">Hello</p>';
    document.body.appendChild(container);

    const { elements } = analyzeDocument({ root: container, now: () => 0 });

    const target = elements.find((el) => el.tagName === 'p');
    expect(target?.backgroundKind).toBe('solid');
    expect(target?.analysisStatus).toBe('resolved');
  });

  it('flags a disabled button', () => {
    document.body.innerHTML = '';
    const container = document.createElement('div');
    container.innerHTML = '<button disabled>Submit</button>';
    document.body.appendChild(container);

    const { elements } = analyzeDocument({ root: container, now: () => 0 });

    const button = elements.find((el) => el.role === 'button');
    expect(button?.disabled).toBe(true);
  });

  it('skips elements hidden via display: none', () => {
    document.body.innerHTML = '';
    const container = document.createElement('div');
    container.innerHTML = '<p style="display: none;">Invisible</p><p>Visible</p>';
    document.body.appendChild(container);

    const { elements } = analyzeDocument({ root: container, now: () => 0 });

    expect(elements).toHaveLength(1);
  });

  it('captures per-side border colors on an element', () => {
    document.body.innerHTML = '';
    const container = document.createElement('div');
    container.innerHTML = '<button style="border: 2px solid rgb(5,6,7);">Go</button>';
    document.body.appendChild(container);

    const { elements } = analyzeDocument({ root: container, now: () => 0 });

    const button = elements.find((el) => el.role === 'button');
    expect(button?.borders?.top).toMatchObject({ r: 5 / 255, g: 6 / 255, b: 7 / 255 });
  });
});
