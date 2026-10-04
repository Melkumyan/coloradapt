import type { AnalyzeDocumentOptions } from '@core/analysis';

/**
 * Analyzer options implied by the build mode. The E2E build (`wxt build --mode e2e`) runs the
 * analyzer on a logical clock, so the 50 ms analysis budget (which defers every root after the first
 * once it has run out) can never split a batch on a slow or loaded machine and make exact per-pass
 * counters machine-dependent (the root cause of the old `R1-5` flake, docs/ROADMAP.md, M7). The
 * structural budgets (elements, roots) still apply. Every other build, the shipped one included, uses
 * the real clock: `{}`.
 */
export function analyzerOptionsForMode(mode: string | undefined): Partial<AnalyzeDocumentOptions> {
  return mode === 'e2e' ? { now: () => 0 } : {};
}
