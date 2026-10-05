import { describe, expect, it } from 'vitest';
import {
  AUDIT_SEVERITIES,
  CONFIDENCE_LABEL,
  COVERAGE_LEVEL_LABEL,
  MODEL_CONFIDENCE_LABEL,
  SEVERITY_LABEL,
  buildSnapshot,
  createAuditReport,
  escapeHtml,
  parseAuditReport,
  renderAuditHtml,
  serializeAuditReport,
  simulationInfo,
  type AuditCandidate,
  type AuditSimulation,
} from '@core/audit';
import { VISION_PROFILE_CONFIDENCE, type VisionModel, type VisionProfile } from '@domain/models';
import { FACTORS, candidate, target } from './builders';

/** A small seeded PRNG: the permutations are different from each other and the same on every run. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0 || 1;
  const next = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** The model each profile is simulated with (M2); the confidence comes from M2's own table, never from here. */
const MODEL_OF: Partial<Record<VisionProfile, VisionModel>> = {
  protanopia: 'brettel1997',
  deuteranopia: 'brettel1997',
  tritanopia: 'brettel1997',
  protanomaly: 'machado2009',
  deuteranomaly: 'machado2009',
  tritanomaly: 'machado2009',
  achromatopsia: 'machado2009',
};

function simulation(profile: VisionProfile): AuditSimulation {
  return simulationInfo(profile, MODEL_OF[profile] ?? 'brettel1997');
}

const cvd = (path: string, profile: VisionProfile) =>
  candidate({
    ruleId: 'CA-COLOR-002',
    target: target(path, 'p'),
    profile,
    simulation: simulation(profile),
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
        label: `Simulated under ${profile}`,
        value: { kind: 'number', value: 0.04 },
      },
    ],
  });

const snapshotOf = (candidates: readonly AuditCandidate[]) =>
  buildSnapshot({
    candidates,
    generation: 1,
    timestamp: 5,
    page: { origin: 'https://example.test', pathname: '/p' },
    extensionVersion: '0.1.0',
    settings: {
      activeProfile: 'deuteranopia',
      auditedProfiles: ['protanopia', 'deuteranopia', 'tritanopia'],
      adaptationEnabled: true,
    },
    coverage: {
      elementsAnalyzed: 40,
      analysisTruncated: false,
      semanticCandidates: 3,
      svgUnits: 1,
      charts: 1,
      canvases: 1,
      images: 1,
      budgetsReached: ['images', 'chart marks'],
    },
  }).snapshot;

const RICH: AuditCandidate[] = [
  candidate({ target: target('html>body>p:nth-of-type(1)', 'p') }),
  candidate({ target: target('html>body>p:nth-of-type(2)', 'p'), adaptation: 'adapted' }),
  ...(['protanopia', 'deuteranopia', 'tritanopia'] as const).flatMap((profile) => [
    cvd('html>body>div:nth-of-type(1)>p', profile),
    cvd('html>body>div:nth-of-type(2)>p', profile),
  ]),
  candidate({
    ruleId: 'CA-SEM-001',
    context: 'invalid',
    target: target('#a', 'input:email', { tag: 'input', inputType: 'email' }),
    factors: { ...FACTORS, informationLoss: 'total', functionalImpact: 'major', interactive: true },
  }),
  candidate({
    ruleId: 'CA-CHART-004',
    assessment: 'manual-review',
    context: 'canvas',
    target: target('html>body>canvas', 'canvas'),
  }),
  candidate({
    ruleId: 'CA-SVG-002',
    assessment: 'manual-review',
    context: 'multi',
    target: target('html>body>svg', 'svg'),
  }),
];

describe('M9.R1 export determinism', () => {
  it('60 random candidate orders give byte-identical JSON and HTML (apart from generatedAt)', () => {
    const reference = createAuditReport(snapshotOf(RICH), 1_000);
    const json = serializeAuditReport(reference);
    const html = renderAuditHtml(reference);
    for (let seed = 1; seed <= 60; seed += 1) {
      const report = createAuditReport(snapshotOf(shuffled(RICH, seed)), 1_000);
      expect(serializeAuditReport(report)).toBe(json);
      expect(renderAuditHtml(report)).toBe(html);
    }
  });

  it('two exports of one snapshot differ only in generatedAt', () => {
    const snap = snapshotOf(RICH);
    const strip = (text: string) => text.replace(/"generatedAt": "[^"]+"/, '"generatedAt": "X"');
    const a = serializeAuditReport(createAuditReport(snap, 1_000));
    const b = serializeAuditReport(createAuditReport(snap, 9_999_000));
    expect(a).not.toBe(b);
    expect(strip(a)).toBe(strip(b));
  });

  it('every ordered collection is sorted by a documented key, not by insertion', () => {
    const report = createAuditReport(snapshotOf(shuffled(RICH, 7)), 1);
    const rank = (s: string) => AUDIT_SEVERITIES.indexOf(s as never);
    for (let i = 1; i < report.findings.length; i += 1) {
      expect(rank(report.findings[i - 1]!.severity)).toBeLessThanOrEqual(
        rank(report.findings[i]!.severity),
      );
    }
    for (const finding of report.findings) {
      const profiles = finding.visionProfiles;
      expect([...profiles]).toEqual(
        [...profiles].sort(
          (a, b) =>
            ['protanopia', 'deuteranopia', 'tritanopia'].indexOf(a) -
            ['protanopia', 'deuteranopia', 'tritanopia'].indexOf(b),
        ),
      );
      expect(finding.simulation.map((s) => s.profile)).toEqual([...profiles]);
      const paths = finding.affected.map((a) => a.locator.path);
      expect(paths.length).toBe(new Set(paths).size);
    }
    const keys = Object.keys(JSON.parse(serializeAuditReport(report)).summary);
    expect(keys).toEqual([...keys].sort());
    expect(report.coverage.budgetsReached).toEqual(['chart marks', 'images']);
  });
});

describe('M9.R1 one finding across profiles', () => {
  it('a problem under three profiles is one card listing three profiles, not three cards', () => {
    const snap = snapshotOf(
      (['tritanopia', 'protanopia', 'deuteranopia'] as const).map((p) =>
        cvd('html>body>p:nth-of-type(1)', p),
      ),
    );
    expect(snap.findings).toHaveLength(1);
    expect(snap.findings[0]?.visionProfiles).toEqual(['protanopia', 'deuteranopia', 'tritanopia']);
    expect(snap.findings[0]?.affectedCount).toBe(1);
    expect(snap.summary.findings).toBe(1);
  });
});

describe('M9.R1 M2 scientific status survives every layer', () => {
  const profiles = ['protanopia', 'deuteranomaly', 'tritanomaly', 'achromatopsia'] as const;
  for (const profile of profiles) {
    it(`${profile}: model, fidelity and ModelConfidence are carried exactly`, () => {
      const wanted = simulation(profile);
      expect(wanted.modelConfidence).toBe(VISION_PROFILE_CONFIDENCE[profile]);
      const snap = snapshotOf([cvd('html>body>p:nth-of-type(1)', profile)]);
      const finding = snap.findings[0]!;
      expect(finding.simulation).toEqual([wanted]);
      const report = createAuditReport(snap, 1);
      expect(report.findings[0]?.simulation).toEqual([wanted]);
      const parsed = parseAuditReport(serializeAuditReport(report));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.report.findings[0]?.simulation).toEqual([wanted]);
      const html = renderAuditHtml(report);
      expect(html).toContain(
        `${profile}: ${wanted.model} (${MODEL_CONFIDENCE_LABEL[wanted.modelConfidence]})`,
      );
      if (wanted.modelConfidence !== 'SUPPORTED_MODEL') {
        expect(html).not.toContain(
          `${profile}: ${wanted.model} (${MODEL_CONFIDENCE_LABEL.SUPPORTED_MODEL})`,
        );
      }
    });
  }

  it('a weaker model is never silently upgraded when profiles merge into one finding', () => {
    const snap = snapshotOf([
      cvd('html>body>p:nth-of-type(1)', 'deuteranopia'),
      cvd('html>body>p:nth-of-type(1)', 'deuteranomaly'),
    ]);
    const sims = snap.findings[0]!.simulation;
    expect(sims.map((s) => [s.profile, s.modelConfidence])).toEqual([
      ['deuteranopia', 'SUPPORTED_MODEL'],
      ['deuteranomaly', 'MODEL_ASSUMPTION'],
    ]);
    expect(snap.findings[0]!.severity).not.toBe('critical');
  });

  it('finding confidence and model confidence are two separate fields', () => {
    const snap = snapshotOf([cvd('html>body>p:nth-of-type(1)', 'tritanomaly')]);
    const finding = snap.findings[0]!;
    expect(finding.confidence).toBe('HIGH');
    expect(finding.simulation[0]?.modelConfidence).toBe('APPROXIMATION');
  });
});

describe('M9.R1 JSON and HTML represent the same snapshot', () => {
  it('summary, rule ids, severity, confidence, counts, recommendations and coverage all match', () => {
    const report = createAuditReport(snapshotOf(RICH), 1);
    const html = renderAuditHtml(report);
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const has = (value: string) =>
      expect(text).toContain(
        escapeHtml(value)
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>'),
      );
    // Escaped output decodes to the same text, so compare on the decoded form.
    const decoded = text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    const includes = (value: string) => expect(decoded).toContain(value);
    void has;
    includes(
      `${report.summary.findings} findings affecting ${report.summary.affectedElements} elements`,
    );
    includes(`Confirmed issues: ${report.summary.byAssessment.issue}`);
    includes(`Manual review: ${report.summary.byAssessment['manual-review']}`);
    for (const severity of AUDIT_SEVERITIES) {
      expect(html).toContain(
        `${SEVERITY_LABEL[severity]}</th><td>${report.summary.bySeverity[severity]}</td>`,
      );
    }
    for (const finding of report.findings) {
      expect(html).toContain(`id="${finding.id}"`);
      includes(finding.ruleId);
      includes(SEVERITY_LABEL[finding.severity]);
      includes(CONFIDENCE_LABEL[finding.confidence]);
      includes(`${finding.affectedCount} element`);
      includes(finding.recommendation.summary);
      for (const action of finding.recommendation.actions) includes(action);
      for (const w of finding.wcag) includes(`${w.criterion} ${w.name}`);
    }
    for (const s of report.coverage.subsystems) {
      includes(s.name);
      includes(COVERAGE_LEVEL_LABEL[s.level]);
      includes(s.note);
    }
  });
});

describe('M9.R1 recommendation wording matches what was proven', () => {
  it('a manual review never recommends changing a source color; an issue may', () => {
    const report = createAuditReport(snapshotOf(RICH), 1);
    for (const finding of report.findings) {
      const text = [finding.recommendation.summary, ...finding.recommendation.actions].join(' ');
      if (finding.assessment !== 'issue') {
        expect(text, finding.ruleId).not.toMatch(
          /\b(?:change|replace|use)\b.*\bcolor\b.*\b(?:to|with)\b #/i,
        );
        expect(finding.recommendation.suggestedColor).toBeNull();
      }
    }
  });

  it('a generated color is labeled as ColorAdapt’s own suggestion, never as a required value', () => {
    const snap = snapshotOf([
      candidate({
        ruleId: 'CA-COLOR-002',
        target: target('html>body>p:nth-of-type(1)', 'p'),
        profile: 'deuteranopia',
        simulation: simulation('deuteranopia'),
        recommendation: { adaptation: 'adapted', suggestedHex: '#0072B2' },
      }),
    ]);
    const finding = snap.findings[0]!;
    expect(finding.recommendation.suggestedColor).toMatchObject({
      hex: '#0072b2',
      origin: 'coloradapt-generated',
    });
    const html = renderAuditHtml(createAuditReport(snap, 1));
    expect(html).toMatch(
      /Suggested color: <code>#0072b2<\/code> — A ColorAdapt-generated suggestion/,
    );
    expect(html).not.toMatch(/required|must use|WCAG color/i);
  });
});
