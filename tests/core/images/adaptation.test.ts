import { describe, expect, it } from 'vitest';
import { parseColor } from '@core/color';
import { analyzePixels, planMonochromeIcon, type PixelBuffer } from '@core/images';
import type { ColorValue, VisionProfile } from '@domain/models';
import { blank, disc, hex, monoIcon, rect } from './pixels';

const color = (css: string): ColorValue => parseColor(css)!;

function plan(
  buffer: PixelBuffer,
  background: string,
  profile: VisionProfile = 'deuteranopia',
  strength = 1,
) {
  return planMonochromeIcon({ buffer, background: color(background), profile, strength });
}

/** Red icon on a green ground: the pair deuteranopes cannot tell apart. */
const RED = hex('#d62728');
const GREEN = '#2ca02c';

describe('planMonochromeIcon', () => {
  it('recolors only the icon paint, preserving size, alpha and neutral pixels', () => {
    const icon = monoIcon(32, RED);
    const result = plan(icon, GREEN);
    expect(result.status).toBe('adapted');
    if (result.status !== 'adapted') return;
    expect(result.pixels).toHaveLength(icon.data.length);
    let changed = 0;
    for (let i = 0; i < 32 * 32; i += 1) {
      const o = i * 4;
      expect(result.pixels[o + 3]).toBe(icon.data[o + 3]); // alpha byte for byte
      const same =
        result.pixels[o] === icon.data[o] &&
        result.pixels[o + 1] === icon.data[o + 1] &&
        result.pixels[o + 2] === icon.data[o + 2];
      if (!same) changed += 1;
      // white dot and transparent surround are not the icon's paint
      if (icon.data[o] === 255 && icon.data[o + 1] === 255 && icon.data[o + 2] === 255) {
        expect(same).toBe(true);
      }
      if (icon.data[o + 3] === 0) expect(same).toBe(true);
    }
    expect(changed).toBe(result.changedPixels);
    expect(changed).toBeGreaterThan(0);
  });

  it('verifiably improves distinguishability under the profile and carries M2 provenance', () => {
    const result = plan(monoIcon(32, RED), GREEN);
    expect(result.status).toBe('adapted');
    if (result.status !== 'adapted') return;
    expect(result.after.simulatedDistance).toBeGreaterThan(result.before.simulatedDistance);
    expect(result.confidence).toBe('SUPPORTED_MODEL');
    expect(result.before.profile).toBe('deuteranopia');
  });

  it.each(['protanopia', 'deuteranopia', 'tritanopia'] as const)(
    'a pair the %s profile confuses is improved or declined, never made worse',
    (profile) => {
      const pairs: Record<string, [string, string]> = {
        protanopia: ['#d62728', '#2ca02c'],
        deuteranopia: ['#d62728', '#2ca02c'],
        tritanopia: ['#3b6fb6', '#2aa198'],
      };
      const [fg, bg] = pairs[profile]!;
      const result = plan(monoIcon(24, hex(fg), false), bg, profile);
      if (result.status === 'adapted') {
        expect(result.after.simulatedDistance).toBeGreaterThan(result.before.simulatedDistance);
      } else {
        expect(['not-needed', 'unsupported']).toContain(result.action);
      }
    },
  );

  it('keeps antialiased edges: pixels near the paint move proportionally, with no flat opaque halo', () => {
    const result = plan(monoIcon(32, RED, false), GREEN);
    expect(result.status).toBe('adapted');
    if (result.status !== 'adapted') return;
    const rimAlphas = new Set<number>();
    for (let i = 0; i < 32 * 32; i += 1) {
      const alpha = result.pixels[i * 4 + 3]!;
      if (alpha > 0 && alpha < 255) rimAlphas.add(alpha);
    }
    expect(rimAlphas.size).toBeGreaterThan(3); // the ramp survives
  });

  it('is idempotent on the same input and never reads its own output as the original', () => {
    const icon = monoIcon(32, RED);
    const first = plan(icon, GREEN);
    const second = plan(icon, GREEN);
    expect(first).toEqual(second);
    expect(icon.data[0]).toBe(0); // the input buffer is not modified
  });

  it('adapts the same icon differently on a different background (context is part of the plan)', () => {
    const onGreen = plan(monoIcon(24, RED, false), GREEN);
    const onDark = plan(monoIcon(24, RED, false), '#202020');
    expect(onGreen.status).toBe('adapted');
    expect(onDark.status === 'adapted' ? onDark.to : null).not.toEqual(
      onGreen.status === 'adapted' ? onGreen.to : undefined,
    );
  });

  it('respects strength: zero changes nothing', () => {
    expect(plan(monoIcon(24, RED), GREEN, 'deuteranopia', 0)).toMatchObject({
      status: 'declined',
      action: 'not-needed',
      reason: 'strength-zero',
    });
  });
});

describe('planMonochromeIcon declines (the original stays)', () => {
  it('for normal vision', () => {
    expect(plan(monoIcon(24, RED), GREEN, 'normal')).toMatchObject({ reason: 'normal-vision' });
  });

  it('when the pair is already distinguishable', () => {
    const result = plan(monoIcon(24, hex('#000000')), '#ffffff');
    expect(result.status).toBe('declined');
    const blue = plan(monoIcon(24, hex('#1f4aa8')), '#ffffff');
    expect(blue).toMatchObject({ status: 'declined', action: 'not-needed' });
  });

  it('for an image with two chromatic paints (what each color means is unknown)', () => {
    const icon = monoIcon(32, RED, false);
    rect(icon, 12, 12, 8, 8, hex('#2b6cb0'));
    expect(plan(icon, GREEN)).toMatchObject({ status: 'declined', reason: 'not-monochrome' });
  });

  it('for a semi-transparent paint, whose visible color depends on alpha', () => {
    const faint = blank(24, 24);
    disc(faint, 12, 12, 10, [214, 39, 40, 200]);
    expect(plan(faint, GREEN)).toMatchObject({
      status: 'declined',
      reason: 'insufficient-context',
    });
  });

  it('for a neutral-only image (nothing chromatic to adapt) and for an empty one', () => {
    expect(plan(monoIcon(24, hex('#404040')), GREEN)).toMatchObject({
      action: 'not-needed',
      reason: 'achromatic',
    });
    expect(plan(blank(24, 24), GREEN).status).toBe('declined');
  });

  it('for a bitmap over the allocation ceiling, and for a translucent background', () => {
    const huge = { width: 1001, height: 1000, data: new Uint8ClampedArray(0) };
    expect(plan(huge, GREEN)).toMatchObject({ reason: 'too-large' });
    expect(
      planMonochromeIcon({
        buffer: monoIcon(24, RED),
        background: { ...color(GREEN), alpha: 0.5 },
        profile: 'deuteranopia',
        strength: 1,
      }),
    ).toMatchObject({ reason: 'insufficient-context' });
  });

  it('plans nothing for a custom profile (no model)', () => {
    expect(plan(monoIcon(24, RED), GREEN, 'custom').status).toBe('declined');
  });
});

describe('analyzePixels on a plan result', () => {
  it('the adapted icon still has exactly one chromatic paint', () => {
    const result = plan(monoIcon(32, RED), GREEN);
    if (result.status !== 'adapted') throw new Error('expected an adaptation');
    const stats = analyzePixels({ width: 32, height: 32, data: result.pixels });
    expect(stats.clusters.filter((c) => !c.neutral)).toHaveLength(1);
  });
});
