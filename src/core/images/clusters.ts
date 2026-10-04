import { IMAGE_LIMITS, IMAGE_THRESHOLDS } from '@shared/constants';
import type { ColorCluster } from './types';
import type { Lab } from './oklab';
import { labDistance } from './oklab';

/** One occupied cell of the OKLab histogram. */
export interface HistogramCell {
  readonly key: number;
  count: number;
  sumL: number;
  sumA: number;
  sumB: number;
  sumR: number;
  sumG: number;
  sumBlue: number;
}

export interface ClusterResult {
  readonly clusters: readonly ColorCluster[];
  readonly noiseShare: number;
}

/** Greedy seeding stops creating clusters at this many; further cells join the nearest. */
const MAX_SEEDS = 64;

interface Seed {
  count: number;
  sumL: number;
  sumA: number;
  sumB: number;
  sumR: number;
  sumG: number;
  sumBlue: number;
  /** The heaviest cell's color: the seed's anchor, never moved. */
  centre: Lab;
  firstKey: number;
}

/**
 * Deterministic dominant-color extraction over a histogram. Cells are visited from the most
 * populated down (ties by key), each either joining the nearest cluster within the merge
 * distance (an antialiasing shade is not a new color) or seeding a new one. Clusters under the
 * noise share are dropped and reported as noise; at most `maxClusters` survive. No randomness,
 * no iteration to convergence: the same cells always give the same clusters.
 */
export function clusterCells(cells: readonly HistogramCell[], total: number): ClusterResult {
  if (total <= 0 || cells.length === 0) return { clusters: [], noiseShare: 0 };
  const ordered = [...cells].sort((a, b) => b.count - a.count || a.key - b.key);
  const seeds: Seed[] = [];
  for (const cell of ordered) {
    const lab: Lab = [cell.sumL / cell.count, cell.sumA / cell.count, cell.sumB / cell.count];
    let nearest: Seed | null = null;
    let nearestDistance = Infinity;
    for (const seed of seeds) {
      const d = labDistance(lab, seed.centre);
      if (d < nearestDistance) {
        nearestDistance = d;
        nearest = seed;
      }
    }
    if (
      nearest &&
      (nearestDistance <= IMAGE_THRESHOLDS.clusterMergeDistance || seeds.length >= MAX_SEEDS)
    ) {
      nearest.count += cell.count;
      nearest.sumL += cell.sumL;
      nearest.sumA += cell.sumA;
      nearest.sumB += cell.sumB;
      nearest.sumR += cell.sumR;
      nearest.sumG += cell.sumG;
      nearest.sumBlue += cell.sumBlue;
      continue;
    }
    seeds.push({
      count: cell.count,
      sumL: cell.sumL,
      sumA: cell.sumA,
      sumB: cell.sumB,
      sumR: cell.sumR,
      sumG: cell.sumG,
      sumBlue: cell.sumBlue,
      centre: lab,
      firstKey: cell.key,
    });
  }

  const kept: Array<{ cluster: ColorCluster; firstKey: number }> = [];
  let noise = 0;
  for (const seed of seeds) {
    const share = seed.count / total;
    if (share < IMAGE_THRESHOLDS.minClusterShare) {
      noise += seed.count;
      continue;
    }
    const lab: [number, number, number] = [
      seed.sumL / seed.count,
      seed.sumA / seed.count,
      seed.sumB / seed.count,
    ];
    const chroma = Math.hypot(lab[1], lab[2]);
    kept.push({
      firstKey: seed.firstKey,
      cluster: {
        color: {
          r: seed.sumR / seed.count / 255,
          g: seed.sumG / seed.count / 255,
          b: seed.sumBlue / seed.count / 255,
          alpha: 1,
        },
        oklab: lab,
        share,
        chroma,
        neutral: chroma < IMAGE_THRESHOLDS.neutralChroma,
      },
    });
  }
  kept.sort((a, b) => b.cluster.share - a.cluster.share || a.firstKey - b.firstKey);
  for (const dropped of kept.slice(IMAGE_LIMITS.maxClusters))
    noise += dropped.cluster.share * total;
  return {
    clusters: kept.slice(0, IMAGE_LIMITS.maxClusters).map((entry) => entry.cluster),
    noiseShare: noise / total,
  };
}
