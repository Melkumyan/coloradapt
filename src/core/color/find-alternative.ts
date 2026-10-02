import type { ColorValue } from '@domain/models';
import { clamp01 } from '@shared/utils';
import { calculateContrast } from './contrast';
import { convertColor, oklchToColor } from './convert';

const MAX_STEPS = 24;

/**
 * Searches for a color close to `foreground` (same hue/chroma, adjusted
 * lightness) that reaches `targetContrast` against `background`. This is a
 * minimal, replaceable heuristic — it does not try to preserve the
 * original color's intent beyond lightness, and it may fail to reach the
 * target for extreme backgrounds, in which case it returns its best effort.
 */
export function findAlternativeColor(
  foreground: ColorValue,
  background: ColorValue,
  targetContrast = 4.5,
): ColorValue {
  if (calculateContrast(foreground, background) >= targetContrast) {
    return foreground;
  }

  const oklch = convertColor(foreground);
  const backgroundIsLight = convertColor(background).l > 0.5;

  let best = foreground;
  let bestContrast = calculateContrast(foreground, background);

  for (let step = 1; step <= MAX_STEPS; step += 1) {
    const t = step / MAX_STEPS;
    const l = backgroundIsLight ? clamp01(oklch.l * (1 - t)) : clamp01(oklch.l + (1 - oklch.l) * t);
    const candidate = oklchToColor({ ...oklch, l }, foreground.source);
    const contrast = calculateContrast(candidate, background);

    if (contrast > bestContrast) {
      best = candidate;
      bestContrast = contrast;
    }
    if (contrast >= targetContrast) {
      return candidate;
    }
  }

  return best;
}
