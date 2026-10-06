import type {
  AuditDiagnostics,
  AuditRequest,
  AuditSnapshot,
  HighlightRequest,
  HighlightResult,
} from '@core/audit';
import type { SemanticCasesRequest, SemanticCasesResponse } from '@core/semantic-ai';
import type {
  AdaptationPlan,
  AnalysisResult,
  DynamicDiagnostics,
  UserSettings,
} from '@domain/models';

/**
 * Every message type the extension sends between Popup / Options /
 * Background / Content Script, with its request and response payload
 * types. Adding a new message means adding one entry here — nothing else
 * in the app should use ad-hoc string message names.
 */
export interface MessageMap {
  GET_SETTINGS: { request: undefined; response: UserSettings };
  UPDATE_SETTINGS: { request: Partial<UserSettings>; response: UserSettings };
  ANALYZE_PAGE: { request: undefined; response: AnalysisResult };
  GET_ANALYSIS: { request: undefined; response: AnalysisResult | null };
  ENABLE_ADAPTATION: { request: undefined; response: AdaptationPlan };
  DISABLE_ADAPTATION: { request: undefined; response: null };
  REFRESH_ADAPTATION: { request: undefined; response: AdaptationPlan };
  /** Debug/test channel: dynamic-pipeline counters. Local only, never sent anywhere. */
  GET_DYNAMIC_DIAGNOSTICS: { request: undefined; response: DynamicDiagnostics };
  /** Debug/test channel: process every pending mutation now, then report the counters. */
  FLUSH_DYNAMIC: { request: undefined; response: DynamicDiagnostics };
  /** Developer audit (M9, docs/DEVELOPER_AUDIT.md): one read-only pass over the page, as authored. Works with adaptation off. */
  AUDIT_RUN: { request: AuditRequest; response: AuditSnapshot };
  /** The current audit snapshot, or `null` before the first pass. */
  AUDIT_GET: { request: undefined; response: AuditSnapshot | null };
  /** Outline one element of one finding (no focus change, no page change). */
  AUDIT_HIGHLIGHT: { request: HighlightRequest; response: HighlightResult };
  AUDIT_CLEAR_HIGHLIGHT: { request: undefined; response: null };
  /** Ends the audit session of the page: live watching stops and the highlight goes. */
  AUDIT_CLOSE: { request: undefined; response: null };
  /** The audit page exported a report (a local counter, `auditExports`). */
  AUDIT_NOTE_EXPORT: { request: undefined; response: null };
  /** Debug/test channel: audit counters. Local only, never sent anywhere. */
  AUDIT_DIAGNOSTICS: { request: undefined; response: AuditDiagnostics };
  /**
   * AI-assisted review (M11, docs/AI_SEMANTIC_ENGINE.md): the bounded, redacted packets of the current
   * snapshot's manual-review findings. Read-only; sent only when the developer asks for the review.
   */
  AUDIT_SEMANTIC_CASES: { request: SemanticCasesRequest; response: SemanticCasesResponse };
}

export type MessageType = keyof MessageMap;

export const MESSAGE_TYPES: readonly MessageType[] = [
  'GET_SETTINGS',
  'UPDATE_SETTINGS',
  'ANALYZE_PAGE',
  'GET_ANALYSIS',
  'ENABLE_ADAPTATION',
  'DISABLE_ADAPTATION',
  'REFRESH_ADAPTATION',
  'GET_DYNAMIC_DIAGNOSTICS',
  'FLUSH_DYNAMIC',
  'AUDIT_RUN',
  'AUDIT_GET',
  'AUDIT_HIGHLIGHT',
  'AUDIT_CLEAR_HIGHLIGHT',
  'AUDIT_CLOSE',
  'AUDIT_NOTE_EXPORT',
  'AUDIT_DIAGNOSTICS',
  'AUDIT_SEMANTIC_CASES',
];

export interface ColorAdaptMessage<T extends MessageType = MessageType> {
  readonly channel: 'coloradapt';
  readonly type: T;
  readonly payload: MessageMap[T]['request'];
}

export function createMessage<T extends MessageType>(
  type: T,
  payload: MessageMap[T]['request'],
): ColorAdaptMessage<T> {
  return { channel: 'coloradapt', type, payload };
}

/**
 * Runtime guard for messages received over `browser.runtime.onMessage` /
 * `browser.tabs.onMessage`, which are typed `any` at the API boundary and
 * may come from unrelated extensions or page scripts.
 */
export function isColorAdaptMessage(value: unknown): value is ColorAdaptMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { channel?: unknown }).channel === 'coloradapt' &&
    MESSAGE_TYPES.includes((value as { type?: MessageType }).type as MessageType)
  );
}
