import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { severityRank, type AuditAssessment, type AuditSnapshot } from '@core/audit';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '@domain/models';
import { createChartEnvironment } from '../features/charts/engine';
import { FakeImageEnvironment } from '../features/images/fake-env';
import { makeImage } from '../features/images/kit';
import { mountAudit, sourceFingerprint, type Rig } from '../features/audit/kit';
import { buildScenarios, type AuditScenario } from './audit-scenarios';

/**
 * Audit benchmark (docs/DEVELOPER_AUDIT.md, "Benchmark"): every scenario is a page that goes
 * through the real collector, the real controllers and the real rule pipeline (jsdom, with the
 * test engines standing in for SVG paint, chart layout and image decoding).
 *
 * The hard gate: for deterministic rules, no finding of assessment `issue` that the scenario does
 * not expect (a false confirmed finding), and no expected one missing. Reviews and limitations
 * are held to the same list: a manual review the policy does not call for is also a failure.
 */
const REPORT_DIR = path.resolve(import.meta.dirname, '../../benchmark-report');

interface Row {
  readonly id: string;
  readonly group: string;
  readonly expectedIssues: number;
  readonly actualIssues: number;
  readonly manualReview: number;
  readonly limitations: number;
  readonly falsePositives: readonly string[];
  readonly falseNegatives: readonly string[];
  readonly unexpectedReviews: readonly string[];
  readonly missingReviews: readonly string[];
  readonly adaptedMatchesSource: boolean;
}

const SCENARIOS = buildScenarios();
const rows: Row[] = [];

function settingsOf(scenario: AuditScenario): UserSettings {
  return {
    ...DEFAULT_USER_SETTINGS,
    visionProfile: scenario.profile ?? 'deuteranopia',
    adaptationStrength: 1,
    ...scenario.settings,
  };
}

function mount(scenario: AuditScenario, adapt: boolean): Rig {
  const settings = settingsOf(scenario);
  const options = {
    ...(scenario.css ? { css: scenario.css } : {}),
    settings,
    adapt,
  };
  if (scenario.kind === 'svg') return mountAudit(scenario.markup, { ...options, svgEngine: true });
  if (scenario.kind === 'chart')
    return mountAudit(scenario.markup, { ...options, chartEnv: createChartEnvironment(document) });
  if (scenario.kind === 'image') {
    const rig = mountAudit(scenario.markup, { ...options, imageEnv: new FakeImageEnvironment() });
    const host = document.getElementById('host') as HTMLElement;
    for (const spec of scenario.images ?? []) {
      const img = makeImage({
        src: spec.src,
        width: spec.width ?? 24,
        height: spec.height ?? 24,
        attrs: { id: spec.id, ...(spec.attrs ?? {}) },
      });
      if (spec.wrapper) {
        const wrapper = document.createElement(spec.wrapper);
        if (spec.wrapper === 'a') wrapper.setAttribute('href', '/');
        wrapper.append(img);
        host.append(wrapper);
      } else host.append(img);
    }
    return rig;
  }
  return mountAudit(scenario.markup, options);
}

function actual(snapshot: AuditSnapshot, assessment: AuditAssessment): string[] {
  const keys = new Set<string>();
  for (const finding of snapshot.findings) {
    if (finding.assessment !== assessment) continue;
    for (const affected of finding.affected) {
      keys.add(
        `${finding.ruleId}@${affected.locator.id ? `#${affected.locator.id}` : affected.locator.path}`,
      );
    }
  }
  return [...keys].sort();
}

const diff = (a: readonly string[], b: readonly string[]) => a.filter((x) => !b.includes(x));

describe('audit benchmark', () => {
  it('has at least 250 scenarios across M1-M8, the false-positive guards and the M9.R1 expansion', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(250);
    const groups = new Set(SCENARIOS.map((s) => s.group));
    for (const group of ['M1', 'M2', 'M5', 'M6', 'M7', 'M8', 'false-positive', 'R1'])
      expect(groups.has(group as never)).toBe(true);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });

  for (const scenario of SCENARIOS) {
    it(`${scenario.id}: ${scenario.label}`, () => {
      const rig = mount(scenario, false);
      const snapshot = rig.run(scenario.scope ?? 'auto');
      const issues = actual(snapshot, 'issue');
      const reviews = actual(snapshot, 'manual-review');
      const limits = actual(snapshot, 'analysis-limitation');
      const expectedIssues = [...scenario.issues].sort();
      const expectedReviews = [...(scenario.reviews ?? [])].sort();
      const expectedLimits = [...(scenario.limits ?? [])].sort();

      // The same page with ColorAdapt having adapted it: the same findings (source, not appearance).
      document.body.innerHTML = '';
      document.head.innerHTML = '';
      const adaptedRig = mount(scenario, true);
      const adapted = adaptedRig.run(scenario.scope ?? 'auto');
      const sameSource =
        JSON.stringify(sourceFingerprint(adapted)) === JSON.stringify(sourceFingerprint(snapshot));

      rows.push({
        id: scenario.id,
        group: scenario.group,
        expectedIssues: expectedIssues.length,
        actualIssues: issues.length,
        manualReview: reviews.length,
        limitations: limits.length,
        falsePositives: diff(issues, expectedIssues),
        falseNegatives: diff(expectedIssues, issues),
        unexpectedReviews: [...diff(reviews, expectedReviews), ...diff(limits, expectedLimits)],
        missingReviews: [...diff(expectedReviews, reviews), ...diff(expectedLimits, limits)],
        adaptedMatchesSource: sameSource,
      });

      expect(issues, 'issues (confirmed findings)').toEqual(expectedIssues);
      expect(reviews, 'manual reviews').toEqual(expectedReviews);
      expect(limits, 'analysis limitations').toEqual(expectedLimits);
      expect(sameSource, 'source findings with adaptation on').toBe(true);
      if (scenario.profiles) {
        const profiles = new Set(
          snapshot.findings
            .filter(
              (f) =>
                f.assessment === 'issue' &&
                (f.ruleId === 'CA-COLOR-002' || f.ruleId === 'CA-CHART-001'),
            )
            .flatMap((f) => f.visionProfiles),
        );
        expect([...profiles].sort()).toEqual([...scenario.profiles].sort());
      }
    });
  }

  afterAll(() => {
    const confirmedExpected = rows.reduce((sum, row) => sum + row.expectedIssues, 0);
    const confirmedActual = rows.reduce((sum, row) => sum + row.actualIssues, 0);
    const report = {
      generatedBy: 'tests/benchmarks/audit-benchmark.test.ts',
      note: 'Structural only: what the audit reports for each scenario, never how a page looks.',
      scenarios: rows.length,
      expectedConfirmed: confirmedExpected,
      actualConfirmed: confirmedActual,
      manualReview: rows.reduce((sum, row) => sum + row.manualReview, 0),
      analysisLimitations: rows.reduce((sum, row) => sum + row.limitations, 0),
      falsePositives: rows.reduce((sum, row) => sum + row.falsePositives.length, 0),
      falseNegatives: rows.reduce((sum, row) => sum + row.falseNegatives.length, 0),
      unexpectedReviews: rows.reduce((sum, row) => sum + row.unexpectedReviews.length, 0),
      missingReviews: rows.reduce((sum, row) => sum + row.missingReviews.length, 0),
      adaptedSourceMismatches: rows.filter((row) => !row.adaptedMatchesSource).length,
      byGroup: Object.fromEntries(
        [...new Set(rows.map((row) => row.group))].map((group) => {
          const own = rows.filter((row) => row.group === group);
          return [
            group,
            {
              scenarios: own.length,
              expectedConfirmed: own.reduce((s, r) => s + r.expectedIssues, 0),
              actualConfirmed: own.reduce((s, r) => s + r.actualIssues, 0),
              manualReview: own.reduce((s, r) => s + r.manualReview, 0),
              falsePositives: own.reduce((s, r) => s + r.falsePositives.length, 0),
              falseNegatives: own.reduce((s, r) => s + r.falseNegatives.length, 0),
            },
          ];
        }),
      ),
      rows,
    };
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(
      path.join(REPORT_DIR, 'audit-benchmark.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  });

  it('hard gate: zero false confirmed findings and zero missed deterministic findings', () => {
    // Runs after every scenario above (same file, declared order).
    expect(rows.length).toBe(SCENARIOS.length);
    expect(rows.flatMap((row) => row.falsePositives)).toEqual([]);
    expect(rows.flatMap((row) => row.falseNegatives)).toEqual([]);
    expect(rows.flatMap((row) => row.unexpectedReviews)).toEqual([]);
    expect(rows.filter((row) => !row.adaptedMatchesSource).map((row) => row.id)).toEqual([]);
  });
});

describe('severity calibration', () => {
  const sev = (id: string, ruleId: string) => {
    const scenario = SCENARIOS.find((s) => s.id === id) as AuditScenario;
    const snapshot = mount(scenario, false).run(scenario.scope ?? 'auto');
    const finding = snapshot.findings.find((f) => f.ruleId === ruleId);
    if (!finding) throw new Error(`${id}: no ${ruleId}`);
    return finding.severity;
  };

  it('ranks what a developer would rank first, first', () => {
    const invalidField = severityRank(sev('m6-invalid-color-only', 'CA-SEM-001'));
    const selectedTab = severityRank(sev('m6-selected-tab-color-only', 'CA-SEM-001'));
    const paleParagraph = severityRank(sev('m1-aaaaaa-on-white', 'CA-COLOR-001'));
    const chartPair = severityRank(sev('m7-line-confusable', 'CA-CHART-001'));
    const canvasChart = severityRank(sev('m7-canvas-chart', 'CA-CHART-004'));
    const multiPaintSvg = severityRank(sev('m5-multi-paint', 'CA-SVG-002'));
    const badClassOnly = severityRank(sev('m6-badge-class-only', 'CA-SEM-002'));
    expect(invalidField).toBeGreaterThan(selectedTab);
    expect(selectedTab).toBeGreaterThanOrEqual(paleParagraph);
    expect(paleParagraph).toBeGreaterThanOrEqual(chartPair);
    expect(chartPair).toBeGreaterThan(canvasChart);
    expect(chartPair).toBeGreaterThan(multiPaintSvg);
    expect(chartPair).toBeGreaterThan(badClassOnly);
    expect(invalidField).toBeGreaterThan(multiPaintSvg);
  });

  it('gives each kind of finding the severity the model documents', () => {
    expect(sev('m6-invalid-color-only', 'CA-SEM-001')).toBe('critical'); // HIGH confidence, total loss, a form control
    expect(sev('m6-selected-tab-color-only', 'CA-SEM-001')).toBe('high');
    expect(sev('m1-aaaaaa-on-white', 'CA-COLOR-001')).toBe('medium');
    expect(sev('m1-dddddd-on-white', 'CA-COLOR-001')).toBe('high'); // 1.4:1: practically invisible
    expect(sev('m1-interactive-link', 'CA-COLOR-001')).toBe('high');
    expect(sev('m7-line-confusable', 'CA-CHART-001')).toBe('medium');
    expect(sev('m7-canvas-chart', 'CA-CHART-004')).toBe('info');
    expect(sev('m8-raster-chart', 'CA-IMG-002')).toBe('info');
    expect(sev('m1-gradient-background', 'CA-COLOR-003')).toBe('info');
    expect(['low', 'info']).toContain(sev('m6-badge-class-only', 'CA-SEM-002'));
  });

  it('answers severity and confidence separately: near-invisible text is high severity, and sure', () => {
    const scenario = SCENARIOS.find((s) => s.id === 'm1-dddddd-on-white') as AuditScenario;
    const finding = mount(scenario, false).run('active').findings[0];
    expect(finding?.severity).toBe('high');
    expect(finding?.confidence).toBe('HIGH');
  });

  it('never rates anything critical on a weaker model', () => {
    const scenario = SCENARIOS.find((s) => s.id === 'm2-pair-1') as AuditScenario;
    const snapshot = mount({ ...scenario, profile: 'deuteranomaly' }, false).run('active');
    for (const finding of snapshot.findings.filter((f) => f.simulation.length > 0)) {
      expect(finding.severity).not.toBe('critical');
    }
  });
});
