import { describe, expect, it } from 'vitest';
import {
  ConsentGatedProvider,
  MockSemanticProvider,
  createSemanticProvider,
  type ProviderRequest,
} from '@core/semantic-ai';

/**
 * M13 (docs/AI_PRIVACY.md, "Firefox consent"): where the browser requires data-collection consent, the provider
 * is gated by it before every request. No consent: nothing reaches the runtime, health included.
 */
const REQUEST = {
  task: 'icon-purpose',
  instructions: 'x',
  payload: '{}',
  temperature: 0,
  maxOutputChars: 600,
} as unknown as ProviderRequest;

const inner = (): MockSemanticProvider => new MockSemanticProvider({ respond: () => '{}' });

describe('ConsentGatedProvider', () => {
  it('sends nothing without consent', async () => {
    const mock = inner();
    const gated = new ConsentGatedProvider(mock, () => Promise.resolve(false));
    expect(await gated.infer(REQUEST, new AbortController().signal)).toEqual({
      ok: false,
      failure: 'consent-required',
    });
    expect(await gated.health()).toBe('UNAVAILABLE');
    expect(mock.calls).toBe(0);
  });

  it('treats a failing consent check as no consent', async () => {
    const mock = inner();
    const gated = new ConsentGatedProvider(mock, () => Promise.reject(new Error('boom')));
    const result = await gated.infer(REQUEST, new AbortController().signal);
    expect(result).toEqual({ ok: false, failure: 'consent-required' });
    expect(mock.calls).toBe(0);
  });

  it('passes requests through while consent holds, and stops the next one when it is revoked', async () => {
    const mock = inner();
    let granted = true;
    const gated = new ConsentGatedProvider(mock, () => Promise.resolve(granted));
    const first = await gated.infer(REQUEST, new AbortController().signal);
    expect(first.ok).toBe(true);
    granted = false;
    const second = await gated.infer(REQUEST, new AbortController().signal);
    expect(second).toEqual({ ok: false, failure: 'consent-required' });
    expect(mock.calls).toBe(1);
  });

  it('keeps the identity of the provider it wraps', () => {
    const mock = inner();
    const gated = new ConsentGatedProvider(mock, () => Promise.resolve(true));
    expect(gated.id).toBe(mock.id);
    expect(gated.identity()).toEqual(mock.identity());
  });
});

describe('createSemanticProvider with consent', () => {
  const config = {
    enabled: true,
    provider: 'local-http',
    endpoint: 'http://127.0.0.1:11434',
    model: '',
  } as const;

  it('gates the local provider and reaches nothing when consent is missing', async () => {
    let requests = 0;
    const provider = createSemanticProvider(
      config,
      () => {
        requests += 1;
        return Promise.resolve(new Response('{}'));
      },
      () => Promise.resolve(false),
    );
    const result = await provider.infer(REQUEST, new AbortController().signal);
    expect(result).toEqual({ ok: false, failure: 'consent-required' });
    expect(requests).toBe(0);
  });

  it('with consent the request goes to the loopback endpoint only', async () => {
    const urls: string[] = [];
    const provider = createSemanticProvider(
      config,
      (url) => {
        urls.push(url);
        return Promise.resolve(new Response(JSON.stringify({ hypothesis: '{}' })));
      },
      () => Promise.resolve(true),
    );
    await provider.infer(REQUEST, new AbortController().signal);
    expect(urls).toEqual(['http://127.0.0.1:11434/v1/semantic']);
  });

  it('stays disabled whatever the consent', () => {
    const provider = createSemanticProvider({ ...config, enabled: false }, undefined, () =>
      Promise.resolve(true),
    );
    expect(provider.id).toBe('disabled');
  });
});
