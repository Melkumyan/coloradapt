import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_USER_SETTINGS } from '@domain/models';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * M12 failure injection: the background cannot be reached, answers nothing, or refuses a write. The popup and the
 * options page say so and stay usable; neither loads forever, throws unhandled, nor acts as if a refused change
 * had been stored.
 */
type Reply = 'reject' | 'undefined' | 'ok';
const state: { get: Reply; update: Reply; sent: string[] } = { get: 'ok', update: 'ok', sent: [] };

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: { openOptionsPage: () => Promise.resolve(), getURL: (p: string) => p },
    tabs: { create: () => Promise.resolve() },
  },
}));

vi.mock('@infrastructure/messaging', () => ({
  sendToBackground: (type: string): Promise<unknown> => {
    const mode = type === 'GET_SETTINGS' ? state.get : state.update;
    if (mode === 'reject') return Promise.reject(new Error('Receiving end does not exist'));
    if (mode === 'undefined') return Promise.resolve(undefined);
    return Promise.resolve({ ...DEFAULT_USER_SETTINGS, enabled: true });
  },
  sendToTab: (_tabId: number, type: string): Promise<unknown> => {
    state.sent.push(type);
    return Promise.resolve(null);
  },
  getActiveTabId: () => Promise.resolve(7),
}));

const { App: Popup } = await import('../../src/entrypoints/popup/App');
const { App: Options } = await import('../../src/entrypoints/options/App');

async function mount(component: typeof Popup): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  await act(async () => {
    createRoot(host).render(createElement(component));
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return host;
}

describe('settings failures in the extension pages', () => {
  beforeEach(() => {
    state.get = 'ok';
    state.update = 'ok';
    state.sent = [];
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const [name, page] of [
    ['popup', Popup],
    ['options', Options],
  ] as const) {
    for (const reply of ['reject', 'undefined'] as const) {
      it(`${name}: a background that ${reply === 'reject' ? 'cannot be reached' : 'answers nothing'} shows an alert, not "Loading"`, async () => {
        state.get = reply;
        const host = await mount(page);
        expect(host.querySelector('[role="alert"]')?.textContent).toContain(
          'could not load its settings',
        );
        expect(host.textContent).not.toContain('Loading');
      });
    }
  }

  it('popup: a refused write does not switch adaptation on the page', async () => {
    const host = await mount(Popup);
    expect(host.querySelector('button[aria-pressed]')).not.toBeNull();
    state.update = 'reject';
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-pressed]')!.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(state.sent).toEqual([]); // nothing was sent to the page: the setting was not stored
  });

  it('popup: a stored write does switch the page', async () => {
    const host = await mount(Popup);
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-pressed]')!.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(state.sent.length).toBeGreaterThan(0);
  });
});
