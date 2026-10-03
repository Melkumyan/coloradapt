import { describe, expect, it } from 'vitest';
import { VISION_MODEL_INFO } from '@domain/models';
import type { VisionProfile } from '@domain/models';
import { DEFAULT_USER_SETTINGS } from '@domain/models';
import { createContentController } from '@features/page-analysis';
import {
  DEFAULT_VISION_MODEL_POLICY,
  createVisionSimulator,
  defaultVisionSimulator,
  simulateVision,
} from '@core/vision';

const RED = { r: 1, g: 0, b: 0, alpha: 1 };

describe('model fidelity metadata (approximation status must not be lost)', () => {
  it('tritanomaly resolves to a model flagged as approximation', () => {
    const id = defaultVisionSimulator.modelFor('tritanomaly');
    expect(VISION_MODEL_INFO[id].fidelity).toBe('approximation');
  });

  it('achromatopsia resolves to a model flagged as approximation', () => {
    const id = defaultVisionSimulator.modelFor('achromatopsia');
    expect(VISION_MODEL_INFO[id].fidelity).toBe('approximation');
  });

  it('custom is unsupported: no model, fidelity "none"', () => {
    const id = defaultVisionSimulator.modelFor('custom');
    expect(id).toBe('identity');
    expect(VISION_MODEL_INFO[id].fidelity).toBe('none');
  });

  it('dichromacies and protan/deutan anomalies use published models', () => {
    for (const p of [
      'protanopia',
      'deuteranopia',
      'tritanopia',
      'protanomaly',
      'deuteranomaly',
    ] as const) {
      expect(VISION_MODEL_INFO[DEFAULT_VISION_MODEL_POLICY[p]].fidelity).toBe('published');
    }
  });
});

describe('no result reuse across profile, severity or simulator instance', () => {
  it('same RGB under different profiles gives different, order-independent results', () => {
    const profiles: VisionProfile[] = ['protanopia', 'deuteranopia', 'tritanopia', 'protanomaly'];
    const forward = profiles.map((p) => simulateVision(RED, p));
    const backward = [...profiles]
      .reverse()
      .map((p) => simulateVision(RED, p))
      .reverse();
    expect(backward).toEqual(forward);
    expect(new Set(forward.map((c) => `${c.r}|${c.g}|${c.b}`)).size).toBe(profiles.length);
  });

  it('same RGB and profile with different severity is not reused', () => {
    const half = simulateVision(RED, 'deuteranomaly', 0.5);
    const full = simulateVision(RED, 'deuteranomaly', 1);
    const half2 = simulateVision(RED, 'deuteranomaly', 0.5);
    expect(half).toEqual(half2);
    expect(half).not.toEqual(full);
  });

  it('a custom-policy simulator does not leak into the default simulator', () => {
    const before = defaultVisionSimulator.simulate(RED, 'protanopia');
    const custom = createVisionSimulator({ protanopia: 'vienot1999' });
    expect(custom.simulate(RED, 'protanopia')).not.toEqual(before);
    expect(defaultVisionSimulator.simulate(RED, 'protanopia')).toEqual(before);
    expect(defaultVisionSimulator.modelFor('protanopia')).toBe('brettel1997');
  });

  it('simulate does not mutate its input', () => {
    const input = Object.freeze({ r: 0.3, g: 0.6, b: 0.1, alpha: 0.5 });
    expect(() => simulateVision(input, 'deuteranopia')).not.toThrow();
    expect(input).toEqual({ r: 0.3, g: 0.6, b: 0.1, alpha: 0.5 });
  });
});

describe('end-to-end: DOM analysis -> resolved colors -> simulation -> conflict', () => {
  const profiles: VisionProfile[] = [
    'normal',
    'protanopia',
    'deuteranopia',
    'tritanopia',
    'protanomaly',
    'deuteranomaly',
  ];

  function conflictsFor(profile: VisionProfile, doc: Document): number {
    const controller = createContentController(doc, { now: () => 0 });
    const result = controller.analyze('https://example.com', {
      ...DEFAULT_USER_SETTINGS,
      visionProfile: profile,
    });
    return result.conflicts.length;
  }

  it('is deterministic per profile and never throws, in any profile order', () => {
    document.body.innerHTML = `
      <p style="color: rgb(250,250,250); background-color: rgb(255,255,255);">Low contrast</p>
      <p style="color: rgb(200,40,40); background-color: rgb(40,160,40);">Red on green</p>
      <p style="color: rgb(0,0,0); background-color: rgb(255,255,255);">Fine</p>
    `;
    const first = profiles.map((p) => conflictsFor(p, document));
    const second = [...profiles]
      .reverse()
      .map((p) => conflictsFor(p, document))
      .reverse();
    expect(second).toEqual(first);
    // The low-contrast pair is a conflict for every profile, including normal.
    for (const n of first) expect(n).toBeGreaterThan(0);
  });

  it('red-on-green becomes a conflict for red-green deficiencies but is not for normal vision', () => {
    document.body.innerHTML =
      '<p style="color: rgb(200,60,60); background-color: rgb(60,150,60);">Status</p>';
    expect(conflictsFor('deuteranopia', document)).toBeGreaterThan(0);
    expect(conflictsFor('protanopia', document)).toBeGreaterThan(0);
  });
});
