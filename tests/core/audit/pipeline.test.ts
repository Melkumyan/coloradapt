import { describe, expect, it } from 'vitest';
import {
  AUDIT_LIMITS,
  buildSnapshot,
  dedupeInstances,
  groupInstances,
  summarize,
  toInstance,
  type AuditCandidate,
  type SnapshotInput,
} from '@core/audit';
import { VISION_MODEL_INFO } from '@domain/models';
import { FACTORS, candidate, target } from './builders';

const base: Omit<SnapshotInput, 'candidates'> = {
  generation: 1,
  timestamp: 1_700_000_000_000,
  page: { origin: 'https://example.test', pathname: '/' },
  extensionVersion: '0.1.0',
  settings: {
    activeProfile: 'deuteranopia',
    auditedProfiles: ['deuteranopia'],
    adaptationEnabled: false,
  },
  coverage: {
    elementsAnalyzed: 3,
    analysisTruncated: false,
    semanticCandidates: 0,
    svgUnits: 0,
    charts: 0,
    canvases: 0,
    images: 0,
  },
};

const build = (candidates: readonly AuditCandidate[], extra: Partial<SnapshotInput> = {}) =>
  buildSnapshot({ ...base, ...extra, candidates });

const cvd = (
  path: string,
  profile: 'protanopia' | 'deuteranopia' | 'tritanopia',
  status = 'not-enabled' as const,
) =>
  candidate({
    ruleId: 'CA-COLOR-002',
    target: target(path, 'p'),
    profile,
    adaptation: status,
    simulation: {
      profile,
      model: 'brettel1997',
      fidelity: VISION_MODEL_INFO.brettel1997.fidelity,
      modelConfidence: 'SUPPORTED_MODEL',
    },
    evidence: [
      {
        key: 'colors.pair',
        basis: 'observed-fact',
        label: 'Pair',
        value: { kind: 'colors', foreground: '#c0392b', background: '#27ae60' },
      },
      {
        key: `${profile}.distance.simulated`,
        basis: 'model-estimate',
        label: 'Simulated',
        value: { kind: 'number', value: 0.04 },
      },
    ],
  });

describe('instances and deduplication', () => {
  it('gives the same problem on the same element the same id, whatever the profile', () => {
    const a = toInstance(cvd('html>body>p:nth-of-type(1)', 'protanopia'));
    const b = toInstance(cvd('html>body>p:nth-of-type(1)', 'deuteranopia'));
    expect(a?.instanceId).toBe(b?.instanceId);
    expect(a?.instanceId).toMatch(/^CA-COLOR-002\/[0-9a-f]{16}$/);
  });

  it('gives different elements, rules and contexts different ids', () => {
    const ids = new Set(
      [
        candidate(),
        candidate({ target: target('html>body>p:nth-of-type(2)', 'p') }),
        candidate({ ruleId: 'CA-SVG-001' }),
        candidate({ context: 'invalid' }),
      ].map((c) => toInstance(c)?.instanceId),
    );
    expect(ids.size).toBe(4);
  });

  it('merges one problem seen under several profiles into one instance', () => {
    const instances = ['protanopia', 'deuteranopia', 'tritanopia'].map((profile) =>
      toInstance(cvd('html>body>p:nth-of-type(1)', profile as 'protanopia')),
    );
    const merged = dedupeInstances(instances.filter((i) => i !== null));
    expect(merged).toHaveLength(1);
    expect(merged[0]?.profiles).toEqual(['protanopia', 'deuteranopia', 'tritanopia']);
    expect(merged[0]?.simulations.map((s) => s.profile)).toEqual([
      'protanopia',
      'deuteranopia',
      'tritanopia',
    ]);
    const keys = merged[0]?.evidence.map((e) => e.key) ?? [];
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => k === 'colors.pair')).toHaveLength(1);
  });

  it('does not accumulate repeated identical candidates (a re-analysis of the same page)', () => {
    const many = Array.from({ length: 100 }, () => candidate());
    expect(build(many).snapshot.summary.affectedElements).toBe(1);
  });

  it('ignores a not-applicable status of one profile when another profile has a real one', () => {
    const merged = dedupeInstances(
      [
        cvd('html>body>p:nth-of-type(1)', 'deuteranopia', 'adapted' as never),
        cvd('html>body>p:nth-of-type(1)', 'protanopia', 'not-applicable' as never),
      ]
        .map((c) => toInstance(c))
        .filter((i) => i !== null),
    );
    expect(merged[0]?.adaptation).toBe('adapted');
  });

  it('takes severity from the most severe observation and confidence from the weakest', () => {
    const strong = cvd('html>body>p:nth-of-type(1)', 'deuteranopia');
    const weak = {
      ...cvd('html>body>p:nth-of-type(1)', 'protanopia'),
      confidence: 'LOW' as const,
      factors: { ...FACTORS, informationLoss: 'none' as const },
    };
    const merged = dedupeInstances(
      [weak, strong].map((c) => toInstance(c)).filter((i) => i !== null),
    );
    expect(merged[0]?.confidence).toBe('LOW');
  });
});

describe('grouping', () => {
  const rows = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      candidate({
        ruleId: 'CA-SEM-001',
        context: 'offline',
        target: target(`html>body>table>tbody>tr:nth-of-type(${i + 1})>td>span`, 'span.dot'),
      }),
    );

  it('turns 100 identical rows into one finding with an exact count and a bounded sample', () => {
    const { snapshot } = build(rows(100));
    expect(snapshot.findings).toHaveLength(1);
    const [finding] = snapshot.findings;
    expect(finding?.affectedCount).toBe(100);
    expect(finding?.affected).toHaveLength(AUDIT_LIMITS.sampleTargets);
    expect(snapshot.summary.affectedElements).toBe(100);
    expect(snapshot.summary.findings).toBe(1);
  });

  it('does not sum frequency into severity', () => {
    const one = build(rows(1)).snapshot.findings[0]?.severity;
    const many = build(rows(500)).snapshot.findings[0]?.severity;
    expect(many).toBe(one);
  });

  it('keeps different components, rules and contexts apart', () => {
    const { snapshot } = build([
      ...rows(3),
      candidate({
        ruleId: 'CA-SEM-001',
        context: 'online',
        target: target('html>body>div>span:nth-of-type(1)', 'span.dot'),
      }),
      candidate({
        ruleId: 'CA-SEM-001',
        context: 'offline',
        target: target('html>body>div>b:nth-of-type(1)', 'b'),
      }),
    ]);
    expect(snapshot.findings).toHaveLength(3);
  });

  it('lists the most severe elements first and keeps the order stable', () => {
    const { snapshot } = build([
      candidate({ target: target('html>body>p:nth-of-type(2)', 'p') }),
      candidate({
        target: target('html>body>p:nth-of-type(1)', 'p'),
        factors: { ...FACTORS, informationLoss: 'total' },
      }),
    ]);
    const paths = snapshot.findings[0]?.affected.map((a) => a.locator.path);
    expect(paths?.[0]).toBe('html>body>p:nth-of-type(1)');
  });

  it('gives a stable group id that does not depend on the elements or the profiles', () => {
    const a = build(rows(3)).snapshot.findings[0]?.id;
    const b = build(rows(40)).snapshot.findings[0]?.id;
    expect(a).toBe(b);
    expect(a).toMatch(/^CA-SEM-001:[0-9a-f]{16}$/);
  });

  it('reports the worst adaptation status of the group and the breakdown', () => {
    const { snapshot } = build([
      candidate({ target: target('html>body>p:nth-of-type(1)', 'p'), adaptation: 'adapted' }),
      candidate({
        target: target('html>body>p:nth-of-type(2)', 'p'),
        adaptation: 'no-safe-candidate',
      }),
    ]);
    const finding = snapshot.findings[0];
    expect(finding?.adaptationStatus).toBe('no-safe-candidate');
    expect(finding?.adaptationBreakdown).toEqual({ adapted: 1, 'no-safe-candidate': 1 });
  });

  it('drops candidates of a rule that does not exist rather than inventing a finding', () => {
    expect(build([candidate({ ruleId: 'CA-NOPE-999' })]).snapshot.findings).toEqual([]);
  });
});

describe('snapshot', () => {
  it('is deterministic: the same candidates give the same snapshot, whatever their order', () => {
    const candidates = [
      candidate({ target: target('html>body>p:nth-of-type(1)', 'p') }),
      cvd('html>body>p:nth-of-type(2)', 'deuteranopia'),
      cvd('html>body>p:nth-of-type(2)', 'protanopia'),
      candidate({
        ruleId: 'CA-SEM-001',
        context: 'error',
        target: target('html>body>input:nth-of-type(1)', 'input'),
      }),
    ];
    const a = JSON.stringify(build(candidates).snapshot);
    const b = JSON.stringify(build([...candidates].reverse()).snapshot);
    expect(b).toBe(a);
  });

  it('counts and never scores', () => {
    const { snapshot } = build([
      candidate(),
      candidate({ ruleId: 'CA-CHART-004', assessment: 'manual-review', context: 'canvas' }),
    ]);
    expect(Object.keys(snapshot.summary)).not.toContain('score');
    expect(JSON.stringify(snapshot)).not.toMatch(/score/i);
    expect(snapshot.summary.manualReview).toBe(1);
    expect(snapshot.summary.findings).toBe(2);
  });

  it('sums severity, category, confidence, assessment and adaptation to the number of findings', () => {
    const { snapshot } = build([
      candidate(),
      candidate({ ruleId: 'CA-SEM-001', context: 'x', target: target('html>body>a', 'a') }),
      candidate({
        ruleId: 'CA-CHART-004',
        assessment: 'manual-review',
        context: 'canvas',
        confidence: 'MEDIUM',
      }),
    ]);
    const total = (record: Readonly<Record<string, number>>) =>
      Object.values(record).reduce((a, b) => a + b, 0);
    const s = snapshot.summary;
    for (const record of [
      s.bySeverity,
      s.byCategory,
      s.byConfidence,
      s.byAssessment,
      s.byAdaptation,
    ]) {
      expect(total(record)).toBe(s.findings);
    }
  });

  it('counts adapted and unresolved issues separately from reviews', () => {
    const { snapshot } = build([
      candidate({ adaptation: 'adapted' }),
      candidate({
        ruleId: 'CA-SEM-001',
        context: 'x',
        target: target('html>body>a', 'a'),
        adaptation: 'not-enabled',
      }),
      candidate({
        ruleId: 'CA-CHART-004',
        assessment: 'manual-review',
        context: 'canvas',
        target: target('html>body>canvas', 'canvas'),
      }),
    ]);
    expect(snapshot.summary.adapted).toBe(1);
    expect(snapshot.summary.unresolved).toBe(1);
    expect(snapshot.summary.manualReview).toBe(1);
  });

  it('keeps the page address as given (the caller sanitizes it) and the generation it was handed', () => {
    const { snapshot } = build([candidate()], { generation: 7 });
    expect(snapshot.generation).toBe(7);
    expect(snapshot.page).toEqual({ origin: 'https://example.test', pathname: '/' });
  });

  it('caps the finding list at its limit, loses the least severe first, and says how many were cut', () => {
    const many = Array.from({ length: AUDIT_LIMITS.maxFindings + 25 }, (_, i) =>
      candidate({
        context: `c${i}`,
        target: target(`html>body>p:nth-of-type(${i + 1})`, `p${i}`),
        factors: i === 0 ? { ...FACTORS, informationLoss: 'total' } : FACTORS,
      }),
    );
    const { snapshot, members } = build(many);
    expect(snapshot.findings).toHaveLength(AUDIT_LIMITS.maxFindings);
    expect(snapshot.coverage.truncatedFindings).toBe(25);
    expect(snapshot.findings[0]?.severity).toBe('high');
    expect(members.size).toBe(AUDIT_LIMITS.maxFindings);
  });

  it('summarizes a filtered list consistently with the snapshot function', () => {
    const { snapshot } = build([
      candidate(),
      candidate({ ruleId: 'CA-SEM-001', context: 'x', target: target('html>body>a', 'a') }),
    ]);
    expect(summarize(snapshot.findings)).toEqual(snapshot.summary);
    expect(summarize([]).findings).toBe(0);
  });

  it('exposes per-finding members for navigation, in listing order', () => {
    const { snapshot, members } = build([
      candidate({ target: target('html>body>p:nth-of-type(2)', 'p') }),
      candidate({ target: target('html>body>p:nth-of-type(1)', 'p') }),
    ]);
    const id = snapshot.findings[0]?.id ?? '';
    expect(members.get(id)).toHaveLength(2);
    expect(groupInstances([]).findings).toEqual([]);
  });
});
