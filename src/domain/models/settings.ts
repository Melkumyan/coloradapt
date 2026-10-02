import type { SiteProfile } from './site-profile';
import type { VisionProfile } from './vision-profile';

export interface UserSettings {
  readonly enabled: boolean;
  readonly visionProfile: VisionProfile;
  /** 0-1, how strongly adaptations are applied. */
  readonly adaptationStrength: number;
  readonly improveUIColors: boolean;
  readonly improveLinks: boolean;
  readonly improveStatusIndicators: boolean;
  /** Planned for M5 — kept in settings now so UI/storage shape is stable. */
  readonly adaptSVG: boolean;
  /** Planned for M7. */
  readonly adaptCharts: boolean;
  /** Planned for M8. */
  readonly adaptImages: boolean;
  readonly showWarnings: boolean;
  readonly siteOverrides: Readonly<Record<string, SiteProfile>>;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  enabled: true,
  visionProfile: 'normal',
  adaptationStrength: 0.7,
  improveUIColors: true,
  improveLinks: true,
  improveStatusIndicators: true,
  adaptSVG: false,
  adaptCharts: false,
  adaptImages: false,
  showWarnings: true,
  siteOverrides: {},
};
