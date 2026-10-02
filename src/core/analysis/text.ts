/**
 * True if `element` has a non-whitespace text node as a *direct* child,
 * as opposed to text that only exists inside a nested element. Used to
 * avoid double-counting the same visible text for both a wrapper (e.g.
 * `<p>`) and the inner element that actually carries it (e.g. `<span>`) —
 * see docs/CSS_ANALYSIS.md.
 */
export function hasOwnText(element: Element): boolean {
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim().length > 0) {
      return true;
    }
  }
  return false;
}
