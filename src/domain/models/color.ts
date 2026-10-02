/**
 * A parsed, normalized color value. Kept independent of any particular
 * color library so the rest of the domain never has to depend on `culori`
 * (or whatever parsing/conversion library `core/color` happens to use).
 */
export interface ColorValue {
  /** Red channel, 0-1, sRGB gamma-encoded. */
  readonly r: number;
  /** Green channel, 0-1, sRGB gamma-encoded. */
  readonly g: number;
  /** Blue channel, 0-1, sRGB gamma-encoded. */
  readonly b: number;
  /** Alpha channel, 0-1. */
  readonly alpha: number;
  /** The original CSS color string this value was parsed from, if any. */
  readonly source?: string;
}

export interface ColorPair {
  readonly foreground: ColorValue;
  readonly background: ColorValue;
}
