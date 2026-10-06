import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MockSemanticProvider,
  SemanticAssistEngine,
  buildSemanticQuery,
  canonicalPacket,
  isEligibleFinding,
  parseHypothesis,
  validateHypothesis,
  type AssistOutcome,
  type BoundQuery,
  type ProviderRequest,
  type SemanticQuery,
} from '@core/semantic-ai';
import { buildSemanticScenarios, type Scenario } from './semantic-ai-scenarios';
import { buildR1Scenarios } from './semantic-ai-scenarios-r1';

/**
 * Semantic benchmark (docs/AI_SEMANTIC_ENGINE.md, "Benchmark"). Two things are measured, neither of
 * them "how good a model is":
 *
 * 1. the *faithful* replay: a model that says what the scenario's author says it may, through the
 *    real engine and validator: does the pipeline give the documented outcome?
 * 2. the *adversarial sweep*: for every scenario, a model that claims every label the task offers, with
 *    full confidence, citing every evidence id or only the ones that support the claim. The hard gate:
 *    no claim outside the scenario's ground-truth labels is ever accepted, whatever the model says.
 */
const REPORT_DIR = path.resolve(import.meta.dirname, '../../benchmark-report');
const SCENARIOS = [...buildSemanticScenarios(), ...buildR1Scenarios()];

interface Bound {
  readonly scenario: Scenario;
  readonly bound: BoundQuery;
}
const BOUND: Bound[] = SCENARIOS.map((scenario) => {
  const bound = buildSemanticQuery(scenario.facts, { id: scenario.id });
  if (!bound) throw new Error(`${scenario.id}: no packet`);
  return { scenario, bound };
});

const faithful = new Map<string, Scenario>();
for (const { scenario, bound } of BOUND) {
  const key = canonicalPacket(bound.query);
  const earlier = faithful.get(key);
  if (earlier && (earlier.says !== scenario.says || earlier.expect !== scenario.expect))
    throw new Error(`${scenario.id} and ${earlier.id} share a packet but not an expectation`);
  faithful.set(key, scenario);
}

function supporting(query: SemanticQuery, label: string): string[] {
  return query.deterministicEvidence.filter((e) => e.supports.includes(label)).map((e) => e.id);
}

/** The confidences a model may claim, including both sides of the 0.6 floor. */
const SWEEP_CONFIDENCES = [0, 0.3, 0.5, 0.5999, 0.6, 0.6001, 0.61, 0.9, 1];

/** Every way a model may cite: all evidence, only what supports, only what does not, one at a time. */
function refVariants(query: SemanticQuery, label: string, allIds: string[]): string[][] {
  const yes = supporting(query, label).slice(0, 8);
  const no = allIds.filter((id) => !yes.includes(id));
  return [
    allIds,
    yes,
    no,
    ...yes.slice(0, 3).map((id) => [id]),
    ...no.slice(0, 2).map((id) => [id]),
  ].filter((refs) => refs.length > 0);
}

/** The faithful model: says what the scenario's author says it may, citing what supports it. */
function faithfulAnswer(request: ProviderRequest): string {
  const query = JSON.parse(request.payload) as SemanticQuery;
  const scenario = faithful.get(canonicalPacket(query));
  if (!scenario) throw new Error('unknown packet');
  // A model cannot cite what is not there: with nothing to cite for its claim it cites what exists,
  // and with no evidence at all it can only abstain.
  const cited = scenario.says === null ? [] : supporting(query, scenario.says);
  const refs = cited.length > 0 ? cited : query.deterministicEvidence.map((e) => e.id);
  if (scenario.says === null || refs.length === 0)
    return JSON.stringify({
      schemaVersion: 1,
      outcome: 'INSUFFICIENT_CONTEXT',
      label: 'unknown',
      confidence: 0.3,
      evidenceRefs: [],
    });
  return JSON.stringify({
    schemaVersion: 1,
    outcome: 'SUPPORTED_HYPOTHESIS',
    label: scenario.says,
    confidence: 0.9,
    evidenceRefs: refs.slice(0, 8),
  });
}

const stats = {
  scenarios: SCENARIOS.length,
  eligible: SCENARIOS.length,
  aiCalls: 0,
  deduped: 0,
  accepted: 0,
  rejected: 0,
  unresolved: 0,
  modelErrors: 0,
  promoted: 0,
  retainedManualReview: 0,
  incorrectAccepted: [] as string[],
  sweepClaims: 0,
  sweepAccepted: 0,
  unexpected: [] as string[],
};

describe('semantic benchmark: scenarios', () => {
  it('has at least 350 scenarios covering every family, in English and Russian', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(350);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    const families = new Set(SCENARIOS.map((s) => s.family));
    for (const family of [
      'declared-selected',
      'class-only',
      'class-and-text',
      'contradiction',
      'misleading-class',
      'brand-ambiguity',
      'chart-title',
      'chart-misleading',
      'icon-named',
      'icon-class-only',
      'insufficient-context',
      'form-field',
      'rival-hypothesis',
      'same-source-evidence',
      'weak-only',
      'high-risk',
      'prompt-injection',
      'vocabulary-boundary',
    ])
      expect(families.has(family), family).toBe(true);
    expect(SCENARIOS.some((s) => /-ru$/.test(s.id))).toBe(true);
    expect(SCENARIOS.some((s) => /-en$/.test(s.id))).toBe(true);
  });

  it('gives every scenario a packet inside the budgets', () => {
    for (const { bound } of BOUND) {
      expect(bound.query.deterministicEvidence.length).toBeLessThanOrEqual(20);
      expect(canonicalPacket(bound.query).length).toBeLessThanOrEqual(6144);
    }
  });

  it('runs the faithful replay through the engine once per distinct packet', async () => {
    const provider = new MockSemanticProvider({
      respond: faithfulAnswer,
      model: 'faithful-replay',
    });
    const engine = new SemanticAssistEngine(provider, { queriesPerRun: 10_000 });
    const outcomes = new Map<string, AssistOutcome>();
    const summary = await engine.run(
      BOUND.map(({ scenario, bound }, index) => ({
        id: scenario.id,
        bound,
        priority: BOUND.length - index,
      })),
      { isCurrent: () => true, onResult: (outcome) => outcomes.set(outcome.id, outcome) },
    );
    expect(outcomes.size).toBe(SCENARIOS.length);
    stats.aiCalls = provider.calls;
    stats.deduped = summary.stats.deduped;
    expect(provider.calls + summary.stats.deduped).toBe(SCENARIOS.length);
    expect(provider.calls).toBe(faithful.size);

    for (const { scenario } of BOUND) {
      const outcome = outcomes.get(scenario.id)!;
      const status = outcome.interpreted.validatorStatus;
      if (outcome.interpreted.modelStatus === 'MODEL_ERROR') stats.modelErrors += 1;
      else if (status === 'ACCEPTED_ADVISORY') stats.accepted += 1;
      else if (status === 'REJECTED') stats.rejected += 1;
      else stats.unresolved += 1;
      // Every case stays manual review whatever was said: an interpretation never promotes it.
      stats.retainedManualReview += 1;
      if (status !== scenario.expect) stats.unexpected.push(`${scenario.id}: ${status}`);
      if (status === 'ACCEPTED_ADVISORY') {
        const label = outcome.interpreted.hypothesis?.label ?? '';
        if (!scenario.acceptable.includes(label))
          stats.incorrectAccepted.push(`${scenario.id}: ${label}`);
      }
    }
    expect(stats.unexpected).toEqual([]);
    expect(stats.incorrectAccepted).toEqual([]);
    expect(stats.modelErrors).toBe(0);
  });

  it('never accepts a claim outside the ground truth, whatever the model claims (hard gate)', () => {
    for (const { scenario, bound } of BOUND) {
      const query = bound.query;
      const allIds = query.deterministicEvidence.map((e) => e.id).slice(0, 8);
      for (const label of query.allowedLabels) {
        for (const confidence of SWEEP_CONFIDENCES) {
          for (const refs of refVariants(query, label, allIds)) {
            if (refs.length === 0) continue;
            const raw = JSON.stringify({
              schemaVersion: 1,
              outcome: 'SUPPORTED_HYPOTHESIS',
              label,
              confidence,
              evidenceRefs: refs,
            });
            const parsed = parseHypothesis(raw, query);
            expect(parsed.ok, `${scenario.id} ${label}`).toBe(true);
            if (!parsed.ok) continue;
            stats.sweepClaims += 1;
            const verdict = validateHypothesis(query, parsed.hypothesis);
            if (verdict.status === 'ACCEPTED_ADVISORY') {
              stats.sweepAccepted += 1;
              if (!scenario.acceptable.includes(label))
                stats.incorrectAccepted.push(`${scenario.id}: sweep ${label}`);
            }
          }
        }
      }
    }
    expect(stats.sweepClaims).toBeGreaterThan(20_000);
    expect(stats.incorrectAccepted).toEqual([]);
  });

  it('turns every kind of bad provider output into a model error, never into an interpretation', () => {
    for (const { scenario, bound } of BOUND) {
      const query = bound.query;
      const label = query.allowedLabels[0] ?? 'x';
      const ref = query.deterministicEvidence[0]?.id ?? 'e1';
      const bad: unknown[] = [
        'not json at all',
        '',
        '{}',
        '[]',
        'null',
        '```json\n{"label":"x"}\n```',
        {
          schemaVersion: 1,
          outcome: 'SUPPORTED_HYPOTHESIS',
          label,
          confidence: 1,
          evidenceRefs: ['e999'],
        },
        {
          schemaVersion: 1,
          outcome: 'SUPPORTED_HYPOTHESIS',
          label: 'compliant',
          confidence: 1,
          evidenceRefs: [ref],
        },
        { schemaVersion: 1, outcome: 'COMPLIANT', label, confidence: 1, evidenceRefs: [ref] },
        {
          schemaVersion: 1,
          outcome: 'SUPPORTED_HYPOTHESIS',
          label,
          confidence: 7,
          evidenceRefs: [ref],
        },
        {
          schemaVersion: 1,
          outcome: 'SUPPORTED_HYPOTHESIS',
          label,
          confidence: 1,
          evidenceRefs: [ref],
          autoFix: true,
        },
        {
          schemaVersion: 1,
          outcome: 'SUPPORTED_HYPOTHESIS',
          label,
          confidence: 1,
          evidenceRefs: [ref],
          css: 'body{display:none}',
        },
        {
          schemaVersion: 1,
          outcome: 'SUPPORTED_HYPOTHESIS',
          label,
          confidence: 1,
          evidenceRefs: [ref],
          url: 'https://example.com',
        },
        {
          schemaVersion: 2,
          outcome: 'SUPPORTED_HYPOTHESIS',
          label,
          confidence: 1,
          evidenceRefs: [ref],
        },
        'x'.repeat(5000),
      ];
      for (const raw of bad) {
        expect(
          parseHypothesis(raw, query).ok,
          `${scenario.id}: ${JSON.stringify(raw).slice(0, 40)}`,
        ).toBe(false);
      }
    }
  });

  it('keeps ground truth consistent: nothing acceptable is outside the packet’s labels', () => {
    for (const { scenario, bound } of BOUND) {
      for (const label of scenario.acceptable) expect(bound.query.allowedLabels).toContain(label);
    }
  });
});

describe('semantic benchmark: AI is only for what a human would have had to review', () => {
  const NOT_ELIGIBLE: [string, 'issue' | 'analysis-limitation' | 'manual-review'][] = [
    ['CA-COLOR-001', 'issue'],
    ['CA-COLOR-002', 'issue'],
    ['CA-COLOR-003', 'analysis-limitation'],
    ['CA-GEN-001', 'analysis-limitation'],
    ['CA-SEM-001', 'issue'],
    ['CA-SVG-001', 'issue'],
    ['CA-CHART-001', 'issue'],
    ['CA-IMG-001', 'issue'],
    // An eligible rule's finding, if it were ever a confirmed issue, is not asked about either.
    ['CA-SEM-002', 'issue'],
    ['CA-CHART-002', 'issue'],
    ['CA-SVG-002', 'analysis-limitation'],
    // A review nobody can ask the model about (no packet exists for it).
    ['CA-UNKNOWN-001', 'manual-review'],
  ];
  it('asks about no confirmed finding, no limitation and no unknown rule', () => {
    let calls = 0;
    for (const [ruleId, assessment] of NOT_ELIGIBLE) {
      if (isEligibleFinding({ ruleId, assessment })) calls += 1;
    }
    expect(calls).toBe(0);
  });

  it('asks about every manual-review rule it has a task for', () => {
    for (const ruleId of [
      'CA-SEM-002',
      'CA-SVG-002',
      'CA-CHART-002',
      'CA-CHART-003',
      'CA-CHART-004',
      'CA-IMG-002',
      'CA-IMG-003',
    ]) {
      expect(isEligibleFinding({ ruleId, assessment: 'manual-review' }), ruleId).toBe(true);
    }
  });
});

afterAll(() => {
  mkdirSync(REPORT_DIR, { recursive: true });
  const { incorrectAccepted, unexpected, ...counts } = stats;
  writeFileSync(
    path.join(REPORT_DIR, 'semantic-ai-benchmark.json'),
    `${JSON.stringify({ generatedBy: 'tests/benchmarks/semantic-ai-benchmark.test.ts', note: 'Replay of scripted answers through the real engine and validator. No model was involved: this measures the pipeline and the validator, not a model.', ...counts, incorrectAccepted: incorrectAccepted.length, unexpectedOutcomes: unexpected.length, families: Object.fromEntries([...new Set(SCENARIOS.map((s) => s.family))].map((f) => [f, SCENARIOS.filter((s) => s.family === f).length])) }, null, 2)}\n`,
  );
});
