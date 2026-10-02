import { browser } from 'wxt/browser';
import { isColorAdaptMessage } from './messages';
import type { ColorAdaptMessage, MessageMap, MessageType } from './messages';

type MessageSender = Parameters<Parameters<typeof browser.runtime.onMessage.addListener>[0]>[1];

/**
 * A context (background, or content script) only ever needs to handle the
 * subset of message types actually routed to it — see docs/ARCHITECTURE.md
 * for which messages flow where.
 */
export type MessageHandlers = {
  [T in MessageType]?: (
    payload: MessageMap[T]['request'],
    sender: MessageSender,
  ) => Promise<MessageMap[T]['response']>;
};

// A generic key parameter (rather than the widened `MessageType` union) is what
// lets TypeScript keep `payload`/`handler` correlated to the same message type
// here — indexing `handlers` with a plain `MessageType` union would not.
function dispatch<T extends MessageType>(
  handlers: MessageHandlers,
  message: ColorAdaptMessage<T>,
  sender: MessageSender,
): Promise<MessageMap[T]['response']> | undefined {
  const handler = handlers[message.type];
  return handler?.(message.payload, sender);
}

/**
 * Registers one `browser.runtime.onMessage` listener that dispatches to a
 * fully-typed handler map, so message handling code never has to deal with
 * untyped `any` payloads or a growing `if (message.type === ...)` chain.
 * Messages with no registered handler are ignored, so background and
 * content scripts can share this router despite handling disjoint message
 * types.
 */
export function registerMessageRouter(handlers: MessageHandlers): void {
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isColorAdaptMessage(message)) return undefined;

    const result = dispatch(handlers, message, sender);
    if (!result) return undefined;

    result.then(sendResponse).catch((error: unknown) => {
      console.error(`[ColorAdapt] handler for ${message.type} failed`, error);
    });

    return true;
  });
}
