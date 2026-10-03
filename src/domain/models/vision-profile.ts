/**
 * Supported color vision profiles.
 *
 * These describe simulation/adaptation targets, not medical diagnoses.
 * "Anomaly" variants are partial (anomalous trichromacy) forms of their
 * matching dichromacy and are simulated at reduced severity.
 */
export type VisionProfile =
  | 'normal'
  | 'protanopia'
  | 'protanomaly'
  | 'deuteranopia'
  | 'deuteranomaly'
  | 'tritanopia'
  | 'tritanomaly'
  | 'achromatopsia'
  | 'custom';

export const VISION_PROFILES: readonly VisionProfile[] = [
  'normal',
  'protanopia',
  'protanomaly',
  'deuteranopia',
  'deuteranomaly',
  'tritanopia',
  'tritanomaly',
  'achromatopsia',
  'custom',
];

export interface VisionProfileInfo {
  readonly id: VisionProfile;
  readonly label: string;
  readonly description: string;
  /** 0 = no simulated effect, 1 = full dichromatic effect. */
  readonly defaultSeverity: number;
}

export const VISION_PROFILE_INFO: Readonly<Record<VisionProfile, VisionProfileInfo>> = {
  normal: {
    id: 'normal',
    label: 'Normal vision',
    description: 'No color vision adaptation applied.',
    defaultSeverity: 0,
  },
  protanopia: {
    id: 'protanopia',
    label: 'Protanopia',
    description: 'Estimated absence of red-sensitive cone function.',
    defaultSeverity: 1,
  },
  protanomaly: {
    id: 'protanomaly',
    label: 'Protanomaly',
    description: 'Estimated reduced red-sensitive cone function.',
    defaultSeverity: 0.5,
  },
  deuteranopia: {
    id: 'deuteranopia',
    label: 'Deuteranopia',
    description: 'Estimated absence of green-sensitive cone function.',
    defaultSeverity: 1,
  },
  deuteranomaly: {
    id: 'deuteranomaly',
    label: 'Deuteranomaly',
    description: 'Estimated reduced green-sensitive cone function.',
    defaultSeverity: 0.5,
  },
  tritanopia: {
    id: 'tritanopia',
    label: 'Tritanopia',
    description: 'Estimated absence of blue-sensitive cone function.',
    defaultSeverity: 1,
  },
  tritanomaly: {
    id: 'tritanomaly',
    label: 'Tritanomaly',
    description: 'Estimated reduced blue-sensitive cone function.',
    defaultSeverity: 0.5,
  },
  achromatopsia: {
    id: 'achromatopsia',
    label: 'Achromatopsia',
    description: 'Estimated absence of functional color discrimination (monochromacy).',
    defaultSeverity: 1,
  },
  custom: {
    id: 'custom',
    label: 'Custom profile',
    description:
      'Not yet supported: no color vision simulation is applied (treated as normal vision).',
    defaultSeverity: 1,
  },
};

/**
 * How much scientific weight the simulation behind a profile carries. Carried
 * through the Adaptation Engine so a result never hides its provenance
 * (docs/COLOR_VISION_SIMULATION.md, docs/ADAPTATION_ENGINE.md).
 *
 * - `SUPPORTED_MODEL`: a published model applied as described by its authors.
 * - `MODEL_ASSUMPTION`: a published model whose input-space convention is an
 *   engineering assumption (Machado 2009, linear-RGB interpretation).
 * - `APPROXIMATION`: a documented approximation, not a validated model.
 * - `UNSUPPORTED`: no model; automatic adaptation is refused.
 */
export type ModelConfidence =
  'SUPPORTED_MODEL' | 'MODEL_ASSUMPTION' | 'APPROXIMATION' | 'UNSUPPORTED';

/** `normal` has an identity "model" and is never adapted; it is listed as supported. */
export const VISION_PROFILE_CONFIDENCE: Readonly<Record<VisionProfile, ModelConfidence>> = {
  normal: 'SUPPORTED_MODEL',
  protanopia: 'SUPPORTED_MODEL',
  deuteranopia: 'SUPPORTED_MODEL',
  tritanopia: 'SUPPORTED_MODEL',
  protanomaly: 'MODEL_ASSUMPTION',
  deuteranomaly: 'MODEL_ASSUMPTION',
  tritanomaly: 'APPROXIMATION',
  achromatopsia: 'APPROXIMATION',
  custom: 'UNSUPPORTED',
};
