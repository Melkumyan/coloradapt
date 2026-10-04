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
  /** Adapt inline SVG icons and text (M5, docs/SVG_ANALYSIS.md). */
  readonly adaptSVG: boolean;
  /**
   * Add a second, non-color cue where color is the only carrier of a state and the evidence
   * for that state is strong (M6, docs/SEMANTIC_ACCESSIBILITY.md).
   */
  readonly semanticCuesEnabled: boolean;
  /**
   * Add non-color redundancy (line style, marker, pattern) to charts whose series color alone cannot
   * tell apart, and keep their legends in step (M7, docs/CHARTS.md).
   */
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
  adaptSVG: true,
  semanticCuesEnabled: true,
  adaptCharts: true,
  adaptImages: false,
  showWarnings: true,
  siteOverrides: {},
};
