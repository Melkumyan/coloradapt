import { afterEach, describe, expect, it } from 'vitest';
import { StylesheetManager } from '@core/adaptation';
import type { AdaptationChange } from '@domain/models';

/** M6: the one managed <style> also carries the static cue CSS (docs/SEMANTIC_ACCESSIBILITY.md). */

function change(elementId: string, adaptedValue: string): AdaptationChange {
  return {
    elementId,
    property: 'color',
    originalValue: '#888888',
    adaptedValue,
    reason: 'test',
    confidence: 'SUPPORTED_MODEL',
    metrics: {
      originalContrast: 1,
      adaptedContrast: 1,
      originalSimulatedDistance: 0,
      adaptedSimulatedDistance: 0,
      changeDistance: 0,
      score: 0,
    },
  };
}

const CUES = '[data-coloradapt-cue="underline"]{text-decoration-line:underline !important;}';
const sheet = () => document.getElementById('coloradapt-stylesheet');
const text = () => sheet()?.textContent ?? '';

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('StylesheetManager cue CSS', () => {
  it('creates the sheet for cues alone, and removes it when they go', () => {
    const manager = new StylesheetManager(document);
    expect(manager.hasContent).toBe(false);

    manager.setCueCss(CUES);
    expect(text()).toBe(CUES);
    expect(manager.hasContent).toBe(true);
    expect(manager.ruleCount).toBe(0); // color rules are counted on their own

    manager.setCueCss(null);
    expect(sheet()).toBeNull();
    expect(manager.hasContent).toBe(false);
  });

  it('writes nothing when the text is unchanged', () => {
    const manager = new StylesheetManager(document);
    manager.setCueCss(CUES);
    const node = sheet()!;
    let writes = 0;
    new MutationObserver(() => (writes += 1)).observe(node, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    manager.setCueCss(CUES);
    manager.setCueCss(CUES);
    expect(sheet()).toBe(node);
    expect(writes).toBe(0);
  });

  it('coexists with color rules: removing the last rule keeps the cues, removing the cues keeps the rules', () => {
    document.body.innerHTML = '<p data-coloradapt-id="a" style="color:#888888">x</p>';
    const manager = new StylesheetManager(document);
    manager.applyDelta({ upsert: [change('a', '#112233')], remove: [] });
    manager.setCueCss(CUES);
    expect(text()).toContain('data-coloradapt-s~="color:#112233"');
    expect(text()).toContain(CUES);

    manager.setCueCss(null);
    expect(text()).toContain('data-coloradapt-s~="color:#112233"');
    expect(text()).not.toContain('data-coloradapt-cue');

    manager.setCueCss(CUES);
    manager.applyDelta({ upsert: [], remove: ['a'] });
    expect(sheet()).not.toBeNull();
    expect(text()).toBe(CUES);
  });

  it('a full apply keeps the cue CSS; restore drops everything', () => {
    document.body.innerHTML = '<p data-coloradapt-id="a" style="color:#888888">x</p>';
    const manager = new StylesheetManager(document);
    manager.setCueCss(CUES);
    manager.apply([change('a', '#112233')]);
    expect(text()).toContain(CUES);

    manager.restore();
    expect(sheet()).toBeNull();
    expect(manager.cueCss).toBeNull();
  });

  it('analysis sees the page without cues: withOriginalStyles suspends them and puts them back', () => {
    document.body.innerHTML = '<p id="p" data-coloradapt-cue="underline">x</p>';
    const manager = new StylesheetManager(document);
    manager.setCueCss(CUES);
    const line = () => getComputedStyle(document.getElementById('p')!).textDecorationLine;
    expect(line()).toBe('underline');

    const during = manager.withOriginalStyles(line);

    expect(during).toBe('none');
    expect(line()).toBe('underline');
    expect(text()).toContain(CUES);
  });

  it('a page deleting the sheet that holds only cues is detected and repaired', () => {
    const manager = new StylesheetManager(document);
    manager.setCueCss(CUES);
    expect(manager.isDetached()).toBe(false);

    sheet()!.remove();
    expect(manager.isDetached()).toBe(true);

    manager.reattach();
    expect(manager.isDetached()).toBe(false);
    expect(text()).toBe(CUES);
  });

  it('a probe leaves the cue CSS exactly as it was', () => {
    const manager = new StylesheetManager(document);
    manager.setCueCss(CUES);
    manager.withProbe('svg { color: red; }', () => undefined);
    expect(text()).toBe(CUES);
  });
});
