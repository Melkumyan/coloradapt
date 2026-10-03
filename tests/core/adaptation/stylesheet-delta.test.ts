import { afterEach, describe, expect, it } from 'vitest';
import { StylesheetManager } from '@core/adaptation';
import type { AdaptationChange } from '@domain/models';

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

function page(ids: readonly string[]): void {
  document.body.innerHTML = ids
    .map((id) => `<p data-coloradapt-id="${id}" style="color:#888888">text ${id}</p>`)
    .join('');
}

const sheetText = () => document.getElementById('coloradapt-stylesheet')?.textContent ?? '';
const rulesIn = (text: string) => text.split('\n').filter((line) => line.includes('!important'));
const colorOf = (id: string) =>
  getComputedStyle(document.querySelector(`[data-coloradapt-id="${id}"]`)!).color;

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('StylesheetManager.applyDelta', () => {
  it('adds rules one at a time and reports counts', () => {
    page(['a', 'b']);
    const sheet = new StylesheetManager(document);

    const first = sheet.applyDelta({ upsert: [change('a', '#112233')], remove: [] });
    expect(first).toMatchObject({ added: 1, updated: 0, removed: 0 });
    expect(first.applied).toHaveLength(1);
    expect(colorOf('a')).toBe('rgb(17, 34, 51)');
    expect(colorOf('b')).toBe('rgb(136, 136, 136)');

    const second = sheet.applyDelta({ upsert: [change('b', '#445566')], remove: [] });
    expect(second).toMatchObject({ added: 1, updated: 0, removed: 0 });
    expect(rulesIn(sheetText())).toHaveLength(2);
    expect(sheet.ruleCount).toBe(2);
    sheet.restore();
  });

  it('replaces a rule for the same element instead of duplicating it', () => {
    page(['a']);
    const sheet = new StylesheetManager(document);
    sheet.applyDelta({ upsert: [change('a', '#112233')], remove: [] });

    const result = sheet.applyDelta({ upsert: [change('a', '#445566')], remove: [] });

    expect(result).toMatchObject({ added: 0, updated: 1 });
    expect(rulesIn(sheetText())).toHaveLength(1);
    expect(colorOf('a')).toBe('rgb(68, 85, 102)');
    expect(sheet.ruleFor('a')?.adaptedValue).toBe('#445566');
    sheet.restore();
  });

  it('updating the same element 100 times leaves exactly one rule', () => {
    page(['a']);
    const sheet = new StylesheetManager(document);
    for (let i = 0; i < 100; i += 1) {
      const value = `#${(0x100000 + i * 997).toString(16).padStart(6, '0')}`;
      sheet.applyDelta({ upsert: [change('a', value)], remove: [] });
    }
    expect(rulesIn(sheetText())).toHaveLength(1);
    expect(sheet.ruleCount).toBe(1);
    expect(document.querySelectorAll('#coloradapt-stylesheet')).toHaveLength(1);
    sheet.restore();
  });

  it('re-submitting an unchanged rule rewrites nothing', () => {
    page(['a']);
    const sheet = new StylesheetManager(document);
    sheet.applyDelta({ upsert: [change('a', '#112233')], remove: [] });
    const style = document.getElementById('coloradapt-stylesheet')!;
    let mutations = 0;
    const observer = new MutationObserver((records) => (mutations += records.length));
    observer.observe(style, { childList: true, characterData: true, subtree: true });

    const result = sheet.applyDelta({ upsert: [change('a', '#112233')], remove: [] });

    expect(result).toMatchObject({ added: 0, updated: 0, removed: 0 });
    expect(result.applied).toHaveLength(1);
    expect(observer.takeRecords()).toHaveLength(0);
    expect(mutations).toBe(0);
    observer.disconnect();
    sheet.restore();
  });

  it('removes rules by element id and ignores unknown ids', () => {
    page(['a', 'b']);
    const sheet = new StylesheetManager(document);
    sheet.applyDelta({
      upsert: [change('a', '#112233'), change('b', '#445566')],
      remove: [],
    });

    const result = sheet.applyDelta({ upsert: [], remove: ['a', 'nope'] });

    expect(result.removed).toBe(1);
    expect(sheet.has('a')).toBe(false);
    expect(sheet.has('b')).toBe(true);
    expect(sheetText()).not.toContain('"a"');
    expect(colorOf('a')).toBe('rgb(136, 136, 136)');
    sheet.restore();
  });

  it('removes the <style> element when the last rule goes, and re-creates it later', () => {
    page(['a']);
    const sheet = new StylesheetManager(document);
    sheet.applyDelta({ upsert: [change('a', '#112233')], remove: [] });
    sheet.applyDelta({ upsert: [], remove: ['a'] });
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
    expect(sheet.ruleCount).toBe(0);

    sheet.applyDelta({ upsert: [change('a', '#112233')], remove: [] });
    expect(document.getElementById('coloradapt-stylesheet')).not.toBeNull();
    sheet.restore();
  });

  it('a rule for an element the browser does not recolor is dropped and reported', () => {
    page(['a']);
    const sheet = new StylesheetManager(document);
    // An inline !important declaration out-ranks any stylesheet rule.
    document.querySelector('p')!.setAttribute('style', 'color: #888888 !important');

    const result = sheet.applyDelta({ upsert: [change('a', '#112233')], remove: [] });

    expect(result.notApplied.map((c) => c.elementId)).toEqual(['a']);
    expect(result.applied).toHaveLength(0);
    expect(sheet.has('a')).toBe(false);
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
  });

  it('re-verifies an unchanged rule: a page that out-ranks it later is noticed', () => {
    page(['a']);
    const sheet = new StylesheetManager(document);
    sheet.applyDelta({ upsert: [change('a', '#112233')], remove: [] });
    document.querySelector('p')!.setAttribute('style', 'color: #888888 !important');

    const result = sheet.applyDelta({ upsert: [change('a', '#112233')], remove: [] });

    expect(result.notApplied).toHaveLength(1);
    expect(sheet.has('a')).toBe(false);
  });

  it('can use caller-provided nodes instead of searching the document', () => {
    page(['a']);
    const sheet = new StylesheetManager(document);
    const node = document.querySelector('p')!;
    const result = sheet.applyDelta(
      { upsert: [change('a', '#112233')], remove: [] },
      new Map([['a', node]]),
    );
    expect(result.applied).toHaveLength(1);
    sheet.restore();
  });

  it('put the rules back when the page removes the <style> element', () => {
    page(['a']);
    const sheet = new StylesheetManager(document);
    sheet.applyDelta({ upsert: [change('a', '#112233')], remove: [] });
    document.getElementById('coloradapt-stylesheet')!.remove();

    expect(sheet.isDetached()).toBe(true);
    sheet.reattach();

    expect(sheet.isDetached()).toBe(false);
    expect(colorOf('a')).toBe('rgb(17, 34, 51)');
    sheet.restore();
  });

  it('a later delta also recovers a removed <style> element', () => {
    page(['a', 'b']);
    const sheet = new StylesheetManager(document);
    sheet.applyDelta({ upsert: [change('a', '#112233')], remove: [] });
    document.getElementById('coloradapt-stylesheet')!.remove();

    sheet.applyDelta({ upsert: [change('b', '#445566')], remove: [] });

    expect(colorOf('a')).toBe('rgb(17, 34, 51)');
    expect(colorOf('b')).toBe('rgb(68, 85, 102)');
    sheet.restore();
  });

  it('apply() still replaces everything, and restore() forgets all rules', () => {
    page(['a', 'b']);
    const sheet = new StylesheetManager(document);
    sheet.applyDelta({ upsert: [change('a', '#112233')], remove: [] });

    sheet.apply([change('b', '#445566')]);
    expect(sheet.ruleIds()).toEqual(['b']);
    expect(colorOf('a')).toBe('rgb(136, 136, 136)');

    sheet.restore();
    expect(sheet.ruleCount).toBe(0);
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
  });

  it('analysis still sees the original colors while rules are applied', () => {
    page(['a']);
    const sheet = new StylesheetManager(document);
    sheet.applyDelta({ upsert: [change('a', '#112233')], remove: [] });
    expect(colorOf('a')).toBe('rgb(17, 34, 51)');

    expect(sheet.withOriginalStyles(() => colorOf('a'))).toBe('rgb(136, 136, 136)');
    expect(colorOf('a')).toBe('rgb(17, 34, 51)');
    sheet.restore();
  });
});
