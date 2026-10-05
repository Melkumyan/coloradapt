/**
 * The M10 contrast oracle. Deliberately shares no code with `src/core`: it is written straight from the
 * WCAG 2.x definitions of relative luminance and contrast ratio, so a mistake in ColorAdapt's own color
 * math cannot confirm itself. The page-side probe only reports what the browser resolved (colors, layers,
 * flags); every number is computed here.
 */

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Parses `rgb(...)`/`rgba(...)` as `getComputedStyle` reports it (comma or space syntax), else null. */
export function parseCssColor(value: string): Rgba | null {
  const m =
    /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(
      value.trim(),
    );
  if (!m) return null;
  const alpha =
    m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: Math.min(1, Math.max(0, alpha)) };
}

/** `top` painted over `bottom` (source-over). `bottom` is treated as opaque for the final result. */
export function compositeOver(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an opaque color. */
export function relativeLuminance(c: Rgba): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG contrast ratio, 1..21. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** One painted layer of a background stack, outermost last (as the probe walks child to root). */
export type BackgroundLayer =
  | { readonly kind: 'color'; readonly color: string }
  | { readonly kind: 'gradient' }
  | { readonly kind: 'image' };

export type OracleStatus =
  | 'RESOLVED'
  | 'UNRESOLVED_GRADIENT'
  | 'UNRESOLVED_IMAGE'
  | 'UNRESOLVED_TEXT_CLIP'
  | 'UNRESOLVED_EFFECT';

export interface OracleInput {
  /** Computed text color (`color`, or the text fill when it differs). */
  readonly color: string;
  /** Product of the `opacity` of the element and its ancestors. */
  readonly opacity: number;
  /** Layers from the element up to the root. */
  readonly layers: readonly BackgroundLayer[];
  /** Whether the canvas behind the root is dark (`color-scheme: dark`). */
  readonly darkCanvas: boolean;
  /** `-webkit-background-clip: text`, `mix-blend-mode`, `filter`, `backdrop-filter` on the element or an ancestor. */
  readonly effects: boolean;
  readonly clipText: boolean;
}

export interface OracleResult {
  readonly status: OracleStatus;
  readonly ratio: number | null;
  readonly foreground: Rgba | null;
  readonly background: Rgba | null;
}

/** Resolves the effective foreground and background of a text element, or says why it cannot. */
export function resolveContrast(input: OracleInput): OracleResult {
  const none = { ratio: null, foreground: null, background: null } as const;
  if (input.clipText) return { status: 'UNRESOLVED_TEXT_CLIP', ...none };
  if (input.effects) return { status: 'UNRESOLVED_EFFECT', ...none };
  const fg = parseCssColor(input.color);
  if (!fg) return { status: 'UNRESOLVED_EFFECT', ...none };
  // A gradient or an image anywhere in the opaque-so-far stack decides the background: not a solid color.
  let stack: Rgba = { r: 0, g: 0, b: 0, a: 0 };
  for (const layer of input.layers) {
    if (layer.kind === 'gradient') return { status: 'UNRESOLVED_GRADIENT', ...none };
    if (layer.kind === 'image') return { status: 'UNRESOLVED_IMAGE', ...none };
    const color = parseCssColor(layer.color);
    if (!color || color.a === 0) continue;
    // Layers are visited child to root: what is already in `stack` is on top of this one.
    stack = stack.a === 0 ? color : compositeOver(stack, color);
    if (stack.a >= 1) break;
  }
  const canvas: Rgba = input.darkCanvas
    ? { r: 18, g: 18, b: 18, a: 1 }
    : { r: 255, g: 255, b: 255, a: 1 };
  const background = stack.a >= 1 ? stack : compositeOver(stack, canvas);
  const alpha = fg.a * input.opacity;
  const foreground = compositeOver({ ...fg, a: alpha }, background);
  return {
    status: 'RESOLVED',
    ratio: contrastRatio(foreground, background),
    foreground,
    background,
  };
}

/** The target an element's text has to reach: 3:1 for large text, else 4.5:1 (WCAG 2.x SC 1.4.3 numbers). */
export function contrastTarget(fontSizePx: number, fontWeight: number): number {
  const large = fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
  return large ? 3 : 4.5;
}

export function toHex(c: Rgba): string {
  const h = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}
