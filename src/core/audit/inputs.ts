import type { ChartAnalysis, CanvasVerdict } from '@core/charts';
import type { CueDecision, ColorOnlyVerdict, SemanticResult } from '@core/semantics';
import type {
  AnalysisStatus,
  ColorValue,
  ImageConfidence,
  ImageKind,
  ImageReadability,
  SvgUnitInfo,
  VisionProfile,
} from '@domain/models';
import type { AuditAdaptationStatus, AuditTargetInput } from './types';

/**
 * What the browser layer hands the evaluators: plain data read from one subsystem's output for one
 * element. Nothing here is a node, a style object or a clock. The evaluators never ask the DOM
 * anything, which is what keeps the audit core testable without a page.
 */

/** What ColorAdapt did on the page for the *active* profile (other profiles: `not-applicable`). */
export interface AdaptationInfo {
  readonly status: AuditAdaptationStatus;
  /** An M3-validated replacement color (`#rrggbb`), when one was found. */
  readonly suggestionHex?: string;
}

export interface AuditScope {
  /** The profiles to evaluate simulation-based rules under. */
  readonly profiles: readonly VisionProfile[];
  /** The profile the user has selected; adaptation statuses refer to it. */
  readonly activeProfile: VisionProfile;
}

export interface TextAuditInput {
  readonly target: AuditTargetInput;
  readonly foreground: ColorValue;
  readonly background: ColorValue;
  readonly analysisStatus: AnalysisStatus;
  readonly interactive: boolean;
  /** WCAG "large text" (>= 24px, or >= 18.66px and bold): the contrast target is lower. */
  readonly largeText: boolean;
  readonly adaptation: AdaptationInfo;
}

export interface SvgAuditInput {
  readonly target: AuditTargetInput;
  readonly svg: SvgUnitInfo;
  readonly foreground: ColorValue;
  readonly background: ColorValue;
  readonly analysisStatus: AnalysisStatus;
  readonly interactive: boolean;
  readonly adaptation: AdaptationInfo;
}

export interface SemanticAuditInput {
  readonly target: AuditTargetInput;
  readonly result: SemanticResult;
  readonly decision: CueDecision;
  /** Present when the color-only check ran. */
  readonly verdict: ColorOnlyVerdict | null;
  readonly interactive: boolean;
  /** An element that is a form field (or a control the user fills in). */
  readonly field: boolean;
  readonly adaptation: AdaptationInfo;
}

export interface ChartAuditInput {
  readonly target: AuditTargetInput;
  readonly analysis: ChartAnalysis;
  /** What the chart layer did, for the active profile. */
  readonly adaptation: AdaptationInfo;
}

export interface CanvasAuditInput {
  readonly target: AuditTargetInput;
  readonly verdict: CanvasVerdict;
}

export interface ImageAuditInput {
  readonly target: AuditTargetInput;
  readonly kind: ImageKind;
  readonly confidence: ImageConfidence;
  /** What the image layer decided, when it ran (pixel reading is opt-in); `null` otherwise. */
  readonly layer: {
    readonly action: string;
    readonly reason: string;
    readonly readability: ImageReadability;
  } | null;
  readonly interactive: boolean;
  /** Rendered size is icon-like (a small control image). */
  readonly small: boolean;
  /** From another origin without CORS: its pixels cannot be read. */
  readonly crossOrigin: boolean;
  readonly adaptation: AdaptationInfo;
}
