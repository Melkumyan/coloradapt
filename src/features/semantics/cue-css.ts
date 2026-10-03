import type { CueSpec, OutlineStyle } from '@core/semantics';

/** The attribute that marks an element as carrying a ColorAdapt semantic cue. Its value selects the cue. */
export const CUE_ATTRIBUTE = 'data-coloradapt-cue';

/**
 * Tone of the glyph drawn inside a dot: `l`ight on dark dots, `d`ark on light ones, `c`urrent
 * text color when the dot has no solid fill of its own.
 */
export type DotTone = 'l' | 'd' | 'c';

export interface CueVariant {
  /** Dot cues only. */
  readonly tone?: DotTone;
  /** Dot cues only: the dot's smaller side in px. */
  readonly size?: number;
}

const hex = (glyph: string) => glyph.codePointAt(0)!.toString(16);
const char = (code: string) => String.fromCodePoint(Number.parseInt(code, 16));

/**
 * The attribute value for a cue. It is the *whole* description of how the cue looks, so the
 * stylesheet is a pure function of the set of keys in use, and an element's cue can be
 * compared, replaced and removed by comparing strings.
 */
export function cueKey(spec: CueSpec, variant: CueVariant = {}): string {
  switch (spec.placement) {
    case 'after':
    case 'before':
      return `${spec.placement}:${hex(spec.glyph ?? '')}`;
    case 'inner':
      return `inner:${hex(spec.glyph ?? '')}:${variant.tone ?? 'c'}:${variant.size ?? 10}`;
    case 'outline':
      return `outline:${spec.outline ?? 'dashed'}`;
    case 'underline':
      return 'underline';
  }
}

/** Pins the cue above anything the page can say about the same property. */
const IMPORTANT = ' !important';

const OUTLINE_WIDTH: Readonly<Record<OutlineStyle, number>> = {
  dashed: 2,
  dotted: 2,
  solid: 2,
  double: 3,
};

/**
 * The font every text glyph is drawn in, whatever the page uses (an icon font on the host would
 * turn `×` into a blank). Every glyph in `CUE_GLYPHS` that is drawn as text is in WGL4 / Latin-1
 * (`× ! * + − ↑ ↓` and the ASCII `i`), which every one of these families covers; the two that are
 * not (`✓`, `ℹ`) are not drawn as text at all (see {@link renderedGlyph}).
 */
export const CUE_FONT_FAMILY =
  'system-ui,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans","DejaVu Sans",sans-serif';

/** The check mark, as a polygon in a unit box (percent): bold enough to read at 10px. */
const CHECK_POLYGON: readonly (readonly [number, number])[] = [
  [3, 62],
  [39, 97],
  [100, 24],
  [84, 12],
  [37, 67],
  [17, 48],
];

/**
 * What is actually drawn for a cue glyph. `✓` (U+2713) and `ℹ` (U+2139) are in few fonts, so
 * they are never relied on as text: `✓` is a shape (`''`: no text at all) and `ℹ` is a plain
 * ASCII `i` in a ring. Everything else is itself.
 */
export function renderedGlyph(glyph: string): string {
  if (glyph === '✓') return '';
  if (glyph === 'ℹ') return 'i';
  return glyph;
}

/** Both `content` declarations: the second (with an empty alternative text) is the one assistive technology honors. */
function content(text: string): string {
  const escaped = text === '' ? '""' : `"\\${hex(text)} "`; // CSS escape, terminated by a space
  return `content:${escaped}${IMPORTANT};content:${escaped} / ""${IMPORTANT};`;
}

const INERT_GLYPH =
  'pointer-events:none;user-select:none;text-decoration:none;text-transform:none;letter-spacing:normal;font-style:normal;';

/** Forced-colors mode replaces backgrounds: a shape drawn as a background must be told to stay visible. */
function forcedColors(selector: string, pseudo: 'after' | 'before' = 'after'): string {
  return (
    `@media (forced-colors:active){${selector}::${pseudo}{forced-color-adjust:none${IMPORTANT};` +
    `background-color:CanvasText${IMPORTANT};}}`
  );
}

function glyphRule(selector: string, placement: 'after' | 'before', code: string): string {
  const margin = placement === 'after' ? '0 0 0 .25em' : '0 .25em 0 0';
  const glyph = char(code);
  const text = renderedGlyph(glyph);
  const pseudo = `${selector}::${placement}`;
  if (text === '') {
    // A shape, in the text color. Its baseline is its bottom edge, like a glyph's.
    const polygon = CHECK_POLYGON.map(([x, y]) => `${x}% ${y}%`).join(',');
    return (
      `${pseudo}{${content('')}display:inline-block${IMPORTANT};width:.8em;height:.8em;margin:${margin};` +
      `background-color:currentColor${IMPORTANT};clip-path:polygon(${polygon})${IMPORTANT};${INERT_GLYPH}}\n` +
      forcedColors(selector, placement)
    );
  }
  // Zero line-height: a glyph never makes its line taller.
  const ring =
    glyph === 'ℹ'
      ? `display:inline-block${IMPORTANT};box-sizing:border-box;width:1.3em;height:1.3em;` +
        `line-height:1.1em${IMPORTANT};text-align:center;border:.1em solid currentColor;border-radius:50%;` +
        `font-size:.8em;font-style:italic${IMPORTANT};font-family:Georgia,"Times New Roman",serif${IMPORTANT};`
      : `font-family:${CUE_FONT_FAMILY}${IMPORTANT};line-height:0${IMPORTANT};`;
  return `${pseudo}{${content(text)}margin:${margin};font-weight:700;${ring}${INERT_GLYPH}}`;
}

function innerRule(selector: string, code: string, tone: string, sizeText: string): string {
  const size = Math.max(4, Number.parseInt(sizeText, 10) || 10);
  const fontSize = Math.max(6, Math.round(size * 0.72));
  const color = tone === 'l' ? '#fff' : tone === 'd' ? '#000' : 'currentColor';
  const text = renderedGlyph(char(code));
  // `overflow:hidden` keeps an inline-block dot on its baseline (it is the bottom margin edge
  // of a box that clips), so adding the glyph moves nothing.
  const host = `${selector}{overflow:hidden${IMPORTANT};}\n`;
  if (text === '') {
    // The check is clipped out of a box that fills the dot, around the dot's center, scaled to its smaller side.
    const reach = size * 0.62;
    const at = (percent: number) => `${(((percent - 50) / 100) * reach).toFixed(2)}px`;
    const polygon = CHECK_POLYGON.map(([x, y]) => `calc(50% + ${at(x)}) calc(50% + ${at(y)})`).join(
      ',',
    );
    return (
      host +
      `${selector}::after{${content('')}display:block${IMPORTANT};box-sizing:border-box;` +
      `width:100%;height:100%;background-color:${color}${IMPORTANT};clip-path:polygon(${polygon})${IMPORTANT};${INERT_GLYPH}}\n` +
      forcedColors(selector)
    );
  }
  return (
    host +
    `${selector}::after{${content(text)}` +
    `display:flex${IMPORTANT};align-items:center;justify-content:center;box-sizing:border-box;` +
    `width:100%;height:100%;font:700 ${fontSize}px/1 ${CUE_FONT_FAMILY}${IMPORTANT};` +
    `color:${color}${IMPORTANT};${INERT_GLYPH}}`
  );
}

function outlineRule(selector: string, styleName: string): string {
  const style = (styleName in OUTLINE_WIDTH ? styleName : 'dashed') as OutlineStyle;
  // The pattern is for the resting state; while focused the browser's focus ring is restored
  // (a separate rule, so an engine without `:focus-visible` still gets the pattern).
  return (
    `${selector}{outline-width:${OUTLINE_WIDTH[style]}px${IMPORTANT};outline-style:${style}${IMPORTANT};` +
    `outline-color:currentColor${IMPORTANT};outline-offset:2px${IMPORTANT};}\n` +
    `${selector}:focus-visible{outline:auto${IMPORTANT};outline-offset:1px${IMPORTANT};}`
  );
}

/** The CSS for one cue key. Unknown keys produce nothing. */
export function cueRule(key: string): string {
  const selector = `[${CUE_ATTRIBUTE}="${key}"]`;
  const [placement, a, b, c] = key.split(':');
  switch (placement) {
    case 'after':
    case 'before':
      return a ? glyphRule(selector, placement, a) : '';
    case 'inner':
      return a ? innerRule(selector, a, b ?? 'c', c ?? '10') : '';
    case 'outline':
      return outlineRule(selector, a ?? 'dashed');
    case 'underline':
      return `${selector}{text-decoration-line:underline${IMPORTANT};text-decoration-thickness:2px${IMPORTANT};text-underline-offset:.2em${IMPORTANT};}`;
    default:
      return '';
  }
}

/** The stylesheet text for the cue keys in use (sorted: the same set always yields the same text). */
export function cueSheet(keys: Iterable<string>): string | null {
  const rules = [...new Set(keys)]
    .sort()
    .map(cueRule)
    .filter((rule) => rule !== '');
  return rules.length > 0 ? rules.join('\n') : null;
}
