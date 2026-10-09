/**
 * The loopback-only endpoint policy (docs/AI_PRIVACY.md, "Network"; docs/SECURITY.md). A configured
 * endpoint is hostile input: it is matched, as typed, against one strict pattern, and only the
 * two spellings of the machine's own loopback pass. The IPv6 loopback `[::1]` is NOT accepted: neither Chrome nor
 * Firefox can express it in an extension's CSP `connect-src` (verified in both, M13), so an address the extension page
 * is then forbidden to reach must not be offered either (docs/AI_PRIVACY.md, "Network"). Anything the URL parser would *normalize*
 * into one of them (`2130706433`, `0x7f.1`, `127.1`, `[0:0:0:0:0:0:0:1]`) is rejected because the
 * text is not one of the two spellings.
 */

export const ENDPOINT_FAILURES = ['empty', 'not-loopback', 'bad-port'] as const;
export type EndpointFailure = (typeof ENDPOINT_FAILURES)[number];

export type ParsedEndpoint =
  | {
      readonly ok: true;
      /** `http://127.0.0.1:11434`: scheme, host, port. No path, no credentials, no query. */
      readonly origin: string;
      readonly host: '127.0.0.1' | 'localhost';
      readonly port: number;
    }
  | { readonly ok: false; readonly failure: EndpointFailure };

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})\/?$/;

/** Unprivileged ports only: `80` and `443` are other people's servers on a developer machine. */
export const MIN_ENDPOINT_PORT = 1024;
export const MAX_ENDPOINT_PORT = 65535;

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';

export function parseLoopbackEndpoint(input: unknown): ParsedEndpoint {
  if (typeof input !== 'string' || input === '') return { ok: false, failure: 'empty' };
  const match = LOOPBACK.exec(input);
  if (!match) return { ok: false, failure: 'not-loopback' };
  const host = match[1] as '127.0.0.1' | 'localhost';
  const text = match[2] ?? '';
  const port = Number(text);
  if (
    !Number.isInteger(port) ||
    port < MIN_ENDPOINT_PORT ||
    port > MAX_ENDPOINT_PORT ||
    String(port) !== text
  ) {
    return { ok: false, failure: 'bad-port' };
  }
  // The parser must agree with the pattern: same host, same port, nothing else.
  try {
    const url = new URL(input);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== host ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.pathname !== '/'
    ) {
      return { ok: false, failure: 'not-loopback' };
    }
  } catch {
    return { ok: false, failure: 'not-loopback' };
  }
  return { ok: true, origin: `http://${host}:${port}`, host, port };
}

/** Whether a URL (a final response address) is on the configured endpoint's origin. */
export function isSameLoopbackOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}
