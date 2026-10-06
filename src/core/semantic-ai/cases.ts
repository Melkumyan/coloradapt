import type { AuditPageInfo } from '@core/audit';
import type { BoundQuery } from './query';
import type { SemanticTask } from './taxonomy';

/**
 * What the content script and the audit page exchange for the AI-assisted review. The packet
 * (`bound.query`) is the only page-derived data on the wire, and it is already the bounded, redacted
 * form the provider will see.
 */

export interface SemanticCase {
  readonly findingId: string;
  readonly task: SemanticTask;
  /** Higher is asked first when the run's budget cannot cover everything. */
  readonly priority: number;
  readonly bound: BoundQuery;
  /** Elements the finding covers: the answer concerns the representative, not each of them. */
  readonly instances: number;
  /** Elements whose packets were compared and found equal (including the representative). */
  readonly sampled: number;
}

export interface SemanticCasesRequest {
  /** Findings whose packets are wanted whatever their priority (to check an earlier answer is still current). */
  readonly includeIds: readonly string[];
}

export interface SemanticCasesResponse {
  /** The snapshot the cases were read for. */
  readonly generation: number;
  readonly page: AuditPageInfo | null;
  /** Findings of eligible rules in that snapshot, whether or not a case was built for them. */
  readonly eligible: number;
  readonly cases: readonly SemanticCase[];
  /**
   * Findings whose sampled elements gave different packets: one answer would be wrong for some of them,
   * so no case is built and the review leaves them manual review.
   */
  readonly heterogeneous: readonly string[];
}
