import type { ColorValue } from '@domain/models';
import { parseColor } from '@core/color';
import { parsePaint } from './paint';
import { scanSvg, type StyleReader } from './scan';

const TOLERANCE = 0.5 / 255;

function matches(color: ColorValue, expected: ColorValue): boolean {
  return (
    color.alpha >= 0.999 &&
    Math.abs(color.r - expected.r) <= TOLERANCE &&
    Math.abs(color.g - expected.g) <= TOLERANCE &&
    Math.abs(color.b - expected.b) <= TOLERANCE
  );
}

/**
 * After an SVG's rules were applied: does *every* visible solid paint of the
 * shapes inside `root` read `expected`? A rule on the `<svg>` that a shape's own
 * declaration out-ranks (`<path style="fill: red !important">`, a local `color`)
 * leaves that shape unchanged; the plan then must not claim success.
 *
 * `<use>` instances are not visible to `getComputedStyle`, so they are covered
 * only by the rule-level check on the `<use>` element itself.
 */
export function verifySvgPaints(
  root: Element,
  expected: ColorValue,
  getStyle: StyleReader,
): boolean {
  const scan = scanSvg(root, getStyle);
  if (scan.overBudget) return false;
  for (const painted of scan.painted) {
    for (const [value, visible] of [
      [painted.fill, painted.fillOpacity > 0],
      [painted.stroke, painted.strokeOpacity > 0 && painted.strokeWidth > 0],
    ] as const) {
      if (!visible) continue;
      const paint = parsePaint(value);
      if (paint.kind === 'none') continue;
      if (paint.kind !== 'solid') return false;
      const color = parseColor(value);
      if (!color || !matches(color, expected)) return false;
    }
  }
  return true;
}
