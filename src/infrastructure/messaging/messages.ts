import type { AdaptationResult, AnalysisResult, UserSettings } from '@domain/models';

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
  ENABLE_ADAPTATION: { request: undefined; response: AdaptationResult };
  DISABLE_ADAPTATION: { request: undefined; response: null };
  REFRESH_ADAPTATION: { request: undefined; response: AdaptationResult };
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
