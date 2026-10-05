import { toHex } from '@core/color';
import {
  VISION_MODEL_INFO,
  VISION_PROFILE_CONFIDENCE,
  type ColorValue,
  type VisionModel,
  type VisionProfile,
} from '@domain/models';
import type { AuditEvidence, AuditSimulation, AuditValue, EvidenceBasis } from './types';

/** Builders for evidence items: the only way a finding gets a number or a color into a report. */

export function hexOf(color: ColorValue): string {
  return toHex({ ...color, alpha: 1 }).toLowerCase();
}

function item(key: string, basis: EvidenceBasis, label: string, value: AuditValue): AuditEvidence {
  return { key, basis, label, value };
}

export const evidence = {
  colors: (
    key: string,
    basis: EvidenceBasis,
    label: string,
    foreground: ColorValue,
    background: ColorValue,
  ) =>
    item(key, basis, label, {
      kind: 'colors',
      foreground: hexOf(foreground),
      background: hexOf(background),
    }),
  color: (key: string, basis: EvidenceBasis, label: string, color: ColorValue) =>
    item(key, basis, label, { kind: 'color', hex: hexOf(color) }),
  number: (key: string, basis: EvidenceBasis, label: string, value: number, unit?: string) =>
    item(key, basis, label, {
      kind: 'number',
      value: Math.round(value * 1000) / 1000,
      ...(unit ? { unit } : {}),
    }),
  text: (key: string, basis: EvidenceBasis, label: string, text: string) =>
    item(key, basis, label, { kind: 'text', text }),
  list: (key: string, basis: EvidenceBasis, label: string, items: readonly string[]) =>
    item(key, basis, label, { kind: 'list', items }),
};

/** What the simulation of `profile` with `model` is worth. M2's confidence is passed through, never upgraded. */
export function simulationInfo(profile: VisionProfile, model: VisionModel): AuditSimulation {
  return {
    profile,
    model,
    fidelity: VISION_MODEL_INFO[model].fidelity,
    modelConfidence: VISION_PROFILE_CONFIDENCE[profile],
  };
}
