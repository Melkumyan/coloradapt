/**
 * Keyframe properties (as `getKeyframes()` spells them) that move an SVG's
 * visible paint. `transform`, `d`, positions and the like do not.
 */
const PAINT_KEYFRAME_PROPERTIES: ReadonlySet<string> = new Set([
  'color',
  'fill',
  'stroke',
  'fillOpacity',
  'strokeOpacity',
  'strokeWidth',
  'opacity',
  'filter',
]);

/**
 * Elements a running CSS animation or Web Animation drives a paint property on.
 * Their computed paint is a snapshot of a moving value, so nothing derived from
 * it can be stable (and an `!important` rule would freeze the animation).
 * Environments without `getAnimations` (jsdom) have none.
 */
export function collectAnimatedPaintTargets(doc: Document): Set<Element> {
  const targets = new Set<Element>();
  if (typeof doc.getAnimations !== 'function') return targets;
  for (const animation of doc.getAnimations()) {
    const effect = animation.effect;
    if (!(effect instanceof KeyframeEffect) || !effect.target || effect.pseudoElement) continue;
    const moves = effect
      .getKeyframes()
      .some((keyframe) =>
        Object.keys(keyframe).some((name) => PAINT_KEYFRAME_PROPERTIES.has(name)),
      );
    if (moves) targets.add(effect.target);
  }
  return targets;
}
