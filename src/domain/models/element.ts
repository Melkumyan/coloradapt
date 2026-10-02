import type { ColorPair, ColorValue } from './color';

/**
 * Coarse semantic role of an analyzed element. This is the seam where
 * future semantic understanding (success/error/status/charts/etc.) plugs
 * in without changing the analyzer's traversal logic.
 */
export type ElementRole =
  | 'text'
  | 'link'
  | 'button'
  | 'badge'
  | 'status'
  | 'form-control'
  | 'icon'
  | 'svg'
  | 'image'
  | 'chart'
  | 'generic';

/**
 * How an element's visual background was determined. Only `solid` means
 * `colorPair.background` is trustworthy enough to drive contrast/conflict
 * decisions — see `analysisStatus` and docs/CSS_ANALYSIS.md.
 */
export type BackgroundKind = 'solid' | 'gradient' | 'image' | 'mixed' | 'none';

/**
 * Overall confidence in an element's resolved colors.
 * - `resolved`: background is a solid, fully composited color; contrast
 *   conclusions are safe to draw.
 * - `partial`: resolution hit a known limit (e.g. ancestor-depth budget)
 *   but produced a best-effort color; treat conclusions cautiously.
 * - `unsupported`: background involves a gradient/image somewhere in the
 *   visible stack; do not draw contrast conclusions or adapt.
 */
export type AnalysisStatus = 'resolved' | 'partial' | 'unsupported';

/** Per-side border colors, present only for sides that actually render a border. */
export interface BorderColors {
  readonly top?: ColorValue;
  readonly right?: ColorValue;
  readonly bottom?: ColorValue;
  readonly left?: ColorValue;
}

export interface ElementDescriptor {
  /** Stable id assigned by the analyzer for this analysis pass, used to
   * correlate conflicts/adaptations back to a DOM node via a data attribute. */
  readonly id: string;
  readonly tagName: string;
  readonly role: ElementRole;
  /** Effective, fully opaque foreground/background pair after ancestor
   * traversal and alpha compositing — see `core/analysis/background-resolution.ts`
   * and `core/analysis/foreground-resolution.ts`. */
  readonly colorPair: ColorPair;
  readonly backgroundKind: BackgroundKind;
  readonly analysisStatus: AnalysisStatus;
  readonly borders?: BorderColors;
  readonly isVisible: boolean;
  readonly hasTextContent: boolean;
  readonly disabled?: boolean;
}
