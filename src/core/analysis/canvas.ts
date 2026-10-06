import type { ColorValue } from '@domain/models';
import { readStyleProperty } from './style-property';

/**
 * The color the page canvas shows where nothing paints a background. M0 assumed opaque white; a page that
 * declares `color-scheme: dark` (or `light dark` for a visitor who prefers dark) gets the browser's *dark*
 * canvas instead, and every text without a background of its own sits on it. Measured with pixels in both
 * browsers (M10.R1, `realworld/ground-truth.spec.ts`): Chromium paints rgb(18, 18, 18), Firefox rgb(28, 27, 34).
 * Reading it as white made the audit say a gray was 4.8:1 where it is 3.9:1 on the canvas the visitor sees
 * (219 findings on one documentation site alone).
 */
const WHITE: ColorValue = { r: 1, g: 1, b: 1, alpha: 1 };
const DARK_CHROMIUM: ColorValue = { r: 18 / 255, g: 18 / 255, b: 18 / 255, alpha: 1 };
const DARK_FIREFOX: ColorValue = { r: 28 / 255, g: 27 / 255, b: 34 / 255, alpha: 1 };

/**
 * The scheme the browser uses, from the computed `color-scheme` of the root: a list containing `dark` is dark
 * when the visitor prefers dark, or when `dark` is the only scheme; a list without `dark` is light.
 */
export function usesDarkScheme(colorScheme: string, prefersDark: boolean): boolean {
  const tokens = colorScheme
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t !== '' && t !== 'only' && t !== 'normal');
  const dark = tokens.includes('dark');
  const light = tokens.includes('light');
  if (!dark) return false;
  if (!light) return true;
  return prefersDark;
}

/**
 * One `MediaQueryList` per window, read live (`matches` is always current): asking `matchMedia` on every
 * analysis pass created a new object each time, which the M10 SPA memory check (500 route changes) measured
 * as heap growth.
 */
const darkQueries = new WeakMap<Window, MediaQueryList>();

function prefersDarkOf(view: Window): boolean {
  try {
    let query = darkQueries.get(view);
    if (!query) {
      query = view.matchMedia?.('(prefers-color-scheme: dark)');
      if (query) darkQueries.set(view, query);
    }
    return query?.matches === true;
  } catch {
    return false;
  }
}

/** The canvas color of a document, from its root element's computed style. */
export function canvasColorOf(root: Element, style: CSSStyleDeclaration): ColorValue {
  const view = root.ownerDocument.defaultView;
  const prefersDark = view ? prefersDarkOf(view) : false;
  if (!usesDarkScheme(readStyleProperty(style, 'color-scheme'), prefersDark)) return WHITE;
  return /Firefox\//.test(view?.navigator?.userAgent ?? '') ? DARK_FIREFOX : DARK_CHROMIUM;
}
