import type { ModelConfidence, VisionProfile } from '@domain/models';
import { VISION_PROFILE_CONFIDENCE } from '@domain/models';
import { simulatePair } from '@core/vision';
import { ENGINEERING_THRESHOLDS } from '@core/adaptation';
import type { ColorCluster } from './types';

export interface ClusterPair {
  readonly a: number;
  readonly b: number;
  readonly originalDistance: number;
  readonly simulatedDistance: number;
  /** Hard to tell apart under the profile although apart without it. */
  readonly confusable: boolean;
}

export interface PairAnalysis {
  readonly profile: VisionProfile;
  /** Provenance of the model behind the numbers; M2's status is carried, never upgraded. */
  readonly confidence: ModelConfidence;
  readonly pairs: readonly ClusterPair[];
}

/**
 * Pairwise M2 analysis of the significant clusters of an image (indices into `clusters`). Pure
 * distinguishability, reported as data: it says which color pairs may merge under the profile,
 * never what those colors mean. Neutral-neutral pairs are skipped (a gray pair is no color
 * information).
 */
export function analyzeClusterPairs(
  clusters: readonly ColorCluster[],
  profile: VisionProfile,
  severity?: number,
): PairAnalysis {
  const pairs: ClusterPair[] = [];
  if (profile !== 'normal' && VISION_PROFILE_CONFIDENCE[profile] !== 'UNSUPPORTED') {
    for (let a = 0; a < clusters.length; a += 1) {
      for (let b = a + 1; b < clusters.length; b += 1) {
        const first = clusters[a]!;
        const second = clusters[b]!;
        if (first.neutral && second.neutral) continue;
        const analysis = simulatePair(first.color, second.color, profile, severity);
        pairs.push({
          a,
          b,
          originalDistance: analysis.originalDistance,
          simulatedDistance: analysis.simulatedDistance,
          confusable:
            analysis.simulatedDistance < ENGINEERING_THRESHOLDS.problemSimulatedDistance &&
            analysis.originalDistance >= ENGINEERING_THRESHOLDS.problemSimulatedDistance,
        });
      }
    }
  }
  return { profile, confidence: VISION_PROFILE_CONFIDENCE[profile], pairs };
}
