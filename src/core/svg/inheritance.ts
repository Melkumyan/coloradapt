import { ELEMENT_ID_ATTRIBUTE } from '@core/analysis/constants';
import type { PaintDerivation } from './paint';

/**
 * Computed styles only report *values*: `fill="currentColor"`, an explicit
 * `fill="rgb(200,0,0)"`, and a `fill` inherited from the `<svg>` all read
 * `rgb(200, 0, 0)`. Which declaration owns the paint decides which rule can
 * change it, so it is found by experiment.
 *
 * For one synchronous style flush the probed element (an outermost `<svg>`, or
 * the parent of a `<use>` target) is given three distinct sentinel colors for
 * `fill`, `stroke` and `color`. A descendant whose computed `fill` then reads
 *
 * - the `fill` sentinel inherits `fill` from the probed element;
 * - the `color` sentinel paints with `currentColor`;
 * - anything else declares its own paint ("explicit").
 *
 * The probe is applied and removed within one task (nothing is painted), with
 * transitions suppressed on the probed subtree so a page's own `transition:
 * fill` can neither blur the reading nor start fading when the probe goes.
 *
 * "Inherits `fill` from the probed element" is not yet an owner: the probed
 * element's own `fill` may itself be `currentColor` (`<svg stroke="currentColor">`,
 * `.icon { fill: currentColor }`, the usual icon-library pattern), in which case
 * the paint is still `color`'s. A second, color-only probe tells those apart: with
 * only `color` replaced, an inherited paint that still reads the `color` sentinel
 * follows `currentColor`; one that keeps its own value does not.
 */
export const PROBE_COLORS = {
  fill: 'rgb(1, 2, 3)',
  stroke: 'rgb(2, 3, 1)',
  color: 'rgb(3, 2, 1)',
} as const;

/** Runs `read` with `css` in effect (and removes it again). */
export type SvgStyleProbe = <T>(css: string, read: () => T) => T;

/** Same raised specificity as the adaptation rules (see stylesheet-manager). */
const SPECIFICITY_BUMP = ':not(#coloradapt-specificity)';

function escapeAttributeValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/** The stylesheet text of one probe over the elements carrying `ids`. */
export function buildProbeCss(ids: readonly string[]): string {
  if (ids.length === 0) return '';
  const targets = ids
    .map((id) => `[${ELEMENT_ID_ATTRIBUTE}="${escapeAttributeValue(id)}"]`)
    .join(', ');
  return [
    `:is(${targets})${SPECIFICITY_BUMP} { fill: ${PROBE_COLORS.fill} !important; ` +
      `stroke: ${PROBE_COLORS.stroke} !important; color: ${PROBE_COLORS.color} !important; }`,
    `:is(${targets}), :is(${targets}) * { transition: none !important; }`,
  ].join('\n');
}

/** The second probe: only `color` is replaced (see above). */
export function buildColorProbeCss(ids: readonly string[]): string {
  if (ids.length === 0) return '';
  const targets = ids
    .map((id) => `[${ELEMENT_ID_ATTRIBUTE}="${escapeAttributeValue(id)}"]`)
    .join(', ');
  return [
    `:is(${targets})${SPECIFICITY_BUMP} { color: ${PROBE_COLORS.color} !important; }`,
    `:is(${targets}), :is(${targets}) * { transition: none !important; }`,
  ].join('\n');
}

/** What a probed element's computed `fill`/`stroke` says about where the paint comes from. */
export function derivationOf(property: 'fill' | 'stroke', computed: string): PaintDerivation {
  const value = computed.trim();
  if (value === PROBE_COLORS[property]) return 'inherited';
  if (value === PROBE_COLORS.color) return 'currentColor';
  return 'explicit';
}
