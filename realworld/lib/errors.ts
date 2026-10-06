/**
 * One error model for both browsers: `{ name, message, stack? }`. Chrome and Firefox disagree on the raw
 * shape of what a script throws: Chrome's `stack` starts with `Name: message`, Firefox's is only frames, a page
 * can throw a string or a plain object, and a rejected extension promise carries `message` without being an
 * `Error`. Comparing or logging raw exception strings across browsers therefore says nothing; this does.
 *
 * `normalizeError` is self-contained (no closure, no imports, no regular expressions) so the same source runs
 * inside a page via {@link normalizeErrorSource}, and in Node.
 */
export interface NormalizedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

export function normalizeError(value: unknown): NormalizedError {
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  let name = 'Error';
  let message = '';
  let stack = '';
  if (value !== null && typeof value === 'object') {
    const o = value as { name?: unknown; message?: unknown; stack?: unknown };
    name = text(o.name) || 'Error';
    message = text(o.message);
    stack = text(o.stack);
    if (message === '') {
      try {
        message = JSON.stringify(value) ?? '';
      } catch {
        message = Object.prototype.toString.call(value);
      }
      if (message === '{}') message = Object.prototype.toString.call(value);
    }
  } else {
    // a primitive (string, number, boolean, bigint, symbol), null or undefined
    message = typeof value === 'symbol' ? value.toString() : `${value as string}`;
  }
  const first = message.split('\n')[0] ?? '';
  const out: { name: string; message: string; stack?: string } = {
    name,
    message: first.slice(0, 300),
  };
  if (stack !== '') {
    // a stack never carries the message in Firefox: keep only frame lines, never rely on it for the text
    out.stack = stack.split('\n').slice(0, 8).join('\n').slice(0, 800);
  }
  return out;
}

/** The function as source, to embed in a script that runs in a page or an extension page. */
export const normalizeErrorSource: string = normalizeError.toString();

/** `Error` rebuilt from the normalized shape, for code that wants to `throw` it. */
export function toError(normalized: NormalizedError): Error {
  const error = new Error(normalized.message);
  error.name = normalized.name;
  if (normalized.stack)
    error.stack = `${normalized.name}: ${normalized.message}\n${normalized.stack}`;
  return error;
}
