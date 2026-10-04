import { describe, expect, it } from 'vitest';
import { analyzeClusterPairs, analyzePixels } from '@core/images';
import { IMAGE_LIMITS } from '@shared/constants';
import { blank, disc, flatLogo, hex, monoIcon, photograph, rect } from './pixels';

describe('analyzePixels', () => {
  it('finds the two paints of a two-color image and nothing else', () => {
    const buffer = blank(40, 40, hex('#ffffff'));
    rect(buffer, 0, 0, 20, 40, hex('#d62728'));
    rect(buffer, 20, 0, 20, 40, hex('#2ca02c'));
    const stats = analyzePixels(buffer);
    expect(stats.clusters).toHaveLength(2);
    expect(stats.clusters.map((c) => c.neutral)).toEqual([false, false]);
    expect(stats.clusters[0]!.share).toBeCloseTo(0.5, 2);
    expect(stats.noiseShare).toBe(0);
  });

  it('does not treat antialiased rims as new colors', () => {
    const stats = analyzePixels(monoIcon(32, hex('#d62728'), false));
    const chromatic = stats.clusters.filter((cluster) => !cluster.neutral);
    expect(chromatic).toHaveLength(1);
    expect(stats.transparentShare).toBeGreaterThan(0.2);
  });

  it('never reads a transparent pixel as black', () => {
    const stats = analyzePixels(blank(16, 16, [0, 0, 0, 0]));
    expect(stats.visiblePixels).toBe(0);
    expect(stats.clusters).toHaveLength(0);
    expect(stats.transparentShare).toBe(1);
    // A black pixel at alpha 0 next to a red one at full alpha: only the red one counts.
    const mixed = blank(8, 8, [0, 0, 0, 0]);
    rect(mixed, 0, 0, 4, 8, hex('#ff0000'));
    const mixedStats = analyzePixels(mixed);
    expect(mixedStats.clusters).toHaveLength(1);
    expect(mixedStats.clusters[0]!.neutral).toBe(false);
  });

  it('drops pixel noise below the noise share and reports it', () => {
    const buffer = blank(50, 50, hex('#ffffff'));
    rect(buffer, 0, 0, 50, 49, hex('#2b6cb0'));
    rect(buffer, 0, 49, 3, 1, hex('#e53e3e')); // 3 of 2500 pixels
    const stats = analyzePixels(buffer);
    expect(stats.clusters.some((c) => !c.neutral && c.color.r > 0.8)).toBe(false);
    expect(stats.noiseShare).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const buffer = photograph(64, 64, 7);
    const first = analyzePixels(buffer);
    const second = analyzePixels({ ...buffer, data: new Uint8ClampedArray(buffer.data) });
    expect(second).toEqual(first);
  });

  it('keeps at most the structural number of clusters', () => {
    const stats = analyzePixels(photograph(96, 96, 3));
    expect(stats.clusters.length).toBeLessThanOrEqual(IMAGE_LIMITS.maxClusters);
  });

  it('tells a photograph from flat art by color cells and entropy', () => {
    const photo = analyzePixels(photograph(96, 96, 11));
    const logo = analyzePixels(flatLogo(96, 48, [hex('#d62728'), hex('#2b6cb0')]));
    expect(photo.distinctCells).toBeGreaterThan(140);
    expect(photo.entropyBits).toBeGreaterThan(6.2);
    expect(logo.distinctCells).toBeLessThan(10);
    expect(logo.flatShare).toBeGreaterThan(0.9);
  });

  it('handles a disc on transparency (shares add up over visible pixels)', () => {
    const buffer = blank(30, 30);
    disc(buffer, 15, 15, 12, hex('#d62728'));
    const stats = analyzePixels(buffer);
    expect(stats.clusters[0]!.share).toBeGreaterThan(0.9);
  });
});

describe('analyzeClusterPairs', () => {
  const buffer = blank(40, 40, hex('#ffffff'));
  rect(buffer, 0, 0, 20, 40, hex('#d62728'));
  rect(buffer, 20, 0, 20, 40, hex('#2ca02c'));
  const { clusters } = analyzePixels(buffer);

  it('flags the red/green pair as confusable under deuteranopia and carries M2 provenance', () => {
    const analysis = analyzeClusterPairs(clusters, 'deuteranopia');
    expect(analysis.confidence).toBe('SUPPORTED_MODEL');
    const redGreen = analysis.pairs.find((p) => !clusters[p.a]!.neutral && !clusters[p.b]!.neutral);
    expect(redGreen?.confusable).toBe(true);
  });

  it('does not upgrade weaker models', () => {
    expect(analyzeClusterPairs(clusters, 'tritanomaly').confidence).toBe('APPROXIMATION');
    expect(analyzeClusterPairs(clusters, 'deuteranomaly').confidence).toBe('MODEL_ASSUMPTION');
  });

  it('reports nothing for normal vision or an unsupported custom profile', () => {
    expect(analyzeClusterPairs(clusters, 'normal').pairs).toHaveLength(0);
    expect(analyzeClusterPairs(clusters, 'custom').pairs).toHaveLength(0);
  });
});
