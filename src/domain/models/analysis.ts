import type { ColorConflict } from './conflict';
import type { ElementDescriptor } from './element';

export interface AnalysisResult {
  readonly url: string;
  readonly timestamp: number;
  readonly elements: readonly ElementDescriptor[];
  readonly conflicts: readonly ColorConflict[];
  /** True when the analyzer stopped early because it hit a performance budget. */
  readonly truncated: boolean;
  /** Count of analyzed elements with `analysisStatus !== 'resolved'` — excluded
   * from conflict detection because their background could not be confidently
   * determined (gradient/image background, or a resolution depth limit). */
  readonly unresolvedCount: number;
}
