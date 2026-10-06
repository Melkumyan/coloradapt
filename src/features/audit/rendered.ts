import { hasPaintableCharacter } from '@core/analysis';

/**
 * Is this element's text actually painted? The audit only judges what a visitor can see (docs/AUDIT_RULES.md:
 * "visible text"). The analysis pass deliberately reads only an element's *own* style (cheap, and the
 * adaptation wants to prepare content that a CSS-only menu reveals later), so an element inside a
 * `display: none` subtree still has a descriptor. Reporting a contrast "issue" for text nobody can see was
 * the largest source of noise in the M10 real-world comparison (about half of all reported contrast
 * findings), so the audit asks this question itself.
 *
 * Rendered means: it (or, for `display: contents`, the ancestor that supplies its box) has a box, no
 * ancestor is `display: none`, `content-visibility: hidden` or fully transparent, and it is not
 * `visibility: hidden`, and its text has a size (`font-size: 0` paints nothing). Off-screen and below-the-fold text is rendered: it has a box and can be scrolled to.
 */
export function isRendered(
  node: Element,
  getStyle: (element: Element) => CSSStyleDeclaration = (el) => getComputedStyle(el),
): boolean {
  // the content of <video>, <audio> and <canvas> is fallback for browsers that cannot play or draw them
  if (node.closest('video, audio, canvas') !== null) return false;
  // text at `font-size: 0` has glyphs of no size: nothing is painted (a common way to hide a label)
  if (Number.parseFloat(getStyle(node).fontSize) === 0) return false;
  // `display: contents` has no box of its own; its text is painted in the parent's box
  let box: Element | null = node;
  while (box && getStyle(box).display === 'contents') box = box.parentElement;
  if (!box) return false;
  if (typeof box.checkVisibility === 'function') {
    try {
      if (!box.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      // the visually-hidden pattern: everything is clipped away, whatever size the box has
      const boxStyle = getStyle(box);
      if (boxStyle.clip === 'rect(0px, 0px, 0px, 0px)') return false;
      if (/^inset\(\s*50%/.test(boxStyle.clipPath)) return false;
      // a box of no size that clips what is inside it paints nothing (a hidden input mirror, a 0 x 0 editor
      // textarea); one that lets its content overflow still does
      // text laid out at no size (a badge scaled to zero by `transform`, a collapsed region) paints nothing; the
      // text's own rectangles say so (a form control's value is painted by the browser, with no text box)
      if (!hasPaintedTextBox(node)) return false;
      const { width, height } = box.getBoundingClientRect();
      const overflow = getStyle(box).overflow;
      return !(width === 0 && height === 0 && overflow !== 'visible' && overflow !== '');
    } catch {
      // fall through to the style walk
    }
  }
  for (let current: Element | null = box; current; current = current.parentElement) {
    const style = getStyle(current);
    if (style.display === 'none') return false;
    if (Number.parseFloat(style.opacity || '1') === 0) return false;
    if (style.getPropertyValue('content-visibility') === 'hidden' && current !== box) return false;
  }
  const own = getStyle(node);
  return own.visibility !== 'hidden' && own.visibility !== 'collapse';
}

const FORM_CONTROLS = new Set(['input', 'textarea', 'select', 'button']);

/** Whether some text node of the element has a rectangle of non-zero size (real browsers only; jsdom has no layout). */
function hasPaintedTextBox(node: Element): boolean {
  if (FORM_CONTROLS.has(node.localName)) return true;
  let hasText = false;
  for (const child of node.childNodes) {
    if (child.nodeType !== Node.TEXT_NODE || !hasPaintableCharacter(child.textContent ?? ''))
      continue;
    hasText = true;
    const range = node.ownerDocument.createRange();
    range.selectNodeContents(child);
    for (const rect of range.getClientRects()) {
      if (rect.width > 0 && rect.height > 0) return true;
    }
  }
  // an element with no text of its own (an icon, an image) has no text box to ask
  return !hasText;
}
