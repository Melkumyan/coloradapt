import type { VisionProfile } from './vision-profile';

export interface SiteProfile {
  readonly hostname: string;
  readonly enabled: boolean;
  readonly visionProfile: VisionProfile;
  /** 0-1, how strongly adaptations are applied. */
  readonly intensity: number;
  readonly adaptUI: boolean;
  readonly adaptCharts: boolean;
  readonly adaptImages: boolean;
}

export function createDefaultSiteProfile(hostname: string): SiteProfile {
  return {
    hostname,
    enabled: true,
    visionProfile: 'normal',
    intensity: 0.7,
    adaptUI: true,
    adaptCharts: false,
    adaptImages: false,
  };
}
