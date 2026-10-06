import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { stableHash } from '@core/audit';
import {
  canonicalPacket,
  packetWithinLimits,
  parseHypothesis,
  validateHypothesis,
  type SemanticQuery,
} from '@core/semantic-ai';

/**
 * The real-world semantic sample (docs/AI_SEMANTIC_ENGINE.md, "Real-world sample"): the packets the
 * AI-assisted review built from 75 pages of the M10 corpus in Chrome 154 (recorded by
 * `realworld/semantic-sample.spec.ts`, frozen in `tests/fixtures/semantic-ai/`), each with the
 * deterministic evidence ColorAdapt found. No model is involved here: the replay is a model that
 * always follows the evidence, and an adversary that claims every label at full confidence. The hard
 * gate on the ground-truthed cases: nothing outside the ground truth is ever accepted.
 */
const DIR = path.resolve(import.meta.dirname, '../fixtures/semantic-ai');
interface Frozen {
  readonly key: string;
  readonly page: string;
  readonly category: string;
  readonly script: string;
  readonly rule: string;
  readonly task: string;
  readonly inputHash: string;
  readonly count: number;
  readonly query: SemanticQuery;
}
const packets = JSON.parse(readFileSync(path.join(DIR, 'realworld-packets.json'), 'utf8')) as {
  pages: number;
  cases: Frozen[];
};
interface TruthEntry {
  acceptable: string[];
  kind: 'specific' | 'not-in-label-set' | 'nothing-settles';
  basis: string;
  note: string;
}
const truth = JSON.parse(readFileSync(path.join(DIR, 'realworld-truth.json'), 'utf8')) as {
  cases: Record<string, TruthEntry>;
  unresolvedRealWorld: Record<string, string>;
};
const CASES = packets.cases;

function supporting(query: SemanticQuery, label: string): string[] {
  return query.deterministicEvidence.filter((e) => e.supports.includes(label)).map((e) => e.id);
}

/** A model that always follows the evidence: the label with the most support, citing what supports it. */
function follower(query: SemanticQuery): { label: string; refs: string[] } | null {
  let best: { label: string; refs: string[] } | null = null;
  for (const label of query.allowedLabels) {
    const refs = supporting(query, label);
    if (refs.length > (best?.refs.length ?? 0)) best = { label, refs };
  }
  return best;
}

const stats = {
  cases: CASES.length,
  pages: new Set(CASES.map((c) => c.page)).size,
  withEvidence: CASES.filter((c) => c.query.deterministicEvidence.length > 0).length,
  groundTruthed: 0,
  unresolvedRealWorld: Object.keys(truth.unresolvedRealWorld).length,
  groundTruthSpecific: Object.values(truth.cases).filter((t) => t.kind === 'specific').length,
  groundTruthNotInLabelSet: Object.values(truth.cases).filter((t) => t.kind === 'not-in-label-set')
    .length,
  groundTruthNothingSettles: Object.values(truth.cases).filter((t) => t.kind === 'nothing-settles')
    .length,
  correctAccepted: 0,
  incorrectAccepted: [] as string[],
  followerAccepted: 0,
  followerRejected: 0,
  followerUnresolved: 0,
  followerAcceptedGroundTruthed: 0,
  followerUnresolvedGroundTruthed: 0,
  nonGroundTruthedAccepted: 0,
  nonGroundTruthedRejected: 0,
  nonGroundTruthedUnresolved: 0,
  sweepClaims: 0,
  sweepAccepted: 0,
};

describe('real-world semantic sample', () => {
  it('is a frozen, sanitized sample of at least 50 real cases from many pages', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(50);
    expect(stats.pages).toBeGreaterThanOrEqual(30);
    for (const rule of ['CA-SEM-002', 'CA-SVG-002', 'CA-IMG-003', 'CA-IMG-002', 'CA-CHART-003']) {
      expect(
        CASES.some((c) => c.rule === rule),
        rule,
      ).toBe(true);
    }
    expect(
      CASES.some((c) => c.script === 'cyrillic' || /[Ѐ-ӿ]/.test(JSON.stringify(c.query))),
    ).toBe(true);
  });

  it('holds exactly what the product recorded: every fingerprint matches its packet, every packet is within budget', () => {
    for (const c of CASES) {
      expect(stableHash(canonicalPacket(c.query)), c.key).toBe(c.inputHash);
      expect(packetWithinLimits(c.query), c.key).toBe(true);
    }
  });

  it('holds no URL, e-mail address, query string, long number or opaque token', () => {
    for (const c of CASES) {
      const text = JSON.stringify(c.query);
      expect(text, c.key).not.toMatch(/https?:\/\//i);
      expect(text, c.key).not.toMatch(/[^\s"@]+@[^\s"@]+\.[^\s"@]+/);
      expect(text, c.key).not.toMatch(/\?[a-z]+=/i);
      expect(text, c.key).not.toMatch(/\d{9,}/);
    }
  });

  it('has ground truth for cases that exist, with labels the packet offers', () => {
    const keys = new Set(CASES.map((c) => c.key));
    for (const [key, entry] of Object.entries(truth.cases)) {
      expect(keys.has(key), key).toBe(true);
      const query = CASES.find((c) => c.key === key)!.query;
      for (const label of entry.acceptable) expect(query.allowedLabels, key).toContain(label);
    }
    expect(Object.keys(truth.cases).length).toBeGreaterThanOrEqual(75);
  });

  it('records why every case is ground truth, and keeps what a person could not settle apart', () => {
    const keys = new Set(CASES.map((c) => c.key));
    for (const [key, entry] of Object.entries(truth.cases)) {
      expect(entry.basis.length, key).toBeGreaterThan(20);
      expect(['specific', 'not-in-label-set', 'nothing-settles'], key).toContain(entry.kind);
      // A specific case names its labels; the others accept none.
      expect(entry.acceptable.length > 0, key).toBe(entry.kind === 'specific');
      expect(truth.unresolvedRealWorld[key], key).toBeUndefined();
    }
    for (const key of Object.keys(truth.unresolvedRealWorld)) expect(keys.has(key), key).toBe(true);
    // Every frozen packet is either ground truth or reported as unresolved: none is silently left out.
    expect(Object.keys(truth.cases).length + Object.keys(truth.unresolvedRealWorld).length).toBe(
      CASES.length,
    );
  });

  it('covers English and Russian UI, icons, charts, raster controls and active states', () => {
    const truthed = CASES.filter((c) => truth.cases[c.key]);
    expect(truthed.filter((c) => c.script === 'cyrillic').length).toBeGreaterThanOrEqual(10);
    expect(truthed.filter((c) => c.script === 'latin').length).toBeGreaterThanOrEqual(50);
    for (const task of [
      'CLASSIFY_CONTROL_ICON',
      'ASSESS_MANUAL_REVIEW_CASE',
      'CLASSIFY_UI_STATE',
      'ASSESS_COLOR_DEPENDENCE',
    ])
      expect(
        truthed.some((c) => c.task === task),
        task,
      ).toBe(true);
    expect(
      truthed.some((c) => c.rule === 'CA-IMG-003'),
      'raster controls',
    ).toBe(true);
    expect(
      truthed.some((c) => c.rule === 'CA-IMG-002' || c.rule === 'CA-CHART-003'),
      'charts',
    ).toBe(true);
  });

  it('never accepts a claim outside the ground truth, whatever a model claims (hard gate)', () => {
    for (const c of CASES) {
      const known = truth.cases[c.key];
      for (const label of c.query.allowedLabels) {
        for (const confidence of [1, 0.9, 0.7, 0.6001, 0.6, 0.5999, 0]) {
          const all = c.query.deterministicEvidence.map((e) => e.id).slice(0, 8);
          for (const refs of [all, supporting(c.query, label).slice(0, 8)]) {
            if (refs.length === 0) continue;
            const parsed = parseHypothesis(
              JSON.stringify({
                schemaVersion: 1,
                outcome: 'SUPPORTED_HYPOTHESIS',
                label,
                confidence,
                evidenceRefs: refs,
              }),
              c.query,
            );
            expect(parsed.ok, c.key).toBe(true);
            if (!parsed.ok) continue;
            stats.sweepClaims += 1;
            if (validateHypothesis(c.query, parsed.hypothesis).status === 'ACCEPTED_ADVISORY') {
              stats.sweepAccepted += 1;
              if (known && !known.acceptable.includes(label))
                stats.incorrectAccepted.push(`${c.key}: ${label}`);
            }
          }
        }
      }
    }
    expect(stats.incorrectAccepted).toEqual([]);
  });

  it('replays a model that follows the evidence', () => {
    for (const c of CASES) {
      const known = truth.cases[c.key];
      if (known) stats.groundTruthed += 1;
      const said = follower(c.query);
      const raw = said
        ? JSON.stringify({
            schemaVersion: 1,
            outcome: 'SUPPORTED_HYPOTHESIS',
            label: said.label,
            confidence: 0.9,
            evidenceRefs: said.refs.slice(0, 8),
          })
        : JSON.stringify({
            schemaVersion: 1,
            outcome: 'INSUFFICIENT_CONTEXT',
            label: 'unknown',
            confidence: 0.2,
            evidenceRefs: [],
          });
      const parsed = parseHypothesis(raw, c.query);
      expect(parsed.ok, c.key).toBe(true);
      if (!parsed.ok) continue;
      const status = validateHypothesis(c.query, parsed.hypothesis).status;
      if (status === 'ACCEPTED_ADVISORY') {
        stats.followerAccepted += 1;
        if (known) {
          stats.followerAcceptedGroundTruthed += 1;
          if (known.acceptable.includes(parsed.hypothesis.label)) stats.correctAccepted += 1;
          else stats.incorrectAccepted.push(`${c.key}: follower ${parsed.hypothesis.label}`);
        } else stats.nonGroundTruthedAccepted += 1;
      } else if (status === 'REJECTED') {
        stats.followerRejected += 1;
        if (!known) stats.nonGroundTruthedRejected += 1;
      } else {
        stats.followerUnresolved += 1;
        if (known) stats.followerUnresolvedGroundTruthed += 1;
        else stats.nonGroundTruthedUnresolved += 1;
      }
    }
    expect(stats.incorrectAccepted).toEqual([]);
    // The evidence a page already carries is enough for some real cases, and for most it is not.
    expect(stats.followerAccepted).toBeGreaterThan(0);
    expect(stats.followerUnresolved).toBeGreaterThan(stats.followerAccepted);
  });
});

afterAll(() => {
  const dir = path.resolve(import.meta.dirname, '../../benchmark-report');
  mkdirSync(dir, { recursive: true });
  const { incorrectAccepted, ...rest } = stats;
  writeFileSync(
    path.join(dir, 'semantic-ai-realworld.json'),
    `${JSON.stringify({ generatedBy: 'tests/realworld/semantic-sample.test.ts', note: 'Frozen packets from live pages; scripted replay, no model.', ...rest, incorrectAccepted: incorrectAccepted.length }, null, 2)}\n`,
  );
});
