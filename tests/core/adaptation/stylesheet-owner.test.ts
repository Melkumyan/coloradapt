import { afterEach, describe, expect, it } from 'vitest';
import { StylesheetManager } from '@core/adaptation';
import type { AdaptationChange } from '@domain/models';

/**
 * Rules of an inline SVG target several elements but belong to one owner: they are
 * replaced, verified and dropped as one group, and a rule is identified by element
 * AND property. (jsdom reports computed `color` / `background-color`; the SVG
 * properties themselves are verified in the real browser, e2e/svg-paint.spec.ts.)
 */
function change(
  elementId: string,
  adaptedValue: string,
  options: { ownerId?: string; property?: string } = {},
): AdaptationChange {
  return {
    elementId,
    ...(options.ownerId ? { ownerId: options.ownerId } : {}),
    property: options.property ?? 'color',
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
const rulesIn = () =>
  sheetText()
    .split('\n')
    .filter((line) => line.includes('!important'));
const colorOf = (id: string) =>
  getComputedStyle(document.querySelector(`[data-coloradapt-id="${id}"]`)!).color;

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('rules are identified by element and property', () => {
  it('one element can carry rules for several properties', () => {
    page(['a']);
    const sheet = new StylesheetManager(document);
    const result = sheet.applyDelta({
      upsert: [change('a', '#112233'), change('a', '#445566', { property: 'background-color' })],
      remove: [],
    });
    expect(result).toMatchObject({ added: 2, updated: 0, removed: 0 });
    expect(rulesIn()).toHaveLength(2);
    expect(sheet.ruleCount).toBe(2);
    expect(sheet.ruleFor('a')?.adaptedValue).toBe('#112233');
    expect(sheet.ruleFor('a', 'background-color')?.adaptedValue).toBe('#445566');
    expect(sheet.ruleIds()).toEqual(['a']);
    sheet.restore();
  });

  it('re-submitting the same rules rewrites nothing and still verifies', () => {
    page(['a']);
    const sheet = new StylesheetManager(document);
    const rules = [change('a', '#112233', { ownerId: 'a' })];
    sheet.applyDelta({ upsert: rules, remove: [] });
    const again = sheet.applyDelta({ upsert: rules, remove: [] });
    expect(again).toMatchObject({ added: 0, updated: 0, removed: 0, pruned: 0 });
    expect(again.applied).toHaveLength(1);
    expect(rulesIn()).toHaveLength(1);
    sheet.restore();
  });
});

describe('owner groups', () => {
  it('rules of one owner are found through the owner and through each target', () => {
    page(['svg', 'shape']);
    const sheet = new StylesheetManager(document);
    sheet.applyDelta({
      upsert: [
        change('svg', '#112233', { ownerId: 'svg' }),
        change('shape', '#112233', { ownerId: 'svg' }),
      ],
      remove: [],
    });
    expect(sheet.has('svg')).toBe(true);
    expect(sheet.has('shape')).toBe(true);
    expect(sheet.has('other')).toBe(false);
    expect(sheet.ruleCount).toBe(2);
    expect(colorOf('shape')).toBe('rgb(17, 34, 51)');
    sheet.restore();
  });

  it('removing the owner drops every rule it owns, and only those', () => {
    page(['svg', 'shape', 'p']);
    const sheet = new StylesheetManager(document);
    sheet.applyDelta({
      upsert: [
        change('svg', '#112233', { ownerId: 'svg' }),
        change('shape', '#112233', { ownerId: 'svg' }),
        change('p', '#445566'),
      ],
      remove: [],
    });
    const result = sheet.applyDelta({ upsert: [], remove: ['svg'] });
    expect(result.removed).toBe(2);
    expect(sheet.has('svg')).toBe(false);
    expect(sheet.has('shape')).toBe(false);
    expect(sheet.has('p')).toBe(true);
    expect(rulesIn()).toHaveLength(1);
    expect(colorOf('shape')).toBe('rgb(136, 136, 136)');
    sheet.restore();
  });

  it('removing a target id drops the rule that targets it', () => {
    page(['svg', 'shape']);
    const sheet = new StylesheetManager(document);
    sheet.applyDelta({
      upsert: [
        change('svg', '#112233', { ownerId: 'svg' }),
        change('shape', '#112233', { ownerId: 'svg' }),
      ],
      remove: [],
    });
    sheet.applyDelta({ upsert: [], remove: ['shape'] });
    expect(sheet.has('shape')).toBe(false);
    expect(sheet.has('svg')).toBe(true);
    expect(sheet.ruleCount).toBe(1);
    sheet.restore();
  });

  it('an owner`s rules are replaced as a group: what it no longer submits is pruned', () => {
    page(['svg', 'shape']);
    const sheet = new StylesheetManager(document);
    sheet.applyDelta({
      upsert: [
        change('svg', '#112233', { ownerId: 'svg' }),
        change('shape', '#112233', { ownerId: 'svg' }),
      ],
      remove: [],
    });
    // The paint moved from the shape to the <svg>.
    const result = sheet.applyDelta({
      upsert: [change('svg', '#445566', { ownerId: 'svg' })],
      remove: [],
    });
    expect(result).toMatchObject({ added: 0, updated: 1, pruned: 1 });
    expect(sheet.has('shape')).toBe(false);
    expect(sheet.ruleCount).toBe(1);
    expect(rulesIn()).toHaveLength(1);
    expect(colorOf('svg')).toBe('rgb(68, 85, 102)');
    expect(colorOf('shape')).toBe('rgb(136, 136, 136)');
    sheet.restore();
  });

  it('pruning one owner never touches another owner or a plain element', () => {
    page(['a', 'a-shape', 'b', 'b-shape', 'p']);
    const sheet = new StylesheetManager(document);
    sheet.applyDelta({
      upsert: [
        change('a', '#112233', { ownerId: 'a' }),
        change('a-shape', '#112233', { ownerId: 'a' }),
        change('b', '#445566', { ownerId: 'b' }),
        change('b-shape', '#445566', { ownerId: 'b' }),
        change('p', '#778899'),
      ],
      remove: [],
    });
    const result = sheet.applyDelta({
      upsert: [change('a', '#112233', { ownerId: 'a' })],
      remove: [],
    });
    expect(result.pruned).toBe(1);
    expect(sheet.has('a-shape')).toBe(false);
    for (const id of ['b', 'b-shape', 'p']) expect(sheet.has(id)).toBe(true);
    expect(sheet.ruleCount).toBe(4);
    sheet.restore();
  });

  it('a group stands or falls together: if one rule is out-ranked the whole unit is not applied', () => {
    page(['svg', 'shape']);
    // An inline !important on one target out-ranks the rule.
    document
      .querySelector('[data-coloradapt-id="shape"]')!
      .setAttribute('style', 'color: #888888 !important');
    const sheet = new StylesheetManager(document);
    const result = sheet.applyDelta({
      upsert: [
        change('svg', '#112233', { ownerId: 'svg' }),
        change('shape', '#112233', { ownerId: 'svg' }),
      ],
      remove: [],
    });
    expect(result.applied).toEqual([]);
    expect(result.notApplied.map((c) => c.elementId).sort()).toEqual(['shape', 'svg']);
    // Nothing of the unit is left behind: the sheet is gone and nothing is half-applied.
    expect(sheet.ruleCount).toBe(0);
    expect(sheet.has('svg')).toBe(false);
    expect(colorOf('svg')).toBe('rgb(136, 136, 136)');
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
  });

  it('a failing unit does not take another owner down with it', () => {
    page(['a', 'a-shape', 'b']);
    document
      .querySelector('[data-coloradapt-id="a-shape"]')!
      .setAttribute('style', 'color: #888888 !important');
    const sheet = new StylesheetManager(document);
    const result = sheet.applyDelta({
      upsert: [
        change('a', '#112233', { ownerId: 'a' }),
        change('a-shape', '#112233', { ownerId: 'a' }),
        change('b', '#445566'),
      ],
      remove: [],
    });
    expect(result.applied.map((c) => c.elementId)).toEqual(['b']);
    expect(result.notApplied).toHaveLength(2);
    expect(sheet.has('a')).toBe(false);
    expect(sheet.has('b')).toBe(true);
    expect(rulesIn()).toHaveLength(1);
    sheet.restore();
  });

  it('full apply groups too', () => {
    page(['svg', 'shape']);
    document
      .querySelector('[data-coloradapt-id="shape"]')!
      .setAttribute('style', 'color: #888888 !important');
    const sheet = new StylesheetManager(document);
    const result = sheet.apply([
      change('svg', '#112233', { ownerId: 'svg' }),
      change('shape', '#112233', { ownerId: 'svg' }),
    ]);
    expect(result.applied).toEqual([]);
    expect(result.notApplied).toHaveLength(2);
    expect(sheet.ruleCount).toBe(0);
  });

  it('restore removes every rule and the sheet', () => {
    page(['svg', 'shape']);
    const sheet = new StylesheetManager(document);
    sheet.apply([
      change('svg', '#112233', { ownerId: 'svg' }),
      change('shape', '#112233', { ownerId: 'svg' }),
    ]);
    sheet.restore();
    expect(sheet.ruleCount).toBe(0);
    expect(sheet.has('svg')).toBe(false);
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
    expect(colorOf('shape')).toBe('rgb(136, 136, 136)');
  });
});

describe('StylesheetManager.withProbe', () => {
  it('shows the probe to `read` and leaves the sheet exactly as it was', () => {
    page(['a']);
    const sheet = new StylesheetManager(document);
    sheet.apply([change('a', '#112233')]);
    const before = sheetText();
    const seen = sheet.withProbe('/* probe */', () => sheetText());
    expect(seen).toContain('/* probe */');
    expect(seen).toContain('#112233');
    expect(sheetText()).toBe(before);
    expect(sheet.ruleCount).toBe(1);
    sheet.restore();
  });

  it('creates the <style> when there is none and removes it again', () => {
    page(['a']);
    const sheet = new StylesheetManager(document);
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
    const seen = sheet.withProbe(
      '/* probe */',
      () => document.getElementById('coloradapt-stylesheet')?.textContent ?? null,
    );
    expect(seen).toContain('/* probe */');
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
    expect(sheet.styleElement).toBeNull();
  });

  it('removes the probe even when `read` throws', () => {
    page(['a']);
    const sheet = new StylesheetManager(document);
    expect(() =>
      sheet.withProbe('/* probe */', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
  });

  it('inside withOriginalStyles the probe sits on the page`s own styles, not on ours', () => {
    page(['a']);
    const sheet = new StylesheetManager(document);
    sheet.apply([change('a', '#112233')]);
    const seen = sheet.withOriginalStyles(() => sheet.withProbe('/* probe */', () => sheetText()));
    expect(seen).toContain('/* probe */');
    expect(seen).not.toContain('#112233');
    // ...and the adaptation is back afterwards, with no probe in it.
    expect(sheetText()).toContain('#112233');
    expect(sheetText()).not.toContain('probe');
    expect(colorOf('a')).toBe('rgb(17, 34, 51)');
    sheet.restore();
  });
});
