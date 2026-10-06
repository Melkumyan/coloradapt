import { payloadMessage, type ProviderRequest } from './prompt';
import { isSameLoopbackOrigin, parseLoopbackEndpoint, type ParsedEndpoint } from './endpoint';
import type {
  ProviderFailure,
  ProviderHealth,
  ProviderIdentity,
  ProviderResult,
  SemanticProvider,
} from './provider';
import { SEMANTIC_SCHEMA_VERSION, type SelectableProviderId } from './taxonomy';
import { safeName } from '@core/audit';

/**
 * The local provider: one HTTP exchange with a model runtime on this machine's loopback
 * (docs/AI_PROVIDER_PROTOCOL.md). Two protocols, one transport:
 *
 * - `local-ollama`: Ollama's `/api/chat` (non-streaming, JSON mode, temperature 0);
 * - `local-http`: ColorAdapt's own minimal `POST /v1/semantic`, for any runtime a small shim can front.
 *
 * The transport is where the privacy promise is enforced: the endpoint must pass
 * {@link parseLoopbackEndpoint}; the request never carries cookies, a referrer or a cache entry; a
 * redirect is an error, not something to follow; the response must come from the same origin; and
 * its size is bounded while it is read.
 */

export type FetchLike = (
  input: string,
  init: {
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    redirect: 'error';
    credentials: 'omit';
    cache: 'no-store';
    referrerPolicy: 'no-referrer';
    signal: AbortSignal;
  },
) => Promise<Response>;

export interface LocalProviderOptions {
  readonly protocol: SelectableProviderId;
  /** As typed by the user; validated here, never trusted. */
  readonly endpoint: string;
  /** Required by `local-ollama`; optional for `local-http`. */
  readonly model: string | null;
  readonly fetch?: FetchLike;
}

/** What a response may weigh: the answer is ~1 KB; a runtime's own envelope is a few KB more. */
const MAX_RESPONSE_BYTES = 65_536;
/** One health check is short. */
const HEALTH_TIMEOUT_MS = 3000;

const PATHS = {
  'local-ollama': { infer: '/api/chat', health: '/api/tags' },
  'local-http': { infer: '/v1/semantic', health: '/v1/health' },
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class LocalSemanticProvider implements SemanticProvider {
  readonly id: SelectableProviderId;
  readonly #endpoint: ParsedEndpoint;
  readonly #model: string | null;
  readonly #fetch: FetchLike;

  constructor(options: LocalProviderOptions) {
    this.id = options.protocol;
    this.#endpoint = parseLoopbackEndpoint(options.endpoint);
    this.#model =
      options.model !== null && options.model.trim() !== '' ? safeName(options.model) : null;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  identity(): ProviderIdentity {
    return { provider: this.id, model: this.#model };
  }

  /** Whether the endpoint passed the loopback policy. */
  get endpointAllowed(): boolean {
    return this.#endpoint.ok;
  }

  async #exchange(
    path: string,
    method: 'GET' | 'POST',
    body: string | undefined,
    signal: AbortSignal,
  ): Promise<{ ok: true; text: string } | { ok: false; failure: ProviderFailure }> {
    if (!this.#endpoint.ok) return { ok: false, failure: 'blocked-endpoint' };
    const origin = this.#endpoint.origin;
    let response: Response;
    try {
      response = await this.#fetch(`${origin}${path}`, {
        method,
        headers:
          body === undefined
            ? { accept: 'application/json' }
            : { 'content-type': 'application/json', accept: 'application/json' },
        ...(body === undefined ? {} : { body }),
        // A redirect to anywhere is an error: nothing can steer this request off the loopback.
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal,
      });
    } catch {
      return { ok: false, failure: signal.aborted ? 'aborted' : 'unavailable' };
    }
    // Defense in depth for a fetch that did follow: the answer must still come from the same origin.
    if (response.redirected || (response.url !== '' && !isSameLoopbackOrigin(response.url, origin)))
      return { ok: false, failure: 'blocked-endpoint' };
    if (!response.ok) return { ok: false, failure: 'http-error' };
    const length = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES)
      return { ok: false, failure: 'too-large' };
    try {
      return await readBounded(response, signal);
    } catch {
      return { ok: false, failure: signal.aborted ? 'aborted' : 'bad-response' };
    }
  }

  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    if (!this.#endpoint.ok) return 'ERROR';
    const own = new AbortController();
    const timer = setTimeout(() => own.abort(), HEALTH_TIMEOUT_MS);
    const forward = (): void => own.abort();
    signal?.addEventListener('abort', forward, { once: true });
    try {
      const result = await this.#exchange(PATHS[this.id].health, 'GET', undefined, own.signal);
      if (result.ok) return 'AVAILABLE';
      return result.failure === 'blocked-endpoint' ? 'ERROR' : 'UNAVAILABLE';
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    }
  }

  async infer(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResult> {
    if (this.id === 'local-ollama' && this.#model === null)
      return { ok: false, failure: 'not-configured' };
    const path = PATHS[this.id].infer;
    const body =
      this.id === 'local-ollama'
        ? JSON.stringify({
            model: this.#model,
            stream: false,
            format: 'json',
            options: { temperature: request.temperature, num_predict: 320 },
            messages: [
              { role: 'system', content: request.instructions },
              { role: 'user', content: payloadMessage(request.payload) },
            ],
          })
        : JSON.stringify({
            schemaVersion: SEMANTIC_SCHEMA_VERSION,
            task: request.task,
            instructions: request.instructions,
            payload: request.payload,
            temperature: request.temperature,
            maxOutputChars: request.maxOutputChars,
            ...(this.#model ? { model: this.#model } : {}),
          });
    const exchange = await this.#exchange(path, 'POST', body, signal);
    if (!exchange.ok) return exchange;
    let envelope: unknown;
    try {
      envelope = JSON.parse(exchange.text);
    } catch {
      return { ok: false, failure: 'bad-response' };
    }
    if (!isRecord(envelope)) return { ok: false, failure: 'bad-response' };
    const reported = typeof envelope.model === 'string' ? safeName(envelope.model) : null;
    const model = reported ?? this.#model;
    if (this.id === 'local-ollama') {
      const message = envelope.message;
      if (!isRecord(message) || typeof message.content !== 'string')
        return { ok: false, failure: 'bad-response' };
      return { ok: true, raw: message.content, model };
    }
    if (!('hypothesis' in envelope)) return { ok: false, failure: 'bad-response' };
    return { ok: true, raw: envelope.hypothesis, model };
  }
}

/** Reads at most {@link MAX_RESPONSE_BYTES} of the body, whatever the headers claimed. */
async function readBounded(
  response: Response,
  signal: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; failure: ProviderFailure }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return text.length > MAX_RESPONSE_BYTES
      ? { ok: false, failure: 'too-large' }
      : { ok: true, text };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, failure: 'aborted' };
    }
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, failure: 'too-large' };
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}
