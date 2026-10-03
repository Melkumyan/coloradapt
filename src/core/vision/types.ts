import type { Vec3 } from '@core/color';
import type { VisionModel } from '@domain/models';

/** Which cone class is missing (dichromacy) or shifted (anomalous trichromacy). */
export type CvdFamily = 'protan' | 'deutan' | 'tritan';

/** `mono` is used by profiles that are not a single-cone-class deficiency (achromatopsia). */
export type VisionFamily = CvdFamily | 'mono';

/** A pure transform of one linear-light RGB color. */
export interface LinearVisionModel {
  readonly id: VisionModel;
  supports(family: VisionFamily): boolean;
  /** Output is unclamped and may lie outside the sRGB gamut. */
  transform(linear: Vec3, family: VisionFamily, severity: number): Vec3;
}
