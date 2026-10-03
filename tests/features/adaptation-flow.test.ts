import { beforeEach, describe, expect, it } from 'vitest';
import { createContentController } from '@features/page-analysis';
import { resolveEffectiveSettings } from '@features/settings';
import { parseColor, toHex } from '@core/color';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '@domain/models';

/**
 * Full pipeline against a small DOM: analyze -> detect -> simulate ->
 * optimize -> AdaptationPlan -> stylesheet -> computed style -> restore.
 * jsdom evaluates the injected stylesheet through getComputedStyle, so the
 * assertions are on real computed colors, not on the stylesheet text.
 */
const FROZEN_CLOCK = { now: () => 0 };

const DEUTAN: UserSettings = {
  ...DEFAULT_USER_SETTINGS,
  visionProfile: 'deuteranopia',
  adaptationStrength: 1,
};

const PAGE = `
  <p id="bad" style="color:#c0392b;background-color:#27ae60">Red on green</p>
  <p id="fine" style="color:#000000;background-color:#ffffff">Black on white</p>
  <p id="green-ok" style="color:#ffffff;background-color:#2e8b2e">White on green</p>
  <p id="gradient" style="color:#c0392b;background-image:linear-gradient(#27ae60,#27ae60)">Gradient</p>
  <p id="image" style="color:#c0392b;background-image:url('data:image/gif;base64,R0lGODlhAQABAAAAACw=')">Image</p>
  <p id="faded" style="color:#c0392b;background-color:#27ae60;opacity:0.9">Faded</p>
  <button id="off" disabled style="color:#c0392b;background-color:#27ae60">Disabled</button>
`;

function computedColor(id: string): string {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} missing`);
  const parsed = parseColor(getComputedStyle(element).color);
  if (!parsed) throw new Error(`unparseable color on #${id}`);
  return toHex(parsed);
}

const ORIGINAL = {
  bad: '#c0392b',
  fine: '#000000',
  'green-ok': '#ffffff',
  gradient: '#c0392b',
  image: '#c0392b',
  faded: '#c0392b',
  off: '#c0392b',
};

function snapshotColors(): Record<string, string> {
  return Object.fromEntries(Object.keys(ORIGINAL).map((id) => [id, computedColor(id)]));
}

describe('adaptation flow', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = PAGE;
  });

  it('starts from the expected original colors', () => {
    expect(snapshotColors()).toEqual(ORIGINAL);
  });

  it('adapts only the resolved, conflicting element and restores it exactly on disable', () => {
    const controller = createContentController(document, FROZEN_CLOCK);
    const { adaptation } = controller.enableAdaptation('https://example.com', DEUTAN);

    expect(adaptation.changes.map((c) => c.originalValue)).toEqual(['#c0392b']);
    expect(adaptation.changes).toHaveLength(1);
    const change = adaptation.changes[0]!;
    expect(change.property).toBe('color');
    expect(change.confidence).toBe('SUPPORTED_MODEL');
    expect(change.metrics.adaptedSimulatedDistance).toBeGreaterThan(
      change.metrics.originalSimulatedDistance,
    );

    const adapted = snapshotColors();
    expect(adapted.bad).toBe(change.adaptedValue);
    expect(adapted.bad).not.toBe(ORIGINAL.bad);
    // Everything else stays exactly as authored.
    expect({ ...adapted, bad: ORIGINAL.bad }).toEqual(ORIGINAL);

    controller.disableAdaptation();
    expect(snapshotColors()).toEqual(ORIGINAL);
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
  });

  it('counts a plan summary: unresolved and out-of-scope elements are never adapted', () => {
    const controller = createContentController(document, FROZEN_CLOCK);
    const { adaptation } = controller.enableAdaptation('https://example.com', DEUTAN);

    expect(adaptation.summary.adapted).toBe(1);
    // gradient + image (unsupported) + faded (opacity: effective color != computed color)
    expect(adaptation.summary.unresolved).toBe(3);
    // the disabled button is out of scope
    expect(adaptation.summary.skipped).toBeGreaterThanOrEqual(1);
    expect(adaptation.summary.problemsDetected).toBe(1);
  });

  it('does not modify gradient, image, partial (opacity) or disabled elements', () => {
    const controller = createContentController(document, FROZEN_CLOCK);
    controller.enableAdaptation('https://example.com', DEUTAN);
    const colors = snapshotColors();
    for (const id of ['gradient', 'image', 'faded', 'off', 'fine', 'green-ok'] as const) {
      expect(colors[id]).toBe(ORIGINAL[id]);
    }
  });

  it('is idempotent: re-enabling and re-analyzing an adapted page never compounds', () => {
    const controller = createContentController(document, FROZEN_CLOCK);
    const first = controller.enableAdaptation('https://example.com', DEUTAN);
    const adaptedOnce = snapshotColors();

    const second = controller.enableAdaptation('https://example.com', DEUTAN);
    const third = controller.enableAdaptation('https://example.com', DEUTAN);
    controller.analyze('https://example.com', DEUTAN);
    const refreshed = controller.enableAdaptation('https://example.com', DEUTAN);

    expect(second.adaptation.changes).toEqual(first.adaptation.changes);
    expect(third.adaptation.changes).toEqual(first.adaptation.changes);
    expect(refreshed.adaptation.changes).toEqual(first.adaptation.changes);
    expect(snapshotColors()).toEqual(adaptedOnce);
    // The analysis always sees the ORIGINAL foreground, never the adapted one.
    const bad = refreshed.analysis.elements.find(
      (el) => el.id === first.adaptation.changes[0]?.elementId,
    );
    expect(toHex(bad!.colorPair.foreground)).toBe(ORIGINAL.bad);
  });

  it('analyze() while adapted leaves the adaptation applied', () => {
    const controller = createContentController(document, FROZEN_CLOCK);
    controller.enableAdaptation('https://example.com', DEUTAN);
    const adapted = snapshotColors();
    controller.analyze('https://example.com', DEUTAN);
    expect(snapshotColors()).toEqual(adapted);
  });

  it('survives repeated enable/disable cycles with an exact restore every time', () => {
    const controller = createContentController(document, FROZEN_CLOCK);
    let firstAdapted: Record<string, string> | null = null;
    for (let cycle = 0; cycle < 6; cycle += 1) {
      controller.enableAdaptation('https://example.com', DEUTAN);
      const adapted = snapshotColors();
      firstAdapted ??= adapted;
      expect(adapted).toEqual(firstAdapted);

      controller.disableAdaptation();
      expect(snapshotColors()).toEqual(ORIGINAL);
      expect(document.querySelectorAll('#coloradapt-stylesheet')).toHaveLength(0);
    }
  });

  it('a fresh controller (e.g. after content-script reload) keeps working from original styles', () => {
    const first = createContentController(document, FROZEN_CLOCK);
    const plan = first.enableAdaptation('https://example.com', DEUTAN).adaptation;
    first.disableAdaptation();
    const second = createContentController(document, FROZEN_CLOCK);
    expect(second.enableAdaptation('https://example.com', DEUTAN).adaptation.changes).toEqual(
      plan.changes,
    );
  });

  it('switching profile re-plans from the original, not from the previous adaptation', () => {
    const controller = createContentController(document, FROZEN_CLOCK);
    controller.enableAdaptation('https://example.com', DEUTAN);
    const protan = controller.enableAdaptation('https://example.com', {
      ...DEUTAN,
      visionProfile: 'protanopia',
    });
    const direct = (() => {
      controller.disableAdaptation();
      return controller.enableAdaptation('https://example.com', {
        ...DEUTAN,
        visionProfile: 'protanopia',
      });
    })();
    expect(protan.adaptation.changes).toEqual(direct.adaptation.changes);
  });

  it('adapts nothing for normal vision, strength 0 or the custom profile', () => {
    const controller = createContentController(document, FROZEN_CLOCK);

    for (const settings of [
      { ...DEUTAN, visionProfile: 'normal' as const },
      { ...DEUTAN, adaptationStrength: 0 },
      { ...DEUTAN, visionProfile: 'custom' as const },
    ]) {
      const { adaptation } = controller.enableAdaptation('https://example.com', settings);
      expect(adaptation.changes).toHaveLength(0);
      expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
      expect(snapshotColors()).toEqual(ORIGINAL);
    }
  });

  it('strength 0.5 produces a different, intermediate color than strength 1', () => {
    const controller = createContentController(document, FROZEN_CLOCK);
    const full = controller.enableAdaptation('https://example.com', DEUTAN).adaptation.changes[0];
    const half = controller.enableAdaptation('https://example.com', {
      ...DEUTAN,
      adaptationStrength: 0.5,
    }).adaptation.changes[0];
    expect(half?.adaptedValue).toBeDefined();
    expect(half?.adaptedValue).not.toBe(full?.adaptedValue);
    expect(half?.metrics.changeDistance).toBeLessThan(full?.metrics.changeDistance ?? 0);
  });

  it('respects the master switch and per-site overrides', () => {
    const controller = createContentController(document, FROZEN_CLOCK);

    const globallyOff = resolveEffectiveSettings({ ...DEUTAN, enabled: false }, 'example.com');
    expect(
      controller.enableAdaptation('https://example.com', globallyOff).adaptation.changes,
    ).toHaveLength(0);

    const siteOff = resolveEffectiveSettings(
      {
        ...DEUTAN,
        siteOverrides: {
          'example.com': {
            hostname: 'example.com',
            enabled: false,
            visionProfile: 'deuteranopia',
            intensity: 1,
            adaptUI: true,
            adaptCharts: false,
            adaptImages: false,
          },
        },
      },
      'example.com',
    );
    expect(siteOff.enabled).toBe(false);
    expect(
      controller.enableAdaptation('https://example.com', siteOff).adaptation.changes,
    ).toHaveLength(0);
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
    expect(snapshotColors()).toEqual(ORIGINAL);
  });
});
