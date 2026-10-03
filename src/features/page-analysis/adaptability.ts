import { ELEMENT_ID_ATTRIBUTE } from '@core/analysis';
import { parseColor } from '@core/color';
import type { ElementDescriptor } from '@domain/models';

/** Max per-channel difference (0-1) for "effective color == computed `color`". */
const COLOR_MATCH_TOLERANCE = 1.5 / 255;

/**
 * Elements (as `Element`s) that a running animation drives `color` on —
 * CSS `@keyframes` or Web Animations. Their computed color is a snapshot of a
 * moving value, so no color derived from it can be stable (and a
 * `!important` adaptation would silently freeze the page's animation).
 * Environments without `getAnimations` (jsdom) have none.
 */
function colorAnimationTargets(doc: Document): Set<Element> {
  const targets = new Set<Element>();
  if (typeof doc.getAnimations !== 'function') return targets;
  for (const animation of doc.getAnimations()) {
    const effect = animation.effect;
    if (!(effect instanceof KeyframeEffect) || !effect.target || effect.pseudoElement) continue;
    if (effect.getKeyframes().some((keyframe) => 'color' in keyframe)) {
      targets.add(effect.target);
    }
  }
  return targets;
}

function isAnimatedOrInheritsAnimation(node: Element, animated: ReadonlySet<Element>): boolean {
  for (let current: Element | null = node; current; current = current.parentElement) {
    if (animated.has(current)) return true;
  }
  return false;
}

/**
 * The effective foreground already folds in `opacity` and color alpha.
 * Writing that composite into `color` would apply them twice, so any
 * element whose computed `color` differs from its effective foreground is
 * left alone (fail-safe), as is every element whose `color` is animated.
 *
 * `nodes` (element by id) is what the analyzer just inspected; without it
 * the whole document is searched for tagged elements (the full-scan path).
 */
export function findNotAdaptable(
  doc: Document,
  elements: readonly ElementDescriptor[],
  getStyle: (element: Element) => CSSStyleDeclaration,
  nodes?: ReadonlyMap<string, Element>,
): Set<string> {
  let byId = nodes;
  if (!byId) {
    const found = new Map<string, Element>();
    for (const node of doc.querySelectorAll(`[${ELEMENT_ID_ATTRIBUTE}]`)) {
      const id = node.getAttribute(ELEMENT_ID_ATTRIBUTE);
      if (id) found.set(id, node);
    }
    byId = found;
  }

  const animated = colorAnimationTargets(doc);
  const unsafe = new Set<string>();
  for (const element of elements) {
    const node = byId.get(element.id);
    if (node && animated.size > 0 && isAnimatedOrInheritsAnimation(node, animated)) {
      unsafe.add(element.id);
      continue;
    }
    const computed = node ? parseColor(getStyle(node).color || '') : null;
    const fg = element.colorPair.foreground;
    const matches =
      computed !== null &&
      computed.alpha >= 0.999 &&
      Math.abs(computed.r - fg.r) <= COLOR_MATCH_TOLERANCE &&
      Math.abs(computed.g - fg.g) <= COLOR_MATCH_TOLERANCE &&
      Math.abs(computed.b - fg.b) <= COLOR_MATCH_TOLERANCE;
    if (!matches) unsafe.add(element.id);
  }
  return unsafe;
}
