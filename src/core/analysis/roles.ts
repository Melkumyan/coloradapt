import type { ElementRole } from '@domain/models';

/**
 * Minimal, heuristic semantic classification based on tag/role/class.
 * This is the seam where richer semantic detection (success/error/status,
 * charts, etc. — see docs/ROADMAP.md M6) will plug in later.
 */
export function classifyElementRole(element: Element): ElementRole {
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute('role');
  const className = typeof element.className === 'string' ? element.className.toLowerCase() : '';

  if (tag === 'svg' || element instanceof SVGElement) return 'svg';
  if (tag === 'img') return 'image';
  if (tag === 'a') return 'link';
  if (tag === 'button' || role === 'button') return 'button';
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return 'form-control';
  if (role === 'status' || role === 'alert' || className.includes('status')) return 'status';
  if (className.includes('badge') || className.includes('tag') || className.includes('chip'))
    return 'badge';

  const hasText = (element.textContent ?? '').trim().length > 0;
  return hasText ? 'text' : 'generic';
}

/**
 * True for native form controls with the `disabled` attribute/property,
 * or any element marked `aria-disabled="true"`. Disabled controls are
 * still analyzed (their colors are real and visible) but callers may want
 * to treat conflicts on them with lower priority — browsers render them
 * with UA-defined, often low-contrast styles that the page author didn't
 * choose and typically can't fix via author CSS alone.
 */
export function isElementDisabled(element: Element): boolean {
  if (
    element instanceof HTMLButtonElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLOptionElement ||
    element instanceof HTMLFieldSetElement
  ) {
    return element.disabled;
  }
  return element.getAttribute('aria-disabled') === 'true';
}
