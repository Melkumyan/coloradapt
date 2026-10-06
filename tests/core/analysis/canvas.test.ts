import { afterEach, describe, expect, it } from 'vitest';
import { analyzeDocument, canvasColorOf, usesDarkScheme } from '@core/analysis';

/**
 * M10.R1: the canvas behind a page is not always white. Measured with pixels in both browsers
 * (realworld/ground-truth.spec.ts): Chromium 18/18/18, Firefox 28/27/34 for `color-scheme: dark`.
 */
const ORIGINAL_USER_AGENT = window.navigator.userAgent;

/** jsdom has no `matchMedia`: install one that answers the dark-preference query only (one live object, like a browser's). */
const preference = { dark: false };
const darkQuery = {
  get matches() {
    return preference.dark;
  },
} as MediaQueryList;
function stubPrefersDark(dark: boolean): void {
  preference.dark = dark;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => darkQuery,
  });
}

function stubUserAgent(value: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value });
}

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('style');
  Reflect.deleteProperty(window, 'matchMedia');
  stubUserAgent(ORIGINAL_USER_AGENT);
});

describe('usesDarkScheme', () => {
  it.each([
    ['normal', false, false],
    ['light', true, false],
    ['only light', true, false],
    ['dark', false, true],
    ['only dark', false, true],
    ['light dark', false, false],
    ['light dark', true, true],
    ['dark light', false, false],
    ['dark light', true, true],
    ['', true, false],
  ])('color-scheme %j, prefers dark %s -> dark %s', (scheme, prefersDark, expected) => {
    expect(usesDarkScheme(scheme, prefersDark)).toBe(expected);
  });
});

/** A style that answers `color-scheme` the way a browser's computed style would. */
const styleWithScheme = (scheme: string) =>
  ({
    getPropertyValue: (name: string) => (name === 'color-scheme' ? scheme : ''),
  }) as unknown as CSSStyleDeclaration;

describe('canvasColorOf', () => {
  it('is white without a dark scheme', () => {
    expect(canvasColorOf(document.documentElement, styleWithScheme('normal'))).toEqual({
      r: 1,
      g: 1,
      b: 1,
      alpha: 1,
    });
  });

  it('is the browser dark canvas for color-scheme: dark (Chromium 18, Firefox 28/27/34)', () => {
    stubPrefersDark(false);
    const chromium = canvasColorOf(document.documentElement, styleWithScheme('dark'));
    expect(Math.round(chromium.r * 255)).toBe(18);
    stubUserAgent('Mozilla/5.0 Gecko/20100101 Firefox/151.0');
    const firefox = canvasColorOf(document.documentElement, styleWithScheme('dark'));
    expect([firefox.r, firefox.g, firefox.b].map((c) => Math.round(c * 255))).toEqual([28, 27, 34]);
  });

  it('light dark follows the visitor preference', () => {
    stubPrefersDark(false);
    expect(canvasColorOf(document.documentElement, styleWithScheme('light dark')).r).toBe(1);
    stubPrefersDark(true);
    expect(
      Math.round(canvasColorOf(document.documentElement, styleWithScheme('light dark')).r * 255),
    ).toBe(18);
  });
});

describe('text on a transparent page on a dark canvas', () => {
  const analyze = (scheme: string, prefersDark = false) => {
    stubPrefersDark(prefersDark);
    document.body.innerHTML = '<p style="color:#6a7282">text</p>';
    const real = window.getComputedStyle.bind(window);
    const { elements } = analyzeDocument({
      now: () => 0,
      getStyle: (el) => {
        const style = real(el);
        if (el !== document.documentElement) return style;
        // jsdom has no color-scheme: answer it for the root only
        return new Proxy(style, {
          get: (target, prop) =>
            prop === 'getPropertyValue'
              ? (name: string) => (name === 'color-scheme' ? scheme : target.getPropertyValue(name))
              : (Reflect.get(target, prop) as unknown),
        });
      },
    });
    return elements[0]!;
  };

  it('is measured against the dark canvas, not white', () => {
    const dark = analyze('dark');
    expect(Math.round(dark.colorPair.background.r * 255)).toBe(18);
    const light = analyze('normal');
    expect(Math.round(light.colorPair.background.r * 255)).toBe(255);
  });

  it('an opaque html background still wins over the scheme', () => {
    document.documentElement.style.backgroundColor = '#f0f0f0';
    const d = analyze('dark');
    expect(Math.round(d.colorPair.background.r * 255)).toBe(240);
  });
});
