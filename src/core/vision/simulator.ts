import type { ColorValue, VisionModel, VisionProfile } from '@domain/models';
import { VISION_PROFILE_INFO } from '@domain/models';
import { linearToSrgb, srgbToLinear } from '@core/color';
import { brettel1997, brettel1997Interpolated } from './brettel1997';
import { luminanceApproximation } from './luminance-approximation';
import { machado2009 } from './machado2009';
import type { LinearVisionModel, VisionFamily } from './types';
import { vienot1999 } from './vienot1999';

/**
 * Vision simulation engine: sRGB -> linear RGB -> model -> clip -> sRGB.
 * Pure TypeScript; no DOM, WebExtension or UI dependencies.
 *
 * Severity is a model parameter in [0, 1] (0 = normal vision, 1 = full
 * deficiency where the model permits). It is NOT a medical grade.
 */

export interface VisionSimulator {
  /**
   * Simulates `color` for `profile`. `severity` defaults to the profile's
   * default (1 for dichromacies and achromatopsia, 0.5 for anomalies).
   * Throws `RangeError` for a non-finite channel or a severity outside [0, 1].
   * Alpha is preserved; the result carries no `source`.
   */
  simulate(color: ColorValue, profile: VisionProfile, severity?: number): ColorValue;
  /** The model this simulator uses for `profile`. */
  modelFor(profile: VisionProfile): VisionModel;
}

export type VisionModelPolicy = Readonly<
  Record<Exclude<VisionProfile, 'normal' | 'custom'>, VisionModel>
>;

/**
 * Default model per profile (rationale in docs/COLOR_VISION_SIMULATION.md):
 *  - dichromacies: Brettel 1997 (the only reference model covering tritan);
 *  - protanomaly/deuteranomaly: Machado 2009;
 *  - tritanomaly: interpolated Brettel 1997 (documented approximation);
 *  - achromatopsia: luminance approximation.
 */
export const DEFAULT_VISION_MODEL_POLICY: VisionModelPolicy = {
  protanopia: 'brettel1997',
  deuteranopia: 'brettel1997',
  tritanopia: 'brettel1997',
  protanomaly: 'machado2009',
  deuteranomaly: 'machado2009',
  tritanomaly: 'brettel1997-interpolated',
  achromatopsia: 'luminance-approximation',
};

const REGISTRY: Readonly<Partial<Record<VisionModel, LinearVisionModel>>> = {
  brettel1997,
  'brettel1997-interpolated': brettel1997Interpolated,
  vienot1999,
  machado2009,
  'luminance-approximation': luminanceApproximation,
};

const PROFILE_FAMILY: Readonly<Record<Exclude<VisionProfile, 'normal' | 'custom'>, VisionFamily>> =
  {
    protanopia: 'protan',
    protanomaly: 'protan',
    deuteranopia: 'deutan',
    deuteranomaly: 'deutan',
    tritanopia: 'tritan',
    tritanomaly: 'tritan',
    achromatopsia: 'mono',
  };

function isSimulatedProfile(
  profile: VisionProfile,
): profile is Exclude<VisionProfile, 'normal' | 'custom'> {
  return profile !== 'normal' && profile !== 'custom';
}

export function assertValidSeverity(severity: number): void {
  if (!Number.isFinite(severity) || severity < 0 || severity > 1) {
    throw new RangeError(`Vision severity must be a number in [0, 1], got ${String(severity)}`);
  }
}

function normalizedChannel(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError(`Color channel must be finite, got ${value}`);
  return Math.min(1, Math.max(0, value));
}

export function createVisionSimulator(overrides: Partial<VisionModelPolicy> = {}): VisionSimulator {
  const policy: VisionModelPolicy = { ...DEFAULT_VISION_MODEL_POLICY, ...overrides };

  const models = new Map<VisionProfile, LinearVisionModel>();
  for (const profile of Object.keys(PROFILE_FAMILY) as (keyof VisionModelPolicy)[]) {
    const model = REGISTRY[policy[profile]];
    if (!model) throw new RangeError(`Unknown vision model "${policy[profile]}"`);
    if (!model.supports(PROFILE_FAMILY[profile])) {
      throw new RangeError(`Model "${model.id}" does not support profile "${profile}"`);
    }
    models.set(profile, model);
  }

  return {
    modelFor(profile) {
      return isSimulatedProfile(profile) ? policy[profile] : 'identity';
    },

    simulate(color, profile, severity) {
      const amount = severity ?? VISION_PROFILE_INFO[profile].defaultSeverity;
      assertValidSeverity(amount);
      const r = normalizedChannel(color.r);
      const g = normalizedChannel(color.g);
      const b = normalizedChannel(color.b);

      if (!isSimulatedProfile(profile) || amount === 0) {
        return { r, g, b, alpha: color.alpha };
      }

      const out = models
        .get(profile)!
        .transform(
          [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)],
          PROFILE_FAMILY[profile],
          amount,
        );

      // Gamut policy: per-channel clipping in linear light (inside linearToSrgb).
      return {
        r: linearToSrgb(out[0]),
        g: linearToSrgb(out[1]),
        b: linearToSrgb(out[2]),
        alpha: color.alpha,
      };
    },
  };
}

/** The production simulator, using {@link DEFAULT_VISION_MODEL_POLICY}. */
export const defaultVisionSimulator: VisionSimulator = createVisionSimulator();

export function simulateVision(
  color: ColorValue,
  profile: VisionProfile,
  severity?: number,
): ColorValue {
  return defaultVisionSimulator.simulate(color, profile, severity);
}
