import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createContentController } from '@features/page-analysis';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '@domain/models';

const DEUTAN: UserSettings = {
  ...DEFAULT_USER_SETTINGS,
  visionProfile: 'deuteranopia',
  adaptationStrength: 1,
};

/**
 * End-to-end-ish smoke test against the real demo fixture
 * (`demo/index.html`) rather than a synthetic snippet — the closest thing
 * to a manual smoke test (docs/DEVELOPMENT.md) that can run in CI. It
 * does not replace actually loading the extension in a browser, but it
 * does catch "the analyzer throws/crashes/misclassifies on a real page"
 * regressions.
 *
 * Loads the fixture's `<style>` and body into vitest's *ambient* jsdom
 * `document` (as every other test in this suite does) rather than
 * spinning up a second `JSDOM` instance — `getComputedStyle` only
 * resolves styles for elements that belong to the window it was called
 * on, and the analyzer (correctly, for a real content script) always
 * calls the global `getComputedStyle`.
 */
function loadDemoDocument(): Document {
  const html = readFileSync(resolve(__dirname, '../../demo/index.html'), 'utf-8');
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
  const body = /<body>([\s\S]*?)<\/body>/.exec(html)?.[1];
  if (!style || !body) throw new Error('demo/index.html fixture shape changed');

  document.head.innerHTML = `<style>${style}</style>`;
  document.body.innerHTML = body;
  return document;
}

/**
 * jsdom's `getComputedStyle` is dramatically slower than a real browser's,
 * so a wall-clock budget would truncate this fixture depending on machine
 * load. A frozen clock makes the analyzer's time budget inert and the
 * result deterministic; the budget itself is covered with an injected clock
 * in tests/core/analysis/performance.test.ts.
 */
const FROZEN_CLOCK = { now: () => 0 };

describe('demo fixture smoke test', () => {
  it('analyzes the demo page without throwing, finds conflicts, and flags unresolved backgrounds', () => {
    const doc = loadDemoDocument();
    const controller = createContentController(doc, FROZEN_CLOCK);

    const result = controller.analyze('https://example.com/demo', DEFAULT_USER_SETTINGS);

    // Low-contrast sections are intentionally present in the fixture.
    expect(result.conflicts.length).toBeGreaterThan(0);
    // Gradient/image background sections must never be silently treated
    // as resolvable solid backgrounds.
    expect(result.unresolvedCount).toBeGreaterThan(0);
    expect(result.elements.length).toBeGreaterThan(0);
  });

  it('classifies the gradient/image/mixed fixture sections correctly', () => {
    const doc = loadDemoDocument();
    const controller = createContentController(doc, FROZEN_CLOCK);
    const result = controller.analyze('https://example.com/demo', DEFAULT_USER_SETTINGS);

    const gradientEl = result.elements.find((el) => el.backgroundKind === 'gradient');
    const imageEl = result.elements.find((el) => el.backgroundKind === 'image');
    const mixedEl = result.elements.find((el) => el.backgroundKind === 'mixed');

    expect(gradientEl).toBeDefined();
    expect(imageEl).toBeDefined();
    expect(mixedEl).toBeDefined();
    for (const el of [gradientEl, imageEl, mixedEl]) {
      expect(el?.analysisStatus).toBe('unsupported');
    }
  });

  it('flags the disabled button and disabled input in the fixture', () => {
    const doc = loadDemoDocument();
    const controller = createContentController(doc, FROZEN_CLOCK);
    const result = controller.analyze('https://example.com/demo', DEFAULT_USER_SETTINGS);

    const disabledElements = result.elements.filter((el) => el.disabled);
    expect(disabledElements.length).toBeGreaterThanOrEqual(2);
  });

  it('enables and disables adaptation on the demo page without leaving stray stylesheets', () => {
    const doc = loadDemoDocument();
    const controller = createContentController(doc, FROZEN_CLOCK);

    controller.enableAdaptation('https://example.com/demo', DEUTAN);
    expect(doc.getElementById('coloradapt-stylesheet')).not.toBeNull();

    controller.disableAdaptation();
    expect(doc.getElementById('coloradapt-stylesheet')).toBeNull();
  });

  it('ON adapts the conflicting demo pairs minimally, leaves the rest, and OFF restores exactly', () => {
    const doc = loadDemoDocument();
    const controller = createContentController(doc, FROZEN_CLOCK);
    const colorOf = (selector: string): string =>
      getComputedStyle(doc.querySelector(selector) as Element).color;
    const everyColor = (): string[] =>
      Array.from(doc.body.querySelectorAll('*')).map((el) => getComputedStyle(el).color);

    const before = everyColor();
    const redGreenBefore = colorOf('.m3-red-green');

    const { adaptation } = controller.enableAdaptation('https://example.com/demo', DEUTAN);

    // Conflicting pairs are adapted...
    expect(adaptation.summary.adapted).toBeGreaterThanOrEqual(2);
    expect(colorOf('.m3-red-green')).not.toBe(redGreenBefore);
    for (const change of adaptation.changes) {
      expect(change.metrics.adaptedSimulatedDistance).toBeGreaterThan(
        change.metrics.originalSimulatedDistance,
      );
      expect(change.metrics.changeDistance).toBeLessThanOrEqual(0.3 + 1e-9);
    }
    // ...an accessible pair and unresolved backgrounds are not.
    const adaptedIds = new Set(adaptation.changes.map((c) => c.elementId));
    const analysis = controller.getLastAnalysis()!;
    for (const el of analysis.elements) {
      if (el.analysisStatus !== 'resolved') expect(adaptedIds.has(el.id)).toBe(false);
    }
    const fine = doc.querySelector('.m3-fine') as Element;
    expect(adaptedIds.has(fine.getAttribute('data-coloradapt-id') ?? '')).toBe(false);

    // Adapting is idempotent...
    const again = controller.enableAdaptation('https://example.com/demo', DEUTAN);
    expect(again.adaptation.changes).toEqual(adaptation.changes);

    // ...and OFF restores every element exactly.
    controller.disableAdaptation();
    expect(everyColor()).toEqual(before);
  });
});
