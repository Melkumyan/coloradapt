/**
 * A deliberately cheap visibility check based on computed style alone.
 * Does not attempt layout-based checks (e.g. `getClientRects`,
 * `getBoundingClientRect`) — those are more accurate (they'd also catch a
 * `display: none` ancestor we didn't otherwise walk to, or a detached
 * node) but are meaningless in jsdom, which has no layout engine and
 * always reports zero client rects, and are far more expensive to call
 * for every candidate element in a real browser. See docs/CSS_ANALYSIS.md.
 *
 * Deliberately does NOT look at viewport position: an element scrolled
 * out of view, or below the fold, still has a layout box and may become
 * visible later — it is not the same as `display: none`/`visibility:
 * hidden`, and we don't want to silently skip it.
 */
export function isElementVisible(_element: Element, style: CSSStyleDeclaration): boolean {
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (Number.parseFloat(style.opacity || '1') === 0) return false;
  return true;
}
