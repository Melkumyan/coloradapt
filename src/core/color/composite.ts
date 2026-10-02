import type { ColorValue } from '@domain/models';
import { clamp01 } from '@shared/utils';

/**
 * Standard Porter-Duff "source over" alpha compositing: paints `top` over
 * `bottom`, honoring both colors' alpha. Unlike {@link flattenOnBackground}
 * in `contrast.ts` (which assumes an opaque backdrop), this handles the
 * case where `bottom` itself is still partially transparent — the shape
 * needed when folding a stack of semi-transparent ancestor backgrounds.
 */
export function compositeColors(top: ColorValue, bottom: ColorValue): ColorValue {
  const outAlpha = top.alpha + bottom.alpha * (1 - top.alpha);
  if (outAlpha <= 0) {
    return { r: 0, g: 0, b: 0, alpha: 0 };
  }

  const r = (top.r * top.alpha + bottom.r * bottom.alpha * (1 - top.alpha)) / outAlpha;
  const g = (top.g * top.alpha + bottom.g * bottom.alpha * (1 - top.alpha)) / outAlpha;
  const b = (top.b * top.alpha + bottom.b * bottom.alpha * (1 - top.alpha)) / outAlpha;

  return { r: clamp01(r), g: clamp01(g), b: clamp01(b), alpha: clamp01(outAlpha) };
}
