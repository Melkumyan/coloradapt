import type { ColorValue } from '@domain/models';
import { parseColor } from '@core/color';

/** What a computed `fill`/`stroke` string says, before asking *what drives it*. */
export type RawPaint =
  | { readonly kind: 'none' }
  | { readonly kind: 'solid'; readonly color: ColorValue }
  | { readonly kind: 'paint-server'; readonly reference: string }
  | { readonly kind: 'context'; readonly value: 'context-fill' | 'context-stroke' }
  | { readonly kind: 'unsupported'; readonly value: string };

/**
 * An SVG paint (docs/SVG_ANALYSIS.md, "Paint model"). `currentColor` is a
 * solid color that the CSS `color` property drives — computed styles resolve
 * it to plain `rgb(...)`, so it is told apart by probing, never by value
 * (see `inheritance.ts`).
 */
export type SvgPaint =
  | { readonly kind: 'none' }
  | { readonly kind: 'solid'; readonly color: ColorValue }
  | { readonly kind: 'currentColor'; readonly color: ColorValue }
  | { readonly kind: 'paint-server'; readonly reference: string }
  | { readonly kind: 'context'; readonly value: 'context-fill' | 'context-stroke' }
  | { readonly kind: 'unsupported'; readonly value: string };

export type PaintServerKind = 'gradient' | 'pattern' | 'other';

/** Which declaration a visible paint comes from (see `inheritance.ts`). */
export type PaintDerivation = 'inherited' | 'currentColor' | 'explicit' | 'unknown';

const URL_PAINT = /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/i;

/**
 * Parses a *computed* `fill`/`stroke` value. Chromium reports `none`, a color
 * (`rgb(...)`, `color(...)`), `url("#id")` optionally followed by a fallback,
 * and `context-fill`/`context-stroke`. Anything else is `unsupported`, never
 * guessed. A fully transparent color paints nothing, so it is `none`.
 */
export function parsePaint(value: string): RawPaint {
  const text = value.trim();
  if (text === '' || text.toLowerCase() === 'none') return { kind: 'none' };

  const url = URL_PAINT.exec(text);
  if (url) return { kind: 'paint-server', reference: (url[1] ?? url[2] ?? url[3] ?? '').trim() };

  const lowered = text.toLowerCase();
  if (lowered === 'context-fill' || lowered === 'context-stroke') {
    return { kind: 'context', value: lowered };
  }

  const color = parseColor(text);
  if (!color) return { kind: 'unsupported', value: text };
  return color.alpha <= 0 ? { kind: 'none' } : { kind: 'solid', color };
}

/** Tells `currentColor` from other solid paints, given how the paint is derived. */
export function withDerivation(paint: RawPaint, derivation: PaintDerivation): SvgPaint {
  if (paint.kind === 'solid' && derivation === 'currentColor') {
    return { kind: 'currentColor', color: paint.color };
  }
  return paint;
}

/**
 * Classifies the `<paint server>` behind `url(#id)`. A reference that is
 * missing, external, or neither a gradient nor a pattern is `other` — still
 * unsupported, just not named.
 */
export function classifyPaintServer(doc: Document, reference: string): PaintServerKind {
  if (!reference.startsWith('#')) return 'other';
  let id = reference.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // keep the raw id
  }
  const target = doc.getElementById(id);
  if (!target) return 'other';
  switch (target.localName.toLowerCase()) {
    case 'lineargradient':
    case 'radialgradient':
      return 'gradient';
    case 'pattern':
      return 'pattern';
    default:
      return 'other';
  }
}

/** Parses a computed numeric property (`fill-opacity`, `stroke-width`, `opacity`); NaN becomes `fallback`. */
export function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}
