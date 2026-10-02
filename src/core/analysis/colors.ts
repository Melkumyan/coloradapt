import type { BackgroundKind, BorderColors, ColorPair, ColorValue } from '@domain/models';
import { parseColor } from '@core/color';
import {
  resolveEffectiveBackground,
  type BackgroundResolutionCache,
} from './background-resolution';
import { resolveEffectiveForeground } from './foreground-resolution';

export interface ColorResolution {
  readonly colorPair: ColorPair;
  readonly backgroundKind: BackgroundKind;
  /** True if ancestor-depth budget was hit while resolving the background. */
  readonly truncated: boolean;
  /** True if the opacity/compositing model can't be exact for this element. */
  readonly approximate: boolean;
}

/**
 * Resolves `element`'s effective foreground/background pair: foreground
 * color with inherited `color` + cumulative opacity applied, background
 * folded through the ancestor stack with alpha compositing. Both are
 * returned fully opaque (alpha 1), ready for WCAG contrast math. Returns
 * `null` only when `color` itself can't be parsed (should not happen for
 * real computed styles, but guards against hostile/mocked styles in tests).
 */
export function resolveColors(
  element: Element,
  getStyle: (el: Element) => CSSStyleDeclaration,
  cache: BackgroundResolutionCache,
): ColorResolution | null {
  const foreground = resolveEffectiveForeground(element, getStyle, cache);
  if (!foreground) return null;

  const background = resolveEffectiveBackground(element, getStyle, cache);

  return {
    colorPair: { foreground, background: background.color },
    backgroundKind: background.kind,
    truncated: background.truncated,
    approximate: background.approximate,
  };
}

interface BorderSideProperties {
  readonly width: string;
  readonly style: string;
  readonly color: string;
}

function sidePropertiesFor(
  style: CSSStyleDeclaration,
  side: keyof BorderColors,
): BorderSideProperties {
  switch (side) {
    case 'top':
      return {
        width: style.borderTopWidth,
        style: style.borderTopStyle,
        color: style.borderTopColor,
      };
    case 'right':
      return {
        width: style.borderRightWidth,
        style: style.borderRightStyle,
        color: style.borderRightColor,
      };
    case 'bottom':
      return {
        width: style.borderBottomWidth,
        style: style.borderBottomStyle,
        color: style.borderBottomColor,
      };
    case 'left':
      return {
        width: style.borderLeftWidth,
        style: style.borderLeftStyle,
        color: style.borderLeftColor,
      };
  }
}

function readBorderSide(
  style: CSSStyleDeclaration,
  side: keyof BorderColors,
): ColorValue | undefined {
  const { width, style: borderStyle, color: colorValue } = sidePropertiesFor(style, side);
  if (!Number.parseFloat(width) || borderStyle === 'none' || borderStyle === 'hidden') {
    return undefined;
  }

  const color = parseColor(colorValue || '');
  return color && color.alpha > 0 ? color : undefined;
}

/**
 * Reads per-side border colors, omitting sides with no rendered border
 * (zero width, or `border-style: none`/`hidden`) rather than reporting a
 * color nobody will see.
 */
export function readBorders(
  element: Element,
  getStyle: (el: Element) => CSSStyleDeclaration = (el) => getComputedStyle(el),
): BorderColors | undefined {
  const style = getStyle(element);
  const borders: BorderColors = {
    top: readBorderSide(style, 'top'),
    right: readBorderSide(style, 'right'),
    bottom: readBorderSide(style, 'bottom'),
    left: readBorderSide(style, 'left'),
  };

  const hasAny = borders.top || borders.right || borders.bottom || borders.left;
  return hasAny ? borders : undefined;
}
