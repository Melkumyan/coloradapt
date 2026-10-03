import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContentController } from '@features/page-analysis';
import { DEFAULT_USER_SETTINGS } from '@domain/models';

const DEUTAN_SETTINGS = {
  ...DEFAULT_USER_SETTINGS,
  visionProfile: 'deuteranopia' as const,
  adaptationStrength: 1,
};

function setUpLowContrastPage(): void {
  document.body.innerHTML = `
    <p style="color: rgb(250,250,250); background-color: rgb(255,255,255);">Hard to read</p>
  `;
}

describe('createContentController', () => {
  it('analyze() reports detected conflicts without touching the stylesheet', () => {
    setUpLowContrastPage();
    const controller = createContentController(document, { now: () => 0 });

    const result = controller.analyze('https://example.com', DEFAULT_USER_SETTINGS);

    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
    expect(controller.getLastAnalysis()).toEqual(result);
  });

  it('analyze() excludes gradient-background elements from conflicts but counts them as unresolved', () => {
    document.body.innerHTML = `
      <p style="color: rgb(240,240,240); background-image: linear-gradient(red, blue);">
        Could be anything
      </p>
    `;
    const controller = createContentController(document, { now: () => 0 });

    const result = controller.analyze('https://example.com', DEFAULT_USER_SETTINGS);

    expect(result.conflicts).toHaveLength(0);
    expect(result.unresolvedCount).toBe(1);
  });

  it('enableAdaptation() applies a stylesheet, disableAdaptation() restores the original state', () => {
    document.body.innerHTML =
      '<p style="color: #c0392b; background-color: #27ae60;">Red on green</p>';
    const controller = createContentController(document, { now: () => 0 });

    const { adaptation } = controller.enableAdaptation('https://example.com', DEUTAN_SETTINGS);
    expect(adaptation.changes.length).toBeGreaterThan(0);
    expect(document.getElementById('coloradapt-stylesheet')).not.toBeNull();

    controller.disableAdaptation();
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
  });

  describe('color animations', () => {
    class FakeKeyframeEffect {
      constructor(
        readonly target: Element | null,
        private readonly keyframes: Array<Record<string, unknown>>,
        readonly pseudoElement: string | null = null,
      ) {}
      getKeyframes(): Array<Record<string, unknown>> {
        return this.keyframes;
      }
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      delete (document as unknown as { getAnimations?: unknown }).getAnimations;
    });

    function animate(...animations: Array<[Element | null, Array<Record<string, unknown>>]>): void {
      vi.stubGlobal('KeyframeEffect', FakeKeyframeEffect);
      (document as unknown as { getAnimations: () => unknown[] }).getAnimations = () =>
        animations.map(([target, keyframes]) => ({
          effect: new FakeKeyframeEffect(target, keyframes),
        }));
    }

    const PAGE = `
      <div id="wrap"><p id="child" style="color: #c0392b; background-color: #27ae60;">child</p></div>
      <p id="own" style="color: #c0392b; background-color: #27ae60;">own</p>
      <p id="plain" style="color: #c0392b; background-color: #27ae60;">plain</p>
    `;

    it('skips an element whose color is animated, and elements inheriting an animated ancestor', () => {
      document.body.innerHTML = PAGE;
      animate(
        [document.getElementById('own'), [{ color: 'red' }, { color: 'blue' }]],
        [document.getElementById('wrap'), [{ color: 'red' }]],
      );
      const controller = createContentController(document, { now: () => 0 });

      const { adaptation } = controller.enableAdaptation('https://example.com', DEUTAN_SETTINGS);

      expect(adaptation.summary.adapted).toBe(1); // only #plain
      expect(adaptation.summary.unresolved).toBe(2); // #own and #child (animated wrapper)
      expect(adaptation.changes).toHaveLength(1);
      controller.disableAdaptation();
    });

    it('still adapts elements whose animation does not touch color or targets a pseudo-element', () => {
      document.body.innerHTML = PAGE;
      animate([document.getElementById('own'), [{ transform: 'none' }]]);
      const controller = createContentController(document, { now: () => 0 });

      const { adaptation } = controller.enableAdaptation('https://example.com', DEUTAN_SETTINGS);

      expect(adaptation.summary.adapted).toBe(3);
      controller.disableAdaptation();
    });
  });

  it('reports a change the browser did not honor as notApplied, never as adapted', () => {
    document.body.innerHTML =
      '<p id="x" style="color: #c0392b; background-color: #27ae60;">Red on green</p>';
    const controller = createContentController(document, { now: () => 0 });
    // Make the planned color unreachable: the element carries no usable selector target.
    const original = document.querySelector.bind(document);
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) =>
      selector.includes('coloradapt-specificity') ? null : original(selector),
    );

    const { adaptation } = controller.enableAdaptation('https://example.com', DEUTAN_SETTINGS);
    vi.restoreAllMocks();

    expect(adaptation.changes).toHaveLength(0);
    expect(adaptation.summary.adapted).toBe(0);
    expect(adaptation.summary.notApplied).toBe(1);
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
  });
});
