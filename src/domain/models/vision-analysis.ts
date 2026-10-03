import type { ColorValue } from './color';
import type { VisionProfile } from './vision-profile';

/**
 * Identifies which published (or explicitly approximate) model produced a
 * simulated color. Stored with every result so downstream code can tell how
 * much scientific weight a number carries.
 */
export type VisionModel =
  | 'identity'
  | 'brettel1997'
  | 'vienot1999'
  | 'machado2009'
  | 'brettel1997-interpolated'
  | 'luminance-approximation';

/**
 * - `published`: a published model applied as described by its authors.
 * - `approximation`: a documented approximation that is not backed by an
 *   equally validated physiological model (see docs/COLOR_VISION_SIMULATION.md).
 * - `none`: no simulation is performed.
 */
export type VisionModelFidelity = 'published' | 'approximation' | 'none';

export interface VisionModelInfo {
  readonly id: VisionModel;
  readonly label: string;
  readonly fidelity: VisionModelFidelity;
  readonly reference: string;
}

export const VISION_MODEL_INFO: Readonly<Record<VisionModel, VisionModelInfo>> = {
  identity: {
    id: 'identity',
    label: 'No simulation',
    fidelity: 'none',
    reference: 'Normal vision, or a profile without a supported model (custom).',
  },
  brettel1997: {
    id: 'brettel1997',
    label: 'Brettel, Viénot & Mollon (1997)',
    fidelity: 'published',
    reference:
      'Brettel, Viénot & Mollon (1997), "Computerized simulation of color appearance for dichromats", JOSA A 14(10).',
  },
  vienot1999: {
    id: 'vienot1999',
    label: 'Viénot, Brettel & Mollon (1999)',
    fidelity: 'published',
    reference:
      'Viénot, Brettel & Mollon (1999), "Digital video colourmaps for checking the legibility of displays by dichromats", Color Res. Appl. 24(4).',
  },
  machado2009: {
    id: 'machado2009',
    label: 'Machado, Oliveira & Fernandes (2009)',
    fidelity: 'published',
    reference:
      'Machado, Oliveira & Fernandes (2009), "A Physiologically-based Model for Simulation of Color Vision Deficiency", IEEE TVCG 15(6).',
  },
  'brettel1997-interpolated': {
    id: 'brettel1997-interpolated',
    label: 'Brettel (1997) dichromacy, linearly interpolated',
    fidelity: 'approximation',
    reference:
      'Brettel 1997 dichromat projection blended with the unmodified color in linear RGB. Not a validated model of anomalous trichromacy.',
  },
  'luminance-approximation': {
    id: 'luminance-approximation',
    label: 'Luminance-only approximation',
    fidelity: 'approximation',
    reference:
      'Relative luminance (Rec. 709 weights, linear RGB). Approximates loss of chromatic discrimination; not a model of rod monochromacy.',
  },
};

/**
 * Result of simulating a foreground/background pair under one vision
 * profile. Keeps color distinguishability separate from WCAG contrast
 * (which is computed elsewhere and never replaced by these values).
 */
export interface VisionAnalysis {
  readonly profile: VisionProfile;
  /** Model parameter in [0, 1]; not a medical severity grade. */
  readonly severity: number;
  readonly model: VisionModel;

  readonly originalForeground: ColorValue;
  readonly originalBackground: ColorValue;
  readonly simulatedForeground: ColorValue;
  readonly simulatedBackground: ColorValue;

  /** OKLab Euclidean distance between the original colors. */
  readonly originalDistance: number;
  /** OKLab Euclidean distance between the simulated colors. */
  readonly simulatedDistance: number;
  /** `originalDistance - simulatedDistance`; positive when the pair gets harder to tell apart. */
  readonly distanceLoss: number;
}
