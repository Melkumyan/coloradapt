import { describe, expect, it } from 'vitest';
import {
  generateStage,
  oklabToValidColor,
  oklchToValidColor,
  scoreCandidate,
  searchStagesFor,
  weightedDesignChange,
  type SearchStage,
} from '@core/adaptation';
import { convertColor, parseColor, toHex } from '@core/color';

function oklchOf(css: string) {
  return convertColor(parseColor(css)!);
}

describe('oklchToValidColor (gamut policy)', () => {
  it('returns an in-gamut, 8-bit, opaque color for an out-of-gamut request', () => {
    const color = oklchToValidColor(0.5, 0.45, 145);
    expect(color).not.toBeNull();
    for (const channel of [color!.r, color!.g, color!.b]) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
      expect(Math.abs(channel * 255 - Math.round(channel * 255))).toBeLessThan(1e-9);
    }
    expect(color!.alpha).toBe(1);
  });

  it('keeps lightness and hue when reducing chroma (no per-channel hue shift)', () => {
    const color = oklchToValidColor(0.6, 0.5, 30)!;
    const back = convertColor(color);
    expect(back.l).toBeCloseTo(0.6, 1);
    expect(Math.abs(back.h - 30)).toBeLessThan(6);
    expect(back.c).toBeLessThan(0.5);
  });

  it('clamps lightness and rejects non-finite input', () => {
    expect(toHex(oklchToValidColor(1.4, 0.1, 10)!)).toBe('#ffffff');
    expect(toHex(oklchToValidColor(-0.3, 0.1, 10)!)).toBe('#000000');
    expect(oklchToValidColor(Number.NaN, 0.1, 10)).toBeNull();
    expect(oklchToValidColor(0.5, Number.POSITIVE_INFINITY, 10)).toBeNull();
    expect(oklabToValidColor(0.5, Number.NaN, 0)).toBeNull();
  });

  it('is deterministic', () => {
    expect(oklchToValidColor(0.7, 0.4, 200)).toEqual(oklchToValidColor(0.7, 0.4, 200));
  });
});

describe('generateStage', () => {
  const original = oklchOf('#c0392b');

  it('is deterministic and de-duplicated, and never yields the original', () => {
    const seenA = new Set([toHex(parseColor('#c0392b')!)]);
    const seenB = new Set(seenA);
    const a = generateStage('lightness-chroma', original, seenA);
    const b = generateStage('lightness-chroma', original, seenB);
    expect(a.map((c) => c.hex)).toEqual(b.map((c) => c.hex));
    expect(new Set(a.map((c) => c.hex)).size).toBe(a.length);
    expect(a.map((c) => c.hex)).not.toContain('#c0392b');
  });

  it('does not repeat candidates across stages when sharing the seen set', () => {
    const seen = new Set<string>();
    const first = generateStage('lightness-chroma', original, seen).map((c) => c.hex);
    const second = generateStage('small-hue', original, seen).map((c) => c.hex);
    expect(second.some((hex) => first.includes(hex))).toBe(false);
  });

  it('stays bounded: every stage is a small fixed grid', () => {
    const sizes = (['lightness-chroma', 'small-hue', 'wide-hue'] as SearchStage[]).map(
      (stage) => generateStage(stage, original, new Set()).length,
    );
    expect(sizes[0]).toBeLessThanOrEqual(93);
    expect(sizes[1]).toBeLessThanOrEqual(306);
    expect(sizes[2]).toBeLessThanOrEqual(374);
  });

  it('keeps the hue in the lightness/chroma stage', () => {
    for (const candidate of generateStage('lightness-chroma', original, new Set())) {
      const { h, c } = convertColor(candidate.color);
      if (c > 0.05) expect(Math.abs(((h - original.h + 540) % 360) - 180)).toBeLessThan(8);
    }
  });

  it('only searches lightness for neutral colors and small hue for near-neutral ones', () => {
    expect(searchStagesFor(oklchOf('#808080'))).toEqual(['lightness-chroma']);
    expect(searchStagesFor(oklchOf('#000000'))).toEqual(['lightness-chroma']);
    expect(searchStagesFor(oklchOf('#ffffff'))).toEqual(['lightness-chroma']);
  });
});

describe('scoring policy', () => {
  const base = {
    originalSimulatedDistance: 0.05,
    candidateSimulatedDistance: 0.2,
    targetSimulatedDistance: 0.18,
    originalContrast: 2,
    candidateContrast: 2,
    weightedDesignChange: 0.1,
    maxDesignChange: 0.3,
    confidence: 'SUPPORTED_MODEL' as const,
  };

  it('saturates the benefit at the target: extra distance is not rewarded', () => {
    const atTarget = scoreCandidate({ ...base, candidateSimulatedDistance: 0.18 });
    const beyond = scoreCandidate({ ...base, candidateSimulatedDistance: 0.6 });
    expect(beyond.score).toBe(atTarget.score);
    expect(atTarget.benefit).toBe(1);
  });

  it('prefers the smaller design change when both reach the target', () => {
    const small = scoreCandidate({ ...base, weightedDesignChange: 0.05 });
    const large = scoreCandidate({ ...base, weightedDesignChange: 0.2 });
    expect(small.score).toBeGreaterThan(large.score);
  });

  it('penalizes contrast loss', () => {
    const kept = scoreCandidate(base);
    const lost = scoreCandidate({ ...base, candidateContrast: 1.8 });
    expect(lost.score).toBeLessThan(kept.score);
    expect(lost.contrastPenalty).toBeGreaterThan(0);
  });

  it('penalizes weaker models more for the same change', () => {
    const supported = scoreCandidate(base).score;
    const assumption = scoreCandidate({ ...base, confidence: 'MODEL_ASSUMPTION' }).score;
    const approximation = scoreCandidate({ ...base, confidence: 'APPROXIMATION' }).score;
    expect(supported).toBeGreaterThan(assumption);
    expect(assumption).toBeGreaterThan(approximation);
  });

  it('weights hue shifts above equal lightness shifts, and ignores hue for neutrals', () => {
    const red = oklchOf('#c0392b');
    const lighter = { ...red, l: red.l + 0.05 };
    // A hue rotation whose plain chord length equals the 0.05 lightness shift.
    const rotated = { ...red, h: red.h + (2 * Math.asin(0.05 / (2 * red.c)) * 180) / Math.PI };
    expect(weightedDesignChange(red, rotated)).toBeGreaterThan(weightedDesignChange(red, lighter));

    const gray = oklchOf('#808080');
    expect(weightedDesignChange(gray, { ...gray, h: gray.h + 120 })).toBeCloseTo(0, 6);
  });
});
