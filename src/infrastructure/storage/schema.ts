import { DEFAULT_USER_SETTINGS, VISION_PROFILES } from '@domain/models';
import type { SiteProfile, UserSettings, VisionProfile } from '@domain/models';
import { clamp01 } from '@shared/utils';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isVisionProfile(value: unknown): value is VisionProfile {
  return typeof value === 'string' && (VISION_PROFILES as readonly string[]).includes(value);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readUnitInterval(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : fallback;
}

export function parseSiteProfile(raw: unknown, hostname: string): SiteProfile | null {
  if (!isRecord(raw)) return null;

  return {
    hostname,
    enabled: readBoolean(raw.enabled, true),
    visionProfile: isVisionProfile(raw.visionProfile) ? raw.visionProfile : 'normal',
    intensity: readUnitInterval(raw.intensity, 0.7),
    adaptUI: readBoolean(raw.adaptUI, true),
    adaptCharts: readBoolean(raw.adaptCharts, false),
    adaptImages: readBoolean(raw.adaptImages, false),
  };
}

/**
 * Validates and normalizes a value read back from storage into a well-formed
 * {@link UserSettings}, falling back to defaults field-by-field rather than
 * rejecting the whole object — storage content may come from an older
 * extension version with a slightly different shape.
 */
export function parseUserSettings(raw: unknown): UserSettings {
  if (!isRecord(raw)) return DEFAULT_USER_SETTINGS;

  const siteOverrides: Record<string, SiteProfile> = {};
  if (isRecord(raw.siteOverrides)) {
    for (const [hostname, value] of Object.entries(raw.siteOverrides)) {
      const parsed = parseSiteProfile(value, hostname);
      if (parsed) siteOverrides[hostname] = parsed;
    }
  }

  return {
    enabled: readBoolean(raw.enabled, DEFAULT_USER_SETTINGS.enabled),
    visionProfile: isVisionProfile(raw.visionProfile)
      ? raw.visionProfile
      : DEFAULT_USER_SETTINGS.visionProfile,
    adaptationStrength: readUnitInterval(
      raw.adaptationStrength,
      DEFAULT_USER_SETTINGS.adaptationStrength,
    ),
    improveUIColors: readBoolean(raw.improveUIColors, DEFAULT_USER_SETTINGS.improveUIColors),
    improveLinks: readBoolean(raw.improveLinks, DEFAULT_USER_SETTINGS.improveLinks),
    improveStatusIndicators: readBoolean(
      raw.improveStatusIndicators,
      DEFAULT_USER_SETTINGS.improveStatusIndicators,
    ),
    adaptSVG: readBoolean(raw.adaptSVG, DEFAULT_USER_SETTINGS.adaptSVG),
    adaptCharts: readBoolean(raw.adaptCharts, DEFAULT_USER_SETTINGS.adaptCharts),
    adaptImages: readBoolean(raw.adaptImages, DEFAULT_USER_SETTINGS.adaptImages),
    showWarnings: readBoolean(raw.showWarnings, DEFAULT_USER_SETTINGS.showWarnings),
    siteOverrides,
  };
}
