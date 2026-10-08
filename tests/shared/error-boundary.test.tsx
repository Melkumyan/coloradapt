import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '@shared/ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** M12: a failing page shows a message instead of going blank, and logs only the error's name. */
describe('ErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function render(child: () => never | string): HTMLElement {
    const host = document.createElement('div');
    document.body.append(host);
    const Bomb = (): string => child();
    act(() => {
      createRoot(host).render(createElement(ErrorBoundary, null, createElement(Bomb)));
    });
    return host;
  }

  it('renders its children while nothing fails', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const host = render(() => 'fine');
    expect(host.textContent).toBe('fine');
  });

  it('shows an alert instead of a blank page, and logs a diagnostic code with no message text', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const host = render(() => {
      throw new RangeError('SECRET page text that must not be logged');
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Close it and open it again',
    );
    const diagnostic = logged.mock.calls.find((c) =>
      String(c[0]).includes('diagnostic: ui-crashed'),
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.[1]).toBe('RangeError');
    expect(
      JSON.stringify(
        logged.mock.calls.filter((c) => c[0] === '[ColorAdapt] diagnostic: ui-crashed'),
      ),
    ).not.toContain('SECRET');
  });
});
