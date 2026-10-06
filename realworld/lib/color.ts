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

/**
 * Parses what `getComputedStyle` reports for a color: `rgb()`/`rgba()` (comma or space syntax) and
 * `color(srgb r g b [/ a])`, which Chrome reports for colors written with `color-mix()`, `color(srgb ...)` and
 * relative colors. Anything else (`lab()`, `oklch()`, `color(display-p3 ...)`) is `null`: the caller must treat
 * that as *unknown*, never as transparent (an earlier version skipped such a layer, took the background to be
 * white and reported dark code blocks as 1.2:1).
 */
export function parseCssColor(value: string): Rgba | null {
  const text = value.trim();
  const m =
    /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(
      text,
    );
  if (m) {
    const alpha =
      m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return {
      r: Number(m[1]),
      g: Number(m[2]),
      b: Number(m[3]),
      a: Math.min(1, Math.max(0, alpha)),
    };
  }
  const c =
    /^color\(\s*srgb\s+([\d.e+-]+%?)\s+([\d.e+-]+%?)\s+([\d.e+-]+%?)\s*(?:\/\s*([\d.e+-]+%?)\s*)?\)$/.exec(
      text,
    );
  if (!c) return null;
  const unit = (v: string): number => (v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v));
  const byte = (v: string): number => Math.min(255, Math.max(0, unit(v) * 255));
  const alpha = c[4] === undefined ? 1 : Math.min(1, Math.max(0, unit(c[4])));
  const rgba = { r: byte(c[1]!), g: byte(c[2]!), b: byte(c[3]!), a: alpha };
  return [rgba.r, rgba.g, rgba.b, rgba.a].every(Number.isFinite) ? rgba : null;
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

/**
 * What one element on the way from the text to the root contributes: its own `opacity` and the background it
 * paints. CSS composites an element and its descendants as one *group*: the group is the content below it,
 * painted over the element's own background, then faded by the element's opacity. So an `opacity: .5` ancestor
 * fades its own background together with the text, not the text alone.
 */
export type ChainPaint =
  | { readonly kind: 'color'; readonly color: string }
  | { readonly kind: 'gradient' }
  | { readonly kind: 'image' };

export interface ChainEntry {
  readonly opacity: number;
  readonly paint: ChainPaint | null;
}

export type OracleStatus =
  | 'RESOLVED'
  | 'UNRESOLVED_GRADIENT'
  | 'UNRESOLVED_IMAGE'
  | 'UNRESOLVED_TEXT_CLIP'
  | 'UNRESOLVED_EFFECT'
  | 'UNRESOLVED_COLOR_FORMAT';

export interface OracleInput {
  /** Computed text color (`color`, or the text fill when it differs). */
  readonly color: string;
  /** The element itself first, then every ancestor up to the root. Background paint after the first fully opaque one may be omitted. */
  readonly chain: readonly ChainEntry[];
  /** Whether the canvas behind the root is dark (the used `color-scheme` is dark). */
  readonly darkCanvas: boolean;
  /** The dark canvas of the browser (measured with pixels: Chromium 18/18/18, Firefox 28/27/34). */
  readonly darkCanvasRgb?: readonly [number, number, number];
  /** `mix-blend-mode`, `filter`, `backdrop-filter` on the element or an ancestor. */
  readonly effects: boolean;
  /** `-webkit-background-clip: text` on the element. */
  readonly clipText: boolean;
}

export interface OracleResult {
  readonly status: OracleStatus;
  readonly ratio: number | null;
  readonly foreground: Rgba | null;
  readonly background: Rgba | null;
}

/** Premultiplied color: channels already multiplied by alpha, which makes source-over and fading plain arithmetic. */
interface Premultiplied {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const premultiply = (c: Rgba): Premultiplied => ({
  r: c.r * c.a,
  g: c.g * c.a,
  b: c.b * c.a,
  a: c.a,
});
const over = (top: Premultiplied, bottom: Premultiplied): Premultiplied => ({
  r: top.r + bottom.r * (1 - top.a),
  g: top.g + bottom.g * (1 - top.a),
  b: top.b + bottom.b * (1 - top.a),
  a: top.a + bottom.a * (1 - top.a),
});
const fade = (c: Premultiplied, opacity: number): Premultiplied => ({
  r: c.r * opacity,
  g: c.g * opacity,
  b: c.b * opacity,
  a: c.a * opacity,
});

type Painted =
  Premultiplied | 'unresolved-gradient' | 'unresolved-image' | 'unresolved-color-format';

/** The group from the element up to the root, with `content` (the text, or nothing) at the innermost level. */
function paintChain(content: Premultiplied, chain: readonly ChainEntry[]): Painted {
  let group = content;
  for (const entry of chain) {
    if (entry.paint?.kind === 'gradient') return 'unresolved-gradient';
    if (entry.paint?.kind === 'image') return 'unresolved-image';
    if (entry.paint?.kind === 'color') {
      const color = parseCssColor(entry.paint.color);
      // a color the oracle cannot read is unknown, not transparent
      if (!color) return 'unresolved-color-format';
      group = over(group, premultiply(color));
    }
    group = fade(group, Math.min(1, Math.max(0, entry.opacity)));
  }
  return group;
}

/** Resolves the effective foreground and background of a text element, or says why it cannot. */
export function resolveContrast(input: OracleInput): OracleResult {
  const none = { ratio: null, foreground: null, background: null } as const;
  if (input.clipText) return { status: 'UNRESOLVED_TEXT_CLIP', ...none };
  if (input.effects) return { status: 'UNRESOLVED_EFFECT', ...none };
  const fg = parseCssColor(input.color);
  if (!fg) return { status: 'UNRESOLVED_COLOR_FORMAT', ...none };
  const dark = input.darkCanvasRgb ?? [18, 18, 18];
  const canvas: Premultiplied = input.darkCanvas
    ? { r: dark[0], g: dark[1], b: dark[2], a: 1 }
    : { r: 255, g: 255, b: 255, a: 1 };
  const withText = paintChain(premultiply(fg), input.chain);
  const behind = paintChain({ r: 0, g: 0, b: 0, a: 0 }, input.chain);
  for (const painted of [withText, behind]) {
    if (painted === 'unresolved-gradient') return { status: 'UNRESOLVED_GRADIENT', ...none };
    if (painted === 'unresolved-image') return { status: 'UNRESOLVED_IMAGE', ...none };
    if (painted === 'unresolved-color-format')
      return { status: 'UNRESOLVED_COLOR_FORMAT', ...none };
  }
  const flat = (p: Premultiplied): Rgba => {
    const total = over(p, canvas);
    return { r: total.r, g: total.g, b: total.b, a: 1 };
  };
  const foreground = flat(withText as Premultiplied);
  const background = flat(behind as Premultiplied);
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
