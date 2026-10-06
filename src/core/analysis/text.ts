/**
 * True if `element` has a non-whitespace text node as a *direct* child,
 * as opposed to text that only exists inside a nested element. Used to
 * avoid double-counting the same visible text for both a wrapper (e.g.
 * `<p>`) and the inner element that actually carries it (e.g. `<span>`) —
 * see docs/CSS_ANALYSIS.md.
 */
/** A character that can be painted: not whitespace and not a zero-width or invisible format character (U+200B-200D, U+2060, U+FEFF). */
const VISIBLE_CHARACTER = /[^\s\u200B-\u200D\u2060\uFEFF]/;

/** Whether a string holds a character that can be painted. */
export function hasPaintableCharacter(text: string): boolean {
  return VISIBLE_CHARACTER.test(text);
}

export function hasOwnText(element: Element): boolean {
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && VISIBLE_CHARACTER.test(node.textContent ?? '')) {
      return true;
    }
  }
  return false;
}
