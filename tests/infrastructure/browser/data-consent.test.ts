import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M13: Firefox's data-collection consent. Whether it applies is read from the packaged manifest, it is requested
 * only through `requestWebsiteContentConsent` (called from a click), and a revoked or unknown state is "not allowed".
 */
type Listener = (removed: { data_collection?: string[] }) => void;
const state = {
  manifest: {} as Record<string, unknown>,
  granted: [] as string[] | undefined,
  answer: true as boolean | Error,
  requests: [] as unknown[],
  listeners: new Set<Listener>(),
};

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: { getManifest: () => state.manifest },
    permissions: {
      getAll: () =>
        Promise.resolve(state.granted === undefined ? {} : { data_collection: state.granted }),
      request: (p: unknown) => {
        state.requests.push(p);
        if (state.answer instanceof Error) return Promise.reject(state.answer);
        if (state.answer) state.granted = ['websiteContent'];
        return Promise.resolve(state.answer);
      },
      onRemoved: {
        addListener: (l: Listener) => state.listeners.add(l),
        removeListener: (l: Listener) => state.listeners.delete(l),
      },
    },
  },
}));

const {
  consentRequired,
  requestWebsiteContentConsent,
  watchWebsiteContentRevoked,
  websiteContentAllowed,
} = await import('@infrastructure/browser/data-consent');

const FIREFOX = {
  browser_specific_settings: {
    gecko: { data_collection_permissions: { required: ['none'], optional: ['websiteContent'] } },
  },
};

beforeEach(() => {
  state.manifest = FIREFOX;
  state.granted = [];
  state.answer = true;
  state.requests = [];
  state.listeners.clear();
});

describe('data-collection consent', () => {
  it('does not apply to a build without the Firefox manifest key (Chrome)', async () => {
    state.manifest = {};
    expect(consentRequired()).toBe(false);
    expect(await requestWebsiteContentConsent()).toBe('not-required');
    expect(await websiteContentAllowed()).toBe(true);
    expect(state.requests).toEqual([]);
  });

  it('is not granted on a fresh install, and reading it never prompts', async () => {
    expect(consentRequired()).toBe(true);
    expect(await websiteContentAllowed()).toBe(false);
    expect(state.requests).toEqual([]);
  });

  it('asks for websiteContent only, nothing broader', async () => {
    expect(await requestWebsiteContentConsent()).toBe('granted');
    expect(state.requests).toEqual([{ data_collection: ['websiteContent'] }]);
    expect(await websiteContentAllowed()).toBe(true);
  });

  it('a refusal is denied and nothing is allowed', async () => {
    state.answer = false;
    expect(await requestWebsiteContentConsent()).toBe('denied');
    expect(await websiteContentAllowed()).toBe(false);
  });

  it('a browser that rejects the request (no such permission, no user action) is denied', async () => {
    state.answer = new Error('not supported');
    expect(await requestWebsiteContentConsent()).toBe('denied');
    expect(await websiteContentAllowed()).toBe(false);
  });

  it('a browser without data-collection permissions allows nothing', async () => {
    state.granted = undefined;
    expect(await websiteContentAllowed()).toBe(false);
  });

  it('reports a revocation of websiteContent, and only that', () => {
    const onRevoked = vi.fn();
    const stop = watchWebsiteContentRevoked(onRevoked);
    for (const l of state.listeners) l({ data_collection: ['technicalAndInteraction'] });
    for (const l of state.listeners) l({});
    expect(onRevoked).not.toHaveBeenCalled();
    for (const l of state.listeners) l({ data_collection: ['websiteContent'] });
    expect(onRevoked).toHaveBeenCalledTimes(1);
    stop();
    expect(state.listeners.size).toBe(0);
  });
});
