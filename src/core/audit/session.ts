import type { AuditLocator } from './types';

/**
 * The plain-data shapes the audit page and the content script exchange (typed messages,
 * `infrastructure/messaging/messages.ts`). They live in the core so neither side imports the other.
 */

/** Which vision profiles a pass evaluates simulation-based rules under (docs/DEVELOPER_AUDIT.md, "Profiles"). */
export type AuditProfileScope = 'auto' | 'active' | 'major';

export interface AuditRequest {
  readonly scope: AuditProfileScope;
}

export interface HighlightRequest {
  readonly findingId: string;
  /** Which of the finding's elements (0-based, over all of them, not only the listed sample); wraps around. */
  readonly index: number;
  /** Bring the element into view first. Never moves keyboard focus. */
  readonly scroll: boolean;
}

export type HighlightResult =
  | {
      readonly ok: true;
      readonly index: number;
      readonly count: number;
      readonly locator: AuditLocator | null;
    }
  | { readonly ok: false; readonly reason: 'unknown-finding' | 'gone'; readonly count: number };

/** Local counters of the audit, for tests and debugging. No telemetry. */
export interface AuditDiagnostics {
  /** Elements affected, summed over findings. */
  readonly auditFindings: number;
  /** Findings (groups). */
  readonly auditGroups: number;
  readonly auditManualReview: number;
  readonly auditHigh: number;
  readonly auditMedium: number;
  readonly auditLow: number;
  readonly auditExports: number;
  readonly auditPasses: number;
  readonly auditLivePasses: number;
  readonly auditWatching: boolean;
  readonly auditHighlightVisible: boolean;
  readonly auditStaleDiscarded: number;
}

/** Name of the long-lived port an open audit page holds to the page's content script. */
export const AUDIT_PORT_NAME = 'coloradapt-audit';

/** Messages the content script sends over that port. */
export type AuditPortMessage = { readonly type: 'snapshot'; readonly generation: number };
