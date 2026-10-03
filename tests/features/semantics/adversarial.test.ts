import { afterEach, describe, expect, it } from 'vitest';
import { ADVERSARIAL_CSS, ADVERSARIAL_SCENARIOS } from './adversarial-scenarios';
import { $, cueOf, describeCue, mount, teardown } from './kit';

/**
 * M6.R1 adversarial benchmark in jsdom (docs/SEMANTIC_ACCESSIBILITY.md, "Adversarial benchmark").
 * The same scenarios run in real Chromium in e2e/semantic-adversarial.spec.ts.
 *
 * Hard gate: not one automatic cue on an element the scenario does not expect one on, and not
 * one cue without HIGH confidence. A missing cue is a report line, never a failure of safety.
 */
afterEach(teardown);

function cueText(selector: string): string | null {
  return describeCue(cueOf(selector));
}

describe('M6.R1 adversarial benchmark', () => {
  it('is the size and mix the milestone asks for', () => {
    expect(ADVERSARIAL_SCENARIOS.length).toBeGreaterThanOrEqual(100);
    const categories = new Set(ADVERSARIAL_SCENARIOS.map((s) => s.category));
    for (const category of [
      'true-positive',
      'true-negative',
      'ambiguous',
      'conflict',
      'accessible',
      'trap',
      'peers',
      'token',
    ] as const) {
      expect(categories.has(category), category).toBe(true);
    }
    const langs = new Set(ADVERSARIAL_SCENARIOS.map((s) => s.lang));
    expect(langs.has('en') && langs.has('ru') && langs.has('neutral')).toBe(true);
    const names = ADVERSARIAL_SCENARIOS.map((s) => s.name);
    expect(new Set(names).size, 'unique names').toBe(names.length);
  });

  for (const scenario of ADVERSARIAL_SCENARIOS) {
    it(`${scenario.category}/${scenario.lang}: ${scenario.name}`, () => {
      const rig = mount(scenario.html, ADVERSARIAL_CSS);
      for (const [selector, expected] of Object.entries(scenario.expect)) {
        const { result } = rig.controller.inspectSemantics($(selector));
        expect(result.status, `${selector} status`).toBe(expected.status);
        if (result.status === 'classified') {
          if (expected.state) expect(result.state, `${selector} state`).toBe(expected.state);
          if (expected.confidence) {
            expect(result.confidence, `${selector} confidence`).toBe(expected.confidence);
          }
        }
        expect(cueText(selector), `${selector} cue`).toBe(expected.cue);
      }
    });
  }

  it('summary: pinned totals, zero false positives, no cue without HIGH confidence', () => {
    const totals = {
      scenarios: ADVERSARIAL_SCENARIOS.length,
      elements: 0,
      classified: 0,
      unknown: 0,
      conflicts: 0,
      autoCues: 0,
      falsePositives: 0,
      falseNegatives: 0,
      alreadyAccessibleSkipped: 0,
    };
    for (const scenario of ADVERSARIAL_SCENARIOS) {
      const rig = mount(scenario.html, ADVERSARIAL_CSS);
      for (const [selector, expected] of Object.entries(scenario.expect)) {
        const { result, decision } = rig.controller.inspectSemantics($(selector));
        totals.elements += 1;
        if (result.status === 'classified') totals.classified += 1;
        else if (result.status === 'unknown') totals.unknown += 1;
        else totals.conflicts += 1;
        const actual = cueText(selector);
        if (actual !== null) totals.autoCues += 1;
        // A false positive: a cue that is not expected, or one the evidence cannot carry.
        if (actual !== null && actual !== expected.cue) totals.falsePositives += 1;
        if (actual !== null && (result.status !== 'classified' || result.confidence !== 'high')) {
          totals.falsePositives += 1;
        }
        if (decision.action === 'cue' && expected.cue === null) totals.falsePositives += 1;
        // A false negative is only meaningful where a high-confidence semantic was curated.
        if (scenario.curatedPositive && expected.cue !== null && actual === null) {
          totals.falseNegatives += 1;
        }
        if (
          decision.action === 'none' &&
          (decision.reason === 'not-color-only' || decision.reason === 'no-safe-placement')
        ) {
          totals.alreadyAccessibleSkipped += 1;
        }
      }
      teardown();
    }
    expect(totals.falsePositives).toBe(0);
    expect(totals.falseNegatives).toBe(0);
    expect(totals).toMatchInlineSnapshot(`
      {
        "alreadyAccessibleSkipped": 37,
        "autoCues": 28,
        "classified": 94,
        "conflicts": 10,
        "elements": 172,
        "falseNegatives": 0,
        "falsePositives": 0,
        "scenarios": 144,
        "unknown": 68,
      }
    `);
  });
});
