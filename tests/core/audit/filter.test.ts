import { describe, expect, it } from 'vitest';
import {
  NO_FILTERS,
  buildSnapshot,
  filterFindings,
  isFiltering,
  matchesFilters,
  summarize,
  type AuditCandidate,
} from '@core/audit';
import { FACTORS, candidate, target } from './builders';

const candidates: AuditCandidate[] = [
  candidate({
    target: target('html>body>p:nth-of-type(1)', 'p', { text: 'Pay now', classes: ['cta'] }),
  }),
  candidate({
    ruleId: 'CA-SEM-001',
    context: 'invalid',
    target: target('#signup>input:nth-of-type(1)', 'input', { id: 'email' }),
    factors: { ...FACTORS, informationLoss: 'total', functionalImpact: 'major', interactive: true },
    adaptation: 'adapted',
  }),
  candidate({
    ruleId: 'CA-COLOR-002',
    profile: 'protanopia',
    target: target('html>body>h1', 'h1'),
    simulation: {
      profile: 'protanopia',
      model: 'brettel1997',
      fidelity: 'published',
      modelConfidence: 'SUPPORTED_MODEL',
    },
  }),
  candidate({
    ruleId: 'CA-CHART-004',
    assessment: 'manual-review',
    context: 'canvas',
    confidence: 'MEDIUM',
    target: target('html>body>canvas', 'canvas'),
  }),
];

const findings = buildSnapshot({
  candidates,
  generation: 1,
  timestamp: 0,
  page: { origin: 'https://example.test', pathname: '/' },
  extensionVersion: '0.1.0',
  settings: {
    activeProfile: 'protanopia',
    auditedProfiles: ['protanopia'],
    adaptationEnabled: true,
  },
  coverage: {
    elementsAnalyzed: 1,
    analysisTruncated: false,
    semanticCandidates: 0,
    svgUnits: 0,
    charts: 0,
    canvases: 0,
    images: 0,
  },
}).snapshot.findings;

describe('filters', () => {
  it('lets everything through when nothing is set', () => {
    expect(isFiltering(NO_FILTERS)).toBe(false);
    expect(filterFindings(findings, NO_FILTERS)).toHaveLength(findings.length);
  });

  it('filters by severity, category, confidence, adaptation status, assessment and profile', () => {
    const critical = filterFindings(findings, { ...NO_FILTERS, severity: ['critical'] });
    expect(critical.map((f) => f.ruleId)).toEqual(['CA-SEM-001']);
    expect(
      filterFindings(findings, { ...NO_FILTERS, category: ['chart'] }).map((f) => f.ruleId),
    ).toEqual(['CA-CHART-004']);
    expect(
      filterFindings(findings, { ...NO_FILTERS, confidence: ['MEDIUM'] }).map((f) => f.ruleId),
    ).toEqual(['CA-CHART-004']);
    expect(
      filterFindings(findings, { ...NO_FILTERS, adaptation: ['adapted'] }).map((f) => f.ruleId),
    ).toEqual(['CA-SEM-001']);
    expect(filterFindings(findings, { ...NO_FILTERS, assessment: ['manual-review'] })).toHaveLength(
      1,
    );
    expect(
      filterFindings(findings, { ...NO_FILTERS, profile: ['protanopia'] }).map((f) => f.ruleId),
    ).toEqual(['CA-COLOR-002']);
    expect(filterFindings(findings, { ...NO_FILTERS, profile: ['tritanopia'] })).toEqual([]);
  });

  it('combines filters with AND across fields and OR within one', () => {
    const both = filterFindings(findings, {
      ...NO_FILTERS,
      severity: ['critical', 'medium'],
      category: ['color-only-information'],
    });
    expect(both.map((f) => f.ruleId)).toEqual(['CA-SEM-001']);
    expect(
      filterFindings(findings, { ...NO_FILTERS, severity: ['critical', 'medium'] }).length,
    ).toBeGreaterThan(1);
  });

  it('searches rule id, title and element descriptors, case-insensitively and locally', () => {
    const q = (query: string) =>
      filterFindings(findings, { ...NO_FILTERS, query }).map((f) => f.ruleId);
    expect(q('ca-sem')).toEqual(['CA-SEM-001']);
    expect(q('canvas chart')).toEqual(['CA-CHART-004']);
    expect(q('#signup')).toEqual(['CA-SEM-001']);
    expect(q('PAY NOW')).toEqual(['CA-COLOR-001']);
    expect(q('cta')).toEqual(['CA-COLOR-001']);
    expect(q('no such thing')).toEqual([]);
    expect(isFiltering({ ...NO_FILTERS, query: '  ' })).toBe(false);
  });

  it('keeps counts internally consistent for every single-value filter', () => {
    for (const severity of ['critical', 'high', 'medium', 'low', 'info'] as const) {
      const filtered = filterFindings(findings, { ...NO_FILTERS, severity: [severity] });
      const summary = summarize(filtered);
      expect(summary.findings).toBe(filtered.length);
      expect(summary.bySeverity[severity]).toBe(filtered.length);
    }
    const visible = new Set<string>();
    for (const severity of ['critical', 'high', 'medium', 'low', 'info'] as const) {
      for (const f of filterFindings(findings, { ...NO_FILTERS, severity: [severity] }))
        visible.add(f.id);
    }
    expect(visible.size).toBe(findings.length); // the severity buckets partition the findings
  });

  it('matchesFilters agrees with filterFindings', () => {
    const f = { ...NO_FILTERS, assessment: ['issue' as const] };
    expect(findings.filter((x) => matchesFilters(x, f))).toEqual(filterFindings(findings, f));
  });
});
