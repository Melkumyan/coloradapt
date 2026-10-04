import { describe, expect, it } from 'vitest';
import { analyzePixels, classifyImage, isDecorative, tokenize } from '@core/images';
import { makeFacts, sized } from './facts';
import { flatLogo, hex, monoIcon, photograph, rasterBarChart, screenshot } from './pixels';

describe('tokenize', () => {
  it('splits on non-letters, keeps Cyrillic, lower-cases', () => {
    expect(tokenize('btn-Icon_error  ГРАФИК.png')).toEqual([
      'btn',
      'icon',
      'error',
      'график',
      'png',
    ]);
  });
});

describe('decorative images', () => {
  it.each([
    ['alt=""', { alt: '' }],
    ['role=presentation', { role: 'presentation' }],
    ['role=none', { role: 'none' }],
    ['aria-hidden', { ariaHidden: true }],
  ])('%s is decorative with HIGH confidence, whatever the pixels are', (_name, facts) => {
    const f = makeFacts(facts);
    expect(isDecorative(f)).toBe(true);
    const result = classifyImage(f, analyzePixels(monoIcon(24, hex('#d62728'))));
    expect(result).toMatchObject({ kind: 'decorative', confidence: 'HIGH' });
  });

  it('an input of type image is never decorative because of alt=""', () => {
    expect(isDecorative(makeFacts({ source: 'input-image', alt: '' }))).toBe(false);
  });
});

describe('photographs', () => {
  it('are recognized from pixel statistics alone, without any text', () => {
    const facts = makeFacts(sized(96, 96));
    const result = classifyImage(facts, analyzePixels(photograph(96, 96, 5)));
    expect(result).toMatchObject({ kind: 'photograph', confidence: 'HIGH' });
  });

  it('are recognized even when the alt text says something else', () => {
    const facts = makeFacts({ ...sized(96, 96), alt: 'chart', labelTokens: ['chart'] });
    expect(classifyImage(facts, analyzePixels(photograph(96, 96, 5))).kind).toBe('photograph');
  });

  it('never become icons because a token says "icon"', () => {
    const facts = makeFacts({ ...sized(96, 96), ownTokens: ['icon'] });
    expect(classifyImage(facts, analyzePixels(photograph(96, 96, 9))).kind).toBe('photograph');
  });
});

describe('logos', () => {
  const stats = analyzePixels(monoIcon(32, hex('#d62728')));

  it('a logo token on the image is HIGH, around it MEDIUM, a home link MEDIUM', () => {
    expect(classifyImage(makeFacts({ ownTokens: ['site', 'logo'] }), stats)).toMatchObject({
      kind: 'logo',
      confidence: 'HIGH',
    });
    expect(classifyImage(makeFacts({ contextTokens: ['brand'] }), stats)).toMatchObject({
      kind: 'logo',
      confidence: 'MEDIUM',
    });
    expect(classifyImage(makeFacts({ linksHome: true }), stats)).toMatchObject({
      kind: 'logo',
      confidence: 'MEDIUM',
    });
  });

  it('a logo token in the alt text counts as on the image', () => {
    expect(classifyImage(makeFacts({ labelTokens: ['acme', 'logo'] }), stats).kind).toBe('logo');
  });

  it('flat multi-color artwork without tokens is not an icon', () => {
    const facts = makeFacts(sized(200, 80));
    const art = flatLogo(200, 80, [hex('#d62728'), hex('#2b6cb0')]);
    const result = classifyImage(facts, analyzePixels(art));
    expect(result.kind).not.toBe('monochrome-icon');
    expect(result.confidence).not.toBe('HIGH');
  });
});

describe('charts and screenshots', () => {
  const chart = rasterBarChart(240, 140, [hex('#d62728'), hex('#2ca02c'), hex('#1f77b4')]);

  it('a raster bar chart is detected from structure alone (MEDIUM), HIGH with a chart token', () => {
    const stats = analyzePixels(chart);
    const bare = classifyImage(makeFacts(sized(240, 140)), stats);
    expect(bare).toMatchObject({ kind: 'chart-raster', confidence: 'MEDIUM' });
    const tagged = classifyImage(
      makeFacts({ ...sized(240, 140), ownTokens: ['sales', 'chart'] }),
      stats,
    );
    expect(tagged).toMatchObject({ kind: 'chart-raster', confidence: 'HIGH' });
  });

  it('a chart token is recognized even when the pixels cannot be read', () => {
    expect(classifyImage(makeFacts({ labelTokens: ['график'] }), null)).toMatchObject({
      kind: 'chart-raster',
      confidence: 'MEDIUM',
    });
    expect(classifyImage(makeFacts({}), null)).toMatchObject({
      kind: 'unknown',
      confidence: 'UNKNOWN',
    });
  });

  it('screenshots are neither icons nor charts', () => {
    const stats = analyzePixels(screenshot(640, 360, 4));
    const result = classifyImage(makeFacts(sized(640, 360)), stats);
    expect(['screenshot', 'photograph', 'illustration', 'complex-artwork']).toContain(result.kind);
    const tagged = classifyImage(
      makeFacts({ ...sized(640, 360), ownTokens: ['screenshot'] }),
      stats,
    );
    expect(tagged).toMatchObject({ kind: 'screenshot', confidence: 'HIGH' });
  });
});

describe('functional icons', () => {
  const red = analyzePixels(monoIcon(24, hex('#d62728'), false));

  it('a small one-paint transparent bitmap with an icon token is a HIGH monochrome icon', () => {
    const result = classifyImage(makeFacts({ ownTokens: ['icon', 'alert'] }), red);
    expect(result).toMatchObject({ kind: 'monochrome-icon', confidence: 'HIGH' });
    expect(result.evidence.length).toBeGreaterThan(1);
  });

  it('needs positive functional evidence: a control-like name, or an icon class when unnamed', () => {
    expect(
      classifyImage(makeFacts({ alt: 'Delete', labelTokens: ['delete'] }), red).confidence,
    ).toBe('HIGH');
    expect(classifyImage(makeFacts({ ownTokens: ['btn', 'icon'] }), red).confidence).toBe('HIGH');
    expect(
      classifyImage(
        makeFacts({ alt: 'Acme', labelTokens: ['acme'], ownTokens: ['icon'], interactive: true }),
        red,
      ),
    ).toMatchObject({ kind: 'monochrome-icon', confidence: 'MEDIUM' });
  });

  it('a button or a link around it is not evidence of function', () => {
    expect(classifyImage(makeFacts({ interactive: true }), red).confidence).toBe('MEDIUM');
    expect(
      classifyImage(makeFacts({ interactive: true, alt: 'Acme', labelTokens: ['acme'] }), red)
        .confidence,
    ).toBe('MEDIUM');
  });

  it('without any functional context it is only MEDIUM (and therefore never recolored)', () => {
    expect(classifyImage(makeFacts({}), red)).toMatchObject({
      kind: 'monochrome-icon',
      confidence: 'MEDIUM',
    });
  });

  it('a status token turns it into a status graphic, which defers to M6', () => {
    expect(classifyImage(makeFacts({ ownTokens: ['status', 'error'] }), red).kind).toBe(
      'status-graphic',
    );
    expect(classifyImage(makeFacts({ contextTokens: ['status'] }), red)).toMatchObject({
      kind: 'status-graphic',
      confidence: 'MEDIUM',
    });
  });

  it('an icon with two chromatic paints is a UI raster, not a monochrome icon', () => {
    const buffer = monoIcon(24, hex('#d62728'), false);
    for (let y = 8; y < 16; y += 1) {
      for (let x = 8; x < 16; x += 1) buffer.data.set(hex('#2b6cb0'), (y * 24 + x) * 4);
    }
    const result = classifyImage(makeFacts({ ownTokens: ['icon'] }), analyzePixels(buffer));
    expect(result.kind).toBe('ui-raster');
    expect(result.confidence).not.toBe('HIGH');
  });

  it('an opaque small bitmap is not transparent-icon evidence', () => {
    const opaque = analyzePixels(flatLogo(24, 24, [hex('#d62728')]));
    expect(classifyImage(makeFacts({ ownTokens: ['icon'] }), opaque).kind).not.toBe(
      'monochrome-icon',
    );
  });
});
