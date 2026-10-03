import { beforeEach, describe, expect, it } from 'vitest';
import { StylesheetManager } from '@core/adaptation';
import type { AdaptationChange } from '@domain/models';

function makeChange(overrides: Partial<AdaptationChange> = {}): AdaptationChange {
  return {
    elementId: 'ca-1',
    property: 'color',
    originalValue: '#888888',
    adaptedValue: '#000000',
    reason: 'test',
    confidence: 'SUPPORTED_MODEL',
    metrics: {
      originalContrast: 1.5,
      adaptedContrast: 2,
      originalSimulatedDistance: 0.05,
      adaptedSimulatedDistance: 0.2,
      changeDistance: 0.1,
      score: 0.5,
    },
    ...overrides,
  };
}

function tag(...ids: string[]): void {
  document.body.innerHTML = ids
    .map((id) => `<p data-coloradapt-id="${id}" style="color:#888888">text</p>`)
    .join('');
}

describe('StylesheetManager', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    tag('ca-1', 'ca-2');
  });

  it('injects a single style element with a rule per change', () => {
    const manager = new StylesheetManager(document);
    manager.apply([makeChange()]);

    const style = document.getElementById('coloradapt-stylesheet');
    expect(style).toBeInstanceOf(HTMLStyleElement);
    expect(style?.textContent).toContain('[data-coloradapt-id="ca-1"]');
    expect(style?.textContent).toContain('color: #000000 !important');
  });

  it('never leaves the transition suppression in the document', () => {
    const manager = new StylesheetManager(document);
    manager.apply([makeChange()]);

    expect(document.getElementById('coloradapt-stylesheet')?.textContent).not.toContain(
      'transition',
    );
  });

  it('raises specificity above a plain id selector without naming a real id', () => {
    const manager = new StylesheetManager(document);
    manager.apply([makeChange()]);

    const css = document.getElementById('coloradapt-stylesheet')?.textContent ?? '';
    expect(css).toContain(':not(#coloradapt-specificity)');
    expect(document.getElementById('coloradapt-specificity')).toBeNull();
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

  it('reports a change as applied only when the computed color is the planned one', () => {
    const manager = new StylesheetManager(document);
    const result = manager.apply([makeChange({ elementId: 'ca-1', adaptedValue: '#102030' })]);

    expect(result.applied).toHaveLength(1);
    expect(result.notApplied).toHaveLength(0);
    expect(getComputedStyle(document.querySelector('[data-coloradapt-id="ca-1"]')!).color).toBe(
      'rgb(16, 32, 48)',
    );
  });

  it('reports a change for a missing element as not applied and leaves no stylesheet', () => {
    const manager = new StylesheetManager(document);
    const result = manager.apply([makeChange({ elementId: 'does-not-exist' })]);

    expect(result.applied).toHaveLength(0);
    expect(result.notApplied).toHaveLength(1);
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
  });

  it('keeps rules only for the changes that were applied', () => {
    const manager = new StylesheetManager(document);
    const result = manager.apply([
      makeChange({ elementId: 'ca-1' }),
      makeChange({ elementId: 'ghost' }),
    ]);

    expect(result.applied.map((c) => c.elementId)).toEqual(['ca-1']);
    expect(result.notApplied.map((c) => c.elementId)).toEqual(['ghost']);
    const css = document.getElementById('coloradapt-stylesheet')?.textContent ?? '';
    expect(css).toContain('ca-1');
    expect(css).not.toContain('ghost');
  });

  it('withOriginalStyles restores the adapted stylesheet text exactly', () => {
    const manager = new StylesheetManager(document);
    manager.apply([makeChange()]);
    const css = document.getElementById('coloradapt-stylesheet')?.textContent;

    const seen = manager.withOriginalStyles(
      () => getComputedStyle(document.querySelector('[data-coloradapt-id="ca-1"]')!).color,
    );

    expect(seen).toBe('rgb(136, 136, 136)');
    expect(document.getElementById('coloradapt-stylesheet')?.textContent).toBe(css);
  });
});
