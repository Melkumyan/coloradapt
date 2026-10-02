import { browser } from 'wxt/browser';
import { createMessage } from './messages';
import type { ColorAdaptMessage, MessageMap, MessageType } from './messages';

/** Sends a typed message to the background service worker (Popup/Options → Background). */
export async function sendToBackground<T extends MessageType>(
  type: T,
  payload: MessageMap[T]['request'],
): Promise<MessageMap[T]['response']> {
  return browser.runtime.sendMessage<ColorAdaptMessage<T>, MessageMap[T]['response']>(
    createMessage(type, payload),
  );
}

/** Sends a typed message to the content script of a specific tab (Background/Popup → Content Script). */
export async function sendToTab<T extends MessageType>(
  tabId: number,
  type: T,
  payload: MessageMap[T]['request'],
): Promise<MessageMap[T]['response']> {
  return browser.tabs.sendMessage<ColorAdaptMessage<T>, MessageMap[T]['response']>(
    tabId,
    createMessage(type, payload),
  );
}

export async function getActiveTabId(): Promise<number | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}
