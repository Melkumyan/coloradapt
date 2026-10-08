/**
 * M12.5 acceptance budgets (docs/m125/protocol.md, section 5). Frozen BEFORE the first formal run, from the host
 * variance measured in exploratory runs (protocol section 5.1) and never loosened afterwards: a number above its
 * budget is a failure, not an adjustment.
 *
 * Shape of the choice: the slice gate of the canonical bursts is the owner's 50 ms (the Long Tasks threshold); a
 * region the slice must take whole (an SVG-heavy, chart-heavy or semantic-heavy region, a single oversized region,
 * a full rescan) is indivisible, so its gate is the budget of the layer behind it (about 2x the measured cost), still
 * far from the seconds of M12. Firefox is measured by the same counter and is about 1.5x to 2x slower per slice on
 * this host, so its gates are set separately and honestly.
 */
interface CorpusBudget {
  /** Longest ColorAdapt slice (the pipeline's own counter), ms. */
  readonly sliceMs: number;
  /** From the end of the insertion until the pipeline is idle with empty queues, ms. */
  readonly settleMs: number;
}

export interface BrowserBudgets {
  /** The canonical bursts (corpus A) at 1k, 5k and 10k: longest ColorAdapt slice. */
  readonly sliceMs: number;
  /**
   * Chromium's Long Tasks report: the longest task of the page that started after the page's own insertion, in the
   * canonical bursts. It includes the browser's rendering of the inserted nodes (the extension-off control has none
   * above 50 ms); null where the browser has no such report.
   */
  readonly longTaskMs: number | null;
  /** The canonical 10k burst: time until idle. */
  readonly settle10kMs: number;
  /** Worst delay of a real click answered by the page while a 10k burst is being worked off. */
  readonly inputDelayMaxMs: number;
  /** Worst gap between two animation frames of the page during a 10k burst (rendering opportunities). */
  readonly frameGapMaxMs: number;
  /** The extension's OFF message answered in the middle of a 10k burst. */
  readonly offMessageMs: number;
  readonly stream: {
    readonly durationMs: number;
    readonly settleMs: number;
    readonly sliceMs: number;
  };
  readonly corpus: {
    readonly mixed10k: CorpusBudget;
    readonly nested5k: CorpusBudget;
    readonly svg2k: CorpusBudget;
    readonly semantic5k: CorpusBudget;
    readonly chart500: CorpusBudget;
    readonly oneRegion5k: CorpusBudget;
    readonly flat10k: CorpusBudget;
  };
}

export const BUDGETS: Record<'chrome' | 'firefox', BrowserBudgets> = {
  chrome: {
    sliceMs: 50,
    longTaskMs: 100,
    settle10kMs: 2_000,
    inputDelayMaxMs: 100,
    frameGapMaxMs: 100,
    offMessageMs: 1_000,
    stream: { durationMs: 10_000, settleMs: 3_000, sliceMs: 50 },
    corpus: {
      mixed10k: { sliceMs: 50, settleMs: 3_000 },
      nested5k: { sliceMs: 50, settleMs: 3_000 },
      svg2k: { sliceMs: 100, settleMs: 6_000 },
      semantic5k: { sliceMs: 150, settleMs: 8_000 },
      chart500: { sliceMs: 100, settleMs: 6_000 },
      oneRegion5k: { sliceMs: 100, settleMs: 1_000 },
      flat10k: { sliceMs: 100, settleMs: 1_000 },
    },
  },
  firefox: {
    sliceMs: 100,
    longTaskMs: null,
    settle10kMs: 4_000,
    inputDelayMaxMs: 150,
    frameGapMaxMs: 200,
    offMessageMs: 2_000,
    stream: { durationMs: 10_000, settleMs: 5_000, sliceMs: 100 },
    corpus: {
      mixed10k: { sliceMs: 100, settleMs: 5_000 },
      nested5k: { sliceMs: 100, settleMs: 5_000 },
      svg2k: { sliceMs: 150, settleMs: 10_000 },
      semantic5k: { sliceMs: 200, settleMs: 12_000 },
      chart500: { sliceMs: 200, settleMs: 15_000 },
      oneRegion5k: { sliceMs: 250, settleMs: 2_000 },
      flat10k: { sliceMs: 250, settleMs: 2_000 },
    },
  },
};

/**
 * How a slice gate is read: the median of the longest slice over repeated runs against the budget, and no single run
 * beyond `worstFactor` times it. One reading of a maximum is at the mercy of a host that has an occasional slow
 * moment (the first formal attempt saw 44 ms where ten quiet repetitions saw 22 to 26); the median is not, and a
 * slice that is really long still fails the worst-run bound.
 */
export const GATE = { canonicalRuns: 5, corpusRuns: 3, worstFactor: 2 } as const;

/** Repeated bursts: no unbounded growth of queue, rules or heap across rounds. */
export const REPEAT = { rounds: 20, every: 5, heapRatio: 1.15, nodeDelta: 5 } as const;
