import { describe, expect, it } from 'vitest';
import { StylesheetManager } from '@core/adaptation';
import type { AdaptationChange } from '@domain/models';

function makeChange(overrides: Partial<AdaptationChange> = {}): AdaptationChange {
  return {
    elementId: 'ca-1',
    property: 'color',
    originalValue: '#888888',
    adaptedValue: '#000000',
    reason: 'test',
    ...overrides,
  };
}

describe('StylesheetManager', () => {
  it('injects a single style element with a rule per change', () => {
    const manager = new StylesheetManager(document);
    manager.apply([makeChange()]);

    const style = document.getElementById('coloradapt-stylesheet');
    expect(style).toBeInstanceOf(HTMLStyleElement);
    expect(style?.textContent).toContain('[data-coloradapt-id="ca-1"]');
    expect(style?.textContent).toContain('color: #000000');
  });

  it('restore() removes the injected stylesheet, returning the page to its original state', () => {
    const manager = new StylesheetManager(document);
    manager.apply([makeChange()]);
    manager.restore();

    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
  });

  it('applying an empty change list restores instead of injecting an empty stylesheet', () => {
    const manager = new StylesheetManager(document);
    manager.apply([makeChange()]);
    manager.apply([]);

    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
  });

  it('re-applying reuses and replaces the same style element', () => {
    const manager = new StylesheetManager(document);
    manager.apply([makeChange({ elementId: 'ca-1' })]);
    manager.apply([makeChange({ elementId: 'ca-2' })]);

    const styles = document.querySelectorAll('#coloradapt-stylesheet');
    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toContain('ca-2');
    expect(styles[0]?.textContent).not.toContain('ca-1');
  });
});
