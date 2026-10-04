import type { MarkerId } from './types';

/**
 * Marker shapes, drawn in a box of half-size 1 centered on the origin (scaled at the use site).
 * `circle` is "as drawn" for scatter points; for lines every shape is a real marker.
 */
export interface MarkerGlyph {
  /** `fill` shapes are painted solid; `stroke` shapes are lines (a cross cannot be filled). */
  readonly paint: 'fill' | 'stroke';
  readonly d: string;
}

const GLYPHS: Readonly<Record<MarkerId, MarkerGlyph>> = {
  circle: { paint: 'fill', d: 'M -1 0 A 1 1 0 1 0 1 0 A 1 1 0 1 0 -1 0 Z' },
  square: { paint: 'fill', d: 'M -1 -1 H 1 V 1 H -1 Z' },
  triangle: { paint: 'fill', d: 'M 0 -1.15 L 1.15 0.95 H -1.15 Z' },
  diamond: { paint: 'fill', d: 'M 0 -1.3 L 1.3 0 L 0 1.3 L -1.3 0 Z' },
  cross: { paint: 'stroke', d: 'M -1 -1 L 1 1 M -1 1 L 1 -1' },
  plus: { paint: 'stroke', d: 'M -1.2 0 H 1.2 M 0 -1.2 V 1.2' },
  ring: { paint: 'stroke', d: 'M -1 0 A 1 1 0 1 0 1 0 A 1 1 0 1 0 -1 0 Z' },
};

export function markerGlyph(id: MarkerId): MarkerGlyph {
  return GLYPHS[id];
}

/** Marker shapes for lines, in preference order. */
export const LINE_MARKERS: readonly MarkerId[] = [
  'circle',
  'square',
  'triangle',
  'diamond',
  'cross',
];

/**
 * How a scatter point is given another silhouette without a node of its own: the point is clipped
 * to a shape drawn in its own bounding box (`clip-path: polygon(...)`, percentages of that box), or
 * hollowed (`ring`: no fill, a stroke in the series color). Everything is CSS on the point itself, so
 * it follows the point wherever the page moves, hides, fades or removes it, and no DOM is added.
 * Clipping only ever removes area (a circle in its box), so no point grows or moves.
 */
export interface PointShape {
  /** `clip-path` value, or null. */
  readonly clip: string | null;
  /** Painted as an outline in the series color instead of a disc. */
  readonly hollow: boolean;
}

const POINT_SHAPES: Readonly<Partial<Record<MarkerId, PointShape>>> = {
  diamond: { clip: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)', hollow: false },
  triangle: { clip: 'polygon(50% 0%, 100% 100%, 0% 100%)', hollow: false },
  plus: {
    clip: 'polygon(35% 0%, 65% 0%, 65% 35%, 100% 35%, 100% 65%, 65% 65%, 65% 100%, 35% 100%, 35% 65%, 0% 65%, 0% 35%, 35% 35%)',
    hollow: false,
  },
  cross: {
    clip: 'polygon(20% 0%, 50% 30%, 80% 0%, 100% 20%, 70% 50%, 100% 80%, 80% 100%, 50% 70%, 20% 100%, 0% 80%, 30% 50%, 0% 20%)',
    hollow: false,
  },
  ring: { clip: null, hollow: true },
};

/** The treatment of a point for a marker id; null for a shape the page already draws (`circle`). */
export function pointShape(id: MarkerId): PointShape | null {
  return POINT_SHAPES[id] ?? null;
}

/** Point shapes for scatter series, in preference order (the filled circle is what the page drew). */
export const POINT_MARKERS: readonly MarkerId[] = ['diamond', 'triangle', 'plus', 'cross', 'ring'];
