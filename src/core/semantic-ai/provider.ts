import type { ProviderRequest } from './prompt';
import type { SemanticProviderId } from './taxonomy';

/**
 * The provider seam (docs/AI_PROVIDER_PROTOCOL.md). A provider turns one {@link ProviderRequest}
 * into raw model output; it knows nothing about findings, validation or the page. The core sees
 * only {@link ProviderResult}, so no provider's response style leaks into product logic.
 *
 * There is no remote provider in the product, and `SemanticProviderId` has no value for one.
 */

export const PROVIDER_HEALTH = ['DISABLED', 'AVAILABLE', 'UNAVAILABLE', 'ERROR'] as const;
export type ProviderHealth = (typeof PROVIDER_HEALTH)[number];

export interface ProviderIdentity {
  readonly provider: SemanticProviderId;
  /** The model name the runtime reported (or the user configured), sanitized. Not evidence of anything. */
  readonly model: string | null;
}

export const PROVIDER_FAILURES = [
  'unavailable',
  'timeout',
  'aborted',
  'bad-response',
  'http-error',
  'blocked-endpoint',
  'too-large',
  'not-configured',
] as const;
export type ProviderFailure = (typeof PROVIDER_FAILURES)[number];

export type ProviderResult =
  | { readonly ok: true; readonly raw: unknown; readonly model: string | null }
  | { readonly ok: false; readonly failure: ProviderFailure };

export interface SemanticProvider {
  readonly id: SemanticProviderId;
  identity(): ProviderIdentity;
  /** One quick check, on a user action. Never polled. */
  health(signal?: AbortSignal): Promise<ProviderHealth>;
  /** One inference. Must stop when `signal` aborts. Never throws. */
  infer(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResult>;
}

/** The provider of every default configuration: it does nothing and reaches nothing. */
export class DisabledProvider implements SemanticProvider {
  readonly id = 'disabled' as const;

  identity(): ProviderIdentity {
    return { provider: 'disabled', model: null };
  }

  health(): Promise<ProviderHealth> {
    return Promise.resolve('DISABLED');
  }

  infer(): Promise<ProviderResult> {
    return Promise.resolve({ ok: false, failure: 'unavailable' });
  }
}

export interface MockProviderOptions {
  /** Produces the raw answer for a request. Replay fixtures and adversarial tests plug in here. */
  readonly respond: (request: ProviderRequest) => unknown;
  readonly model?: string;
  /** Resolves late (tests of timeouts and cancellation); the answer is dropped if `signal` aborts first. */
  readonly delay?: (signal: AbortSignal) => Promise<void>;
  readonly health?: ProviderHealth;
}

/**
 * A scripted provider for tests and replay. It is not an AI and never claims to be: its identity
 * is `mock`, and nothing selectable in settings can make the product use one.
 */
export class MockSemanticProvider implements SemanticProvider {
  readonly id = 'mock' as const;
  readonly #options: MockProviderOptions;
  calls = 0;
  readonly requests: ProviderRequest[] = [];

  constructor(options: MockProviderOptions) {
    this.#options = options;
  }

  identity(): ProviderIdentity {
    return { provider: 'mock', model: this.#options.model ?? 'mock-replay' };
  }

  health(): Promise<ProviderHealth> {
    return Promise.resolve(this.#options.health ?? 'AVAILABLE');
  }

  async infer(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResult> {
    this.calls += 1;
    this.requests.push(request);
    if (signal.aborted) return { ok: false, failure: 'aborted' };
    try {
      if (this.#options.delay) await this.#options.delay(signal);
      if (signal.aborted) return { ok: false, failure: 'aborted' };
      const raw = await this.#options.respond(request);
      if (signal.aborted) return { ok: false, failure: 'aborted' };
      return { ok: true, raw, model: this.identity().model };
    } catch {
      return { ok: false, failure: signal.aborted ? 'aborted' : 'bad-response' };
    }
  }
}
