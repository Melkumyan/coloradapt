import type { ColorValue } from '@domain/models';
import { parseColor } from '@core/color';
import { readStyleProperty } from './style-property';
import { resolveEffectiveTextColor, type BackgroundResolutionCache } from './background-resolution';

/**
 * Resolves the effective foreground color for `element`'s text: the
 * computed text fill (`-webkit-text-fill-color`, else `color`; already
 * CSS-inheritance-resolved by `getComputedStyle`)
 * painted over the element's background and dimmed by this element's and
 * every ancestor's `opacity` as nested compositing groups. The result is
 * fully opaque (flattened onto the page canvas), so it must NOT be
 * flattened onto the effective background again.
 */
export function resolveEffectiveForeground(
  element: Element,
  getStyle: (el: Element) => CSSStyleDeclaration,
  cache: BackgroundResolutionCache,
): ColorValue | null {
  const style = getStyle(element);
  // `-webkit-text-fill-color` is what the glyphs are painted with when a page sets it; its initial value is
  // `currentcolor`, which the browser reports as the computed `color`, so reading it is always safe.
  const raw =
    parseColor(readStyleProperty(style, '-webkit-text-fill-color')) ??
    parseColor(style.color || '');
  if (!raw) return null;
  return resolveEffectiveTextColor(element, raw, getStyle, cache);
}
