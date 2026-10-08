import { parseLoopbackEndpoint } from '@core/semantic-ai/endpoint';
import { DEFAULT_USER_SETTINGS, VISION_PROFILES } from '@domain/models';
import type {
  SemanticAIProviderSetting,
  SiteProfile,
  UserSettings,
  VisionProfile,
} from '@domain/models';
import { clamp01 } from '@shared/utils';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isVisionProfile(value: unknown): value is VisionProfile {
  return typeof value === 'string' && (VISION_PROFILES as readonly string[]).includes(value);
}

/**
 * Names of the stored fields that were present but unusable (wrong type, unknown value, out of range, a
 * non-loopback endpoint) while reading one settings blob. A field that is simply absent is not recovery: an
 * older version never wrote it. Names only: a diagnostic must never carry a stored value.
 */
export type RecoveryReport = string[];

const present = (value: unknown): boolean => value !== undefined;

function readBoolean(
  value: unknown,
  fallback: boolean,
  name: string,
  report?: RecoveryReport,
): boolean {
  if (typeof value === 'boolean') return value;
  if (present(value)) report?.push(name);
  return fallback;
}

function readUnitInterval(
  value: unknown,
  fallback: number,
  name: string,
  report?: RecoveryReport,
): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 0 || value > 1) report?.push(name);
    return clamp01(value);
  }
  if (present(value)) report?.push(name);
  return fallback;
}

function readProvider(value: unknown, report?: RecoveryReport): SemanticAIProviderSetting {
  if (value === 'local-http' || value === 'local-ollama') return value;
  if (present(value)) report?.push('semanticAIProvider');
  return DEFAULT_USER_SETTINGS.semanticAIProvider;
}

/** The endpoint as stored, if it is a loopback address; otherwise the default. Never a remote host. */
function readEndpoint(value: unknown, report?: RecoveryReport): string {
  const parsed = parseLoopbackEndpoint(value);
  if (parsed.ok) return parsed.origin;
  if (present(value)) report?.push('semanticAIEndpoint');
  return DEFAULT_USER_SETTINGS.semanticAIEndpoint;
}

function readModel(value: unknown, report?: RecoveryReport): string {
  if (typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,60}$/.test(value)) return value;
  if (present(value) && value !== '') report?.push('semanticAIModel');
  return '';
}

export function parseSiteProfile(
  raw: unknown,
  hostname: string,
  report?: RecoveryReport,
): SiteProfile | null {
  if (!isRecord(raw)) {
    report?.push('siteOverrides');
    return null;
  }

  const site = `siteOverrides.`;
  const visionProfile = isVisionProfile(raw.visionProfile) ? raw.visionProfile : 'normal';
  if (present(raw.visionProfile) && !isVisionProfile(raw.visionProfile))
    report?.push(`${site}visionProfile`);
  return {
    hostname,
    enabled: readBoolean(raw.enabled, true, `${site}enabled`, report),
    visionProfile,
    intensity: readUnitInterval(raw.intensity, 0.7, `${site}intensity`, report),
    adaptUI: readBoolean(raw.adaptUI, true, `${site}adaptUI`, report),
    adaptCharts: readBoolean(raw.adaptCharts, false, `${site}adaptCharts`, report),
    adaptImages: readBoolean(raw.adaptImages, false, `${site}adaptImages`, report),
  };
}

/**
 * Validates and normalizes a value read back from storage into a well-formed
 * {@link UserSettings}, falling back to defaults field-by-field rather than
 * rejecting the whole object � storage content may come from an older
 * extension version with a slightly different shape. `report` collects the names of the fields that were
 * present but unusable (see {@link RecoveryReport}); a blob that is not an object at all reports `settings`.
 */
export function parseUserSettings(raw: unknown, report?: RecoveryReport): UserSettings {
  if (!isRecord(raw) || Array.isArray(raw)) {
    report?.push('settings');
    return DEFAULT_USER_SETTINGS;
  }

  const siteOverrides: Record<string, SiteProfile> = {};
  if (isRecord(raw.siteOverrides)) {
    for (const [hostname, value] of Object.entries(raw.siteOverrides)) {
      const parsed = parseSiteProfile(value, hostname, report);
      // A hostname is page-controlled text: `siteOverrides[hostname] = ...` with the key "__proto__" would replace the
      // prototype of the object instead of storing a profile. Define an own property, always.
      if (parsed) {
        Object.defineProperty(siteOverrides, hostname, {
          value: parsed,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
  } else if (present(raw.siteOverrides)) {
    report?.push('siteOverrides');
  }

  const d = DEFAULT_USER_SETTINGS;
  const visionProfile = isVisionProfile(raw.visionProfile) ? raw.visionProfile : d.visionProfile;
  if (present(raw.visionProfile) && !isVisionProfile(raw.visionProfile))
    report?.push('visionProfile');
  return {
    enabled: readBoolean(raw.enabled, d.enabled, 'enabled', report),
    visionProfile,
    adaptationStrength: readUnitInterval(
      raw.adaptationStrength,
      d.adaptationStrength,
      'adaptationStrength',
      report,
    ),
    improveUIColors: readBoolean(raw.improveUIColors, d.improveUIColors, 'improveUIColors', report),
    improveLinks: readBoolean(raw.improveLinks, d.improveLinks, 'improveLinks', report),
    improveStatusIndicators: readBoolean(
      raw.improveStatusIndicators,
      d.improveStatusIndicators,
      'improveStatusIndicators',
      report,
    ),
    adaptSVG: readBoolean(raw.adaptSVG, d.adaptSVG, 'adaptSVG', report),
    semanticCuesEnabled: readBoolean(
      raw.semanticCuesEnabled,
      d.semanticCuesEnabled,
      'semanticCuesEnabled',
      report,
    ),
    adaptCharts: readBoolean(raw.adaptCharts, d.adaptCharts, 'adaptCharts', report),
    adaptImages: readBoolean(raw.adaptImages, d.adaptImages, 'adaptImages', report),
    semanticAIEnabled: readBoolean(
      raw.semanticAIEnabled,
      d.semanticAIEnabled,
      'semanticAIEnabled',
      report,
    ),
    semanticAIProvider: readProvider(raw.semanticAIProvider, report),
    semanticAIEndpoint: readEndpoint(raw.semanticAIEndpoint, report),
    semanticAIModel: readModel(raw.semanticAIModel, report),
    showWarnings: readBoolean(raw.showWarnings, d.showWarnings, 'showWarnings', report),
    siteOverrides,
  };
}
