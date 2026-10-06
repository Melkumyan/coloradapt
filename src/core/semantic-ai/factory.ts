import { LocalSemanticProvider, type FetchLike } from './local-provider';
import { DisabledProvider, type SemanticProvider } from './provider';
import type { SelectableProviderId } from './taxonomy';

/** The part of the user's settings that picks a provider. */
export interface ProviderConfig {
  readonly enabled: boolean;
  readonly provider: SelectableProviderId;
  readonly endpoint: string;
  readonly model: string;
}

/**
 * The one place a provider is chosen. Disabled (the default) gives a provider that reaches
 * nothing; enabled gives the local one, whose transport refuses anything but loopback. There is no
 * branch that makes a remote provider, and no fallback from one provider to another.
 */
export function createSemanticProvider(
  config: ProviderConfig,
  fetchImpl?: FetchLike,
): SemanticProvider {
  if (!config.enabled) return new DisabledProvider();
  return new LocalSemanticProvider({
    protocol: config.provider,
    endpoint: config.endpoint,
    model: config.model === '' ? null : config.model,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}
