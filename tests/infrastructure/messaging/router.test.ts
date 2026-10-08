import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M12 (production hardening): the router answers every ColorAdapt message it accepts (a failing handler must not
 * leave the sender's channel open), ignores anything that is not ours, and can be removed.
 */
type Listener = (
  message: unknown,
  sender: { id?: string },
  sendResponse: (response?: unknown) => void,
) => true | undefined;

const listeners = new Set<Listener>();

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'ext-self',
      onMessage: {
        addListener: (fn: Listener) => listeners.add(fn),
        removeListener: (fn: Listener) => listeners.delete(fn),
      },
    },
  },
}));

const { registerMessageRouter } = await import('@infrastructure/messaging');

const message = (type: string) => ({ channel: 'coloradapt', type, payload: undefined });
const only = (): Listener => [...listeners][0]!;

describe('registerMessageRouter', () => {
  beforeEach(() => {
    listeners.clear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('answers with the handler result and keeps the channel open for it', async () => {
    registerMessageRouter({ GET_ANALYSIS: () => Promise.resolve(null) });
    const answer = vi.fn();
    expect(only()(message('GET_ANALYSIS'), { id: 'ext-self' }, answer)).toBe(true);
    await vi.waitFor(() => expect(answer).toHaveBeenCalledWith(null));
  });

  it('answers undefined when a handler rejects, instead of leaving the channel open', async () => {
    registerMessageRouter({ GET_ANALYSIS: () => Promise.reject(new Error('storage down')) });
    const answer = vi.fn();
    expect(only()(message('GET_ANALYSIS'), { id: 'ext-self' }, answer)).toBe(true);
    await vi.waitFor(() => expect(answer).toHaveBeenCalledWith(undefined));
  });

  it('answers undefined when a handler throws synchronously', () => {
    registerMessageRouter({
      GET_ANALYSIS: () => {
        throw new Error('boom');
      },
    });
    const answer = vi.fn();
    expect(only()(message('GET_ANALYSIS'), { id: 'ext-self' }, answer)).toBe(true);
    expect(answer).toHaveBeenCalledWith(undefined);
  });

  it('ignores a message of another extension, a foreign shape and a type nobody handles', () => {
    registerMessageRouter({ GET_ANALYSIS: () => Promise.resolve(null) });
    const answer = vi.fn();
    expect(only()(message('GET_ANALYSIS'), { id: 'someone-else' }, answer)).toBeUndefined();
    expect(only()({ type: 'GET_ANALYSIS' }, { id: 'ext-self' }, answer)).toBeUndefined();
    expect(only()(message('FLUSH_DYNAMIC'), { id: 'ext-self' }, answer)).toBeUndefined();
    expect(only()(null, { id: 'ext-self' }, answer)).toBeUndefined();
    expect(answer).not.toHaveBeenCalled();
  });

  it('is removed by the function it returns', () => {
    const remove = registerMessageRouter({ GET_ANALYSIS: () => Promise.resolve(null) });
    expect(listeners.size).toBe(1);
    remove();
    remove();
    expect(listeners.size).toBe(0);
  });

  it('answers a duplicated message once per delivery, and each delivery independently', async () => {
    let calls = 0;
    registerMessageRouter({ GET_ANALYSIS: () => Promise.resolve((calls += 1) as never) });
    const a = vi.fn();
    const b = vi.fn();
    only()(message('GET_ANALYSIS'), { id: 'ext-self' }, a);
    only()(message('GET_ANALYSIS'), { id: 'ext-self' }, b);
    await vi.waitFor(() => expect(a).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(b).toHaveBeenCalledTimes(1));
  });
});
