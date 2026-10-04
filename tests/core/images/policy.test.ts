import { describe, expect, it } from 'vitest';
import type { ImageConfidence, ImageKind, ImageReadability, VisionProfile } from '@domain/models';
import { decideImage, gateBeforeRead, type ImageFacts } from '@core/images';
import { makeFacts } from './facts';

function decide(
  kind: ImageKind,
  confidence: ImageConfidence,
  facts: Partial<ImageFacts> = {},
  readability: ImageReadability = 'readable',
  profile: VisionProfile = 'deuteranopia',
) {
  return decideImage({
    facts: makeFacts(facts),
    classification: { kind, confidence, evidence: [] },
    readability,
    adaptImages: true,
    profile,
  });
}

describe('decideImage: the default is "leave it alone"', () => {
  it.each([
    ['photograph', 'photograph'],
    ['logo', 'logo'],
    ['screenshot', 'screenshot'],
    ['illustration', 'illustration'],
    ['complex-artwork', 'complex-artwork'],
    ['ui-raster', 'ui-raster'],
    ['status-graphic', 'status-defers-to-semantics'],
  ] as const)('%s is unchanged (%s), whatever the confidence', (kind, reason) => {
    for (const confidence of ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as const) {
      expect(decide(kind, confidence)).toEqual({ action: 'unchanged', reason, candidate: false });
    }
  });

  it('raster charts and diagrams are detected and unsupported, never recolored', () => {
    expect(decide('chart-raster', 'HIGH')).toMatchObject({
      action: 'unsupported',
      reason: 'chart-raster',
    });
    expect(decide('diagram', 'HIGH')).toMatchObject({ action: 'unsupported', reason: 'diagram' });
  });

  it('unknown and low-confidence icons are unchanged', () => {
    expect(decide('unknown', 'UNKNOWN').candidate).toBe(false);
    expect(decide('monochrome-icon', 'MEDIUM')).toMatchObject({
      action: 'unchanged',
      reason: 'low-confidence',
    });
    expect(decide('monochrome-icon', 'LOW').candidate).toBe(false);
  });

  it('only a HIGH monochrome icon with a replaceable source is a candidate', () => {
    expect(decide('monochrome-icon', 'HIGH')).toMatchObject({ candidate: true });
    const candidates = (
      [
        'photograph',
        'logo',
        'screenshot',
        'illustration',
        'ui-raster',
        'unknown',
        'decorative',
      ] as const
    ).map((kind) => decide(kind, 'HIGH').candidate);
    expect(candidates.every((candidate) => !candidate)).toBe(true);
  });
});

describe('decideImage: readability', () => {
  it('a tainted canvas means no pixel analysis and no transformation', () => {
    expect(decide('monochrome-icon', 'HIGH', {}, 'tainted')).toMatchObject({
      action: 'unsupported',
      reason: 'unreadable',
      candidate: false,
    });
  });
  it('broken and not-yet-loaded images are not decided on', () => {
    expect(decide('unknown', 'UNKNOWN', {}, 'unavailable').reason).toBe('unavailable');
    expect(decide('unknown', 'UNKNOWN', {}, 'not-loaded').action).toBe('pending');
  });
});

describe('decideImage: a functional icon the page presents in a way we cannot replace', () => {
  it.each([
    ['svg source', { format: 'svg' as const }, 'svg-source'],
    ['gif', { format: 'gif' as const }, 'animated'],
    ['srcset/picture', { responsive: true }, 'responsive-source'],
    ['usemap', { imageMap: true }, 'image-map'],
    ['css filter/mask/blend', { cssEffects: true }, 'css-effects'],
    ['input type=image', { source: 'input-image' as const }, 'input-image'],
    ['unknown url scheme', { srcKind: 'other' as const }, 'format-unknown'],
    ['too big for an icon', { naturalWidth: 400, naturalHeight: 400 }, 'too-large'],
  ])('%s -> unsupported (%s)', (_name, facts, reason) => {
    expect(decide('monochrome-icon', 'HIGH', facts)).toMatchObject({
      action: 'unsupported',
      reason,
      candidate: false,
    });
  });
});

describe('gateBeforeRead: refusals that cost no pixel read', () => {
  const gate = (
    over: Partial<ImageFacts> = {},
    adapt = true,
    profile: VisionProfile = 'deuteranopia',
    loaded: 'loaded' | 'loading' | 'broken' = 'loaded',
    decorative = false,
  ) => gateBeforeRead(makeFacts(over), adapt, profile, loaded, decorative);

  it('passes an ordinary loaded image', () => {
    expect(gate()).toBeNull();
  });
  it('stops at the switch, css backgrounds, decoration and normal vision', () => {
    expect(gate({}, false)).toMatchObject({ reason: 'adapt-images-off' });
    expect(gate({ source: 'css-background' })).toMatchObject({
      action: 'unsupported',
      reason: 'css-background',
    });
    expect(gate({}, true, 'deuteranopia', 'loaded', true)).toMatchObject({ reason: 'decorative' });
    expect(gate({}, true, 'normal')).toMatchObject({
      action: 'not-needed',
      reason: 'normal-vision',
    });
  });
  it('waits for loading images and refuses broken or absurdly large ones', () => {
    expect(gate({}, true, 'deuteranopia', 'loading')).toMatchObject({ action: 'pending' });
    expect(gate({}, true, 'deuteranopia', 'broken')).toMatchObject({ reason: 'unavailable' });
    expect(gate({ naturalWidth: 9000, naturalHeight: 9000 })).toMatchObject({
      reason: 'too-large',
    });
  });
});
