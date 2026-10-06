import type { SiteProfile } from './site-profile';
import type { VisionProfile } from './vision-profile';

/** Local providers a user can select for the AI-assisted review (M11). There is no remote one. */
export type SemanticAIProviderSetting = 'local-ollama' | 'local-http';

/** Where the local model runtime listens by default (Ollama). Only loopback addresses are ever accepted. */
export const DEFAULT_SEMANTIC_AI_ENDPOINT = 'http://127.0.0.1:11434';

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
  /**
   * Recolor functional raster images (M8, docs/IMAGE_ADAPTATION.md): only small single-color bitmap icons that
   * are classified with high confidence and readable by the browser's own rules. Photographs, logos,
   * screenshots and charts are never changed. Off by default: image changes carry more risk than SVG or
   * chart cues, and the layer reads image pixels (locally) only when this is on.
   */
  readonly adaptImages: boolean;
  /**
   * AI-assisted review of manual-review findings in the developer audit (M11, docs/AI_SEMANTIC_ENGINE.md).
   * Off by default and never switched on by an upgrade. Global only: a site cannot turn it on, and
   * a site's settings cannot touch these. Local inference only; the page is never sent anywhere else.
   */
  readonly semanticAIEnabled: boolean;
  readonly semanticAIProvider: SemanticAIProviderSetting;
  /** A loopback address (`http://127.0.0.1:<port>`); anything else is replaced by the default when read. */
  readonly semanticAIEndpoint: string;
  /** The model the local runtime should use (required by Ollama). */
  readonly semanticAIModel: string;
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
  semanticAIEnabled: false,
  semanticAIProvider: 'local-ollama',
  semanticAIEndpoint: DEFAULT_SEMANTIC_AI_ENDPOINT,
  semanticAIModel: '',
  showWarnings: true,
  siteOverrides: {},
};
