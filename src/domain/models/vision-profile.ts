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
    description: 'User-defined simulation parameters.',
    defaultSeverity: 1,
  },
};
