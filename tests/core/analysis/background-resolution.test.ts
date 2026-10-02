import { describe, expect, it } from 'vitest';
import {
  createBackgroundResolutionCache,
  resolveCumulativeOpacity,
  resolveEffectiveBackground,
} from '@core/analysis';

const getStyle = (el: Element) => getComputedStyle(el);

function setBody(html: string): void {
  document.body.innerHTML = html;
  document.body.removeAttribute('style');
}

describe('resolveEffectiveBackground', () => {
  it('falls back to opaque white when nothing in the document paints a background', () => {
    setBody('<p id="target">hello</p>');
    const target = document.getElementById('target')!;

    const result = resolveEffectiveBackground(target, getStyle, createBackgroundResolutionCache());

    expect(result.kind).toBe('solid');
    expect(result.color).toMatchObject({ r: 1, g: 1, b: 1, alpha: 1 });
  });

  it('walks up through a transparent parent to an opaque ancestor', () => {
    setBody(`
      <div style="background: rgb(0,0,255);">
        <section style="background: transparent;">
          <p id="target">hello</p>
        </section>
      </div>
    `);
    const target = document.getElementById('target')!;

    const result = resolveEffectiveBackground(target, getStyle, createBackgroundResolutionCache());

    expect(result.kind).toBe('solid');
    expect(result.color).toMatchObject({ r: 0, g: 0, b: 1, alpha: 1 });
  });

  it('alpha-composites multiple semi-transparent ancestor backgrounds', () => {
    // white (page) <- rgba(0,0,0,0.5) <- rgba(0,0,0,0.5) => rgb(64,64,64) ish
    setBody(`
      <div style="background: rgba(0,0,0,0.5);">
        <div style="background: rgba(0,0,0,0.5);">
          <p id="target">hello</p>
        </div>
      </div>
    `);
    const target = document.getElementById('target')!;

    const result = resolveEffectiveBackground(target, getStyle, createBackgroundResolutionCache());

    expect(result.kind).toBe('solid');
    // over(0.5 black, over(0.5 black, white)) = over(0.5 black, 0.5 gray) = 0.25 gray
    expect(result.color.r).toBeCloseTo(0.25, 2);
    expect(result.color.g).toBeCloseTo(0.25, 2);
    expect(result.color.b).toBeCloseTo(0.25, 2);
    expect(result.color.alpha).toBe(1);
  });

  it('classifies a linear-gradient background as "gradient", not transparent', () => {
    setBody(`<div id="target" style="background-image: linear-gradient(red, blue);"></div>`);
    const target = document.getElementById('target')!;

    const result = resolveEffectiveBackground(target, getStyle, createBackgroundResolutionCache());

    expect(result.kind).toBe('gradient');
  });

  it('classifies a url() background-image as "image"', () => {
    setBody(`<div id="target" style="background-image: url(photo.png);"></div>`);
    const target = document.getElementById('target')!;

    const result = resolveEffectiveBackground(target, getStyle, createBackgroundResolutionCache());

    expect(result.kind).toBe('image');
  });

  it('classifies a gradient layered with a url() as "mixed"', () => {
    setBody(
      `<div id="target" style="background-image: linear-gradient(red, blue), url(photo.png);"></div>`,
    );
    const target = document.getElementById('target')!;

    const result = resolveEffectiveBackground(target, getStyle, createBackgroundResolutionCache());

    expect(result.kind).toBe('mixed');
  });

  it('classifies a gradient ancestor and an image descendant together as "mixed"', () => {
    setBody(`
      <div style="background-image: linear-gradient(red, blue);">
        <p id="target" style="background-image: url(photo.png);">hello</p>
      </div>
    `);
    const target = document.getElementById('target')!;

    const result = resolveEffectiveBackground(target, getStyle, createBackgroundResolutionCache());

    expect(result.kind).toBe('mixed');
  });

  it('ignores an ancestor gradient fully occluded by a later opaque solid background', () => {
    setBody(`
      <div style="background-image: linear-gradient(red, blue);">
        <div style="background: rgb(255,255,255);">
          <p id="target">hello</p>
        </div>
      </div>
    `);
    const target = document.getElementById('target')!;

    const result = resolveEffectiveBackground(target, getStyle, createBackgroundResolutionCache());

    expect(result.kind).toBe('solid');
    expect(result.color).toMatchObject({ r: 1, g: 1, b: 1, alpha: 1 });
  });

  it('reuses cached ancestor state across siblings (memoization)', () => {
    setBody(`
      <div id="ancestor" style="background: rgb(10,20,30);">
        <p id="a">one</p>
        <p id="b">two</p>
      </div>
    `);
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    const cache = createBackgroundResolutionCache();

    const resultA = resolveEffectiveBackground(a, getStyle, cache);
    const resultB = resolveEffectiveBackground(b, getStyle, cache);

    expect(resultA.color).toEqual(resultB.color);
    expect(cache.has(document.getElementById('ancestor')!)).toBe(true);
  });
});

describe('resolveCumulativeOpacity', () => {
  it('multiplies opacity down through ancestors', () => {
    setBody(`
      <div style="opacity: 0.5;">
        <div style="opacity: 0.5;">
          <p id="target">hello</p>
        </div>
      </div>
    `);
    const target = document.getElementById('target')!;

    const opacity = resolveCumulativeOpacity(target, getStyle, createBackgroundResolutionCache());

    expect(opacity).toBeCloseTo(0.25, 5);
  });

  it('is 1 when no element in the chain sets opacity', () => {
    setBody(`<p id="target">hello</p>`);
    const target = document.getElementById('target')!;

    expect(resolveCumulativeOpacity(target, getStyle, createBackgroundResolutionCache())).toBe(1);
  });
});
