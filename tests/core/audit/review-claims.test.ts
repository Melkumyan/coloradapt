import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_CONFIDENCES,
  AUDIT_RULES,
  AUDIT_RULE_IDS,
  buildSnapshot,
  computeSeverity,
  createAuditReport,
  renderAuditHtml,
  serializeAuditReport,
  type AuditAssessment,
  type AuditConfidence,
  type SeverityFactors,
} from '@core/audit';
import { FACTORS, candidate, target } from './builders';

/**
 * M9.R1: ColorAdapt never states conformance or non-conformance. These are the phrases that
 * would. (`not a conformance statement` and `no score` are the disclaimers and are allowed.)
 */
const NORMATIVE =
  /\b(?:violat\w*|non-?compl\w*|noncompl\w*|compliant|compliance|fails?\s+(?:to\s+meet\s+)?(?:wcag|the\s+criterion|success\s+criterion)|failed\s+wcag|wcag\s+(?:failure|violation|fail)|does\s+not\s+(?:conform|meet\s+wcag)|conforms?\s+to|passes?\s+wcag|meets?\s+wcag|accessibility\s+(?:violation|failure)|inaccessible|not\s+accessible)\b/i;
const SCORE =
  /\b(?:accessibility\s+score|score\s*[:=]|grade\s*[:=]|\d{1,3}\s*%\s*(?:accessible|compliant)|[A-F]\s+grade)\b/i;
const ALLOWED =
  /not a conformance statement|there is no score|no basis for a single accessibility score/gi;

function claimsIn(text: string): string[] {
  const cleaned = text.replace(ALLOWED, '');
  const hits: string[] = [];
  for (const re of [NORMATIVE, SCORE]) {
    const m = re.exec(cleaned);
    if (m) hits.push(m[0]);
  }
  return hits;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const everyRuleSnapshot = () =>
  buildSnapshot({
    candidates: AUDIT_RULE_IDS.map((ruleId, i) =>
      candidate({
        ruleId,
        assessment: AUDIT_RULES[ruleId].assessment,
        context: ruleId,
        target: target(`html>body>div:nth-of-type(${i + 1})`, 'div'),
        simulation: null,
      }),
    ),
    generation: 1,
    timestamp: 1,
    page: { origin: 'https://example.test', pathname: '/' },
    extensionVersion: '0.1.0',
    settings: {
      activeProfile: 'deuteranopia',
      auditedProfiles: ['deuteranopia'],
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
  }).snapshot;

describe('M9.R1 WCAG wording policy', () => {
  it('the matcher itself catches normative language and lets the disclaimers through', () => {
    for (const bad of [
      'This violates WCAG 1.4.1',
      'The page fails WCAG',
      'non-compliant text',
      'WCAG failure',
      'accessibility violation',
      'passes WCAG AA',
      'Accessibility score: 87',
    ]) {
      expect(claimsIn(bad).length, bad).toBeGreaterThan(0);
    }
    expect(claimsIn('Findings are not a conformance statement and there is no score.')).toEqual([]);
    expect(claimsIn('Related to WCAG 1.4.1 Use of Color')).toEqual([]);
  });

  it('rule metadata and recommendations make no conformance claim', () => {
    for (const rule of Object.values(AUDIT_RULES)) {
      const text = [
        rule.title,
        rule.description,
        rule.summary,
        rule.recommendation.summary,
        ...rule.recommendation.actions,
      ].join('\n');
      expect(claimsIn(text), rule.id).toEqual([]);
      for (const w of rule.wcag) expect(w.relation).toBe('related-to');
    }
  });

  it('JSON and HTML exports of every rule make no conformance claim, and only relate', () => {
    const report = createAuditReport(everyRuleSnapshot(), 1);
    expect(claimsIn(serializeAuditReport(report))).toEqual([]);
    expect(claimsIn(renderAuditHtml(report))).toEqual([]);
    expect(renderAuditHtml(report)).toContain('Related to');
  });

  it('UI strings, labels and the audit documentation make no conformance claim', () => {
    const files = [
      'src/entrypoints/audit/App.tsx',
      'src/entrypoints/audit/components.tsx',
      'src/entrypoints/audit/use-audit-session.ts',
      'src/core/audit/labels.ts',
      'src/core/audit/rules.ts',
      'src/core/audit/recommendation.ts',
      'src/core/audit/evidence.ts',
      'src/core/audit/evaluate-color.ts',
      'src/core/audit/evaluate-semantic.ts',
      'src/core/audit/evaluate-chart.ts',
      'src/core/audit/evaluate-image.ts',
      'src/core/audit/evaluate-coverage.ts',
    ];
    for (const file of files) {
      expect(claimsIn(stripComments(readFileSync(file, 'utf8'))), file).toEqual([]);
    }
    for (const doc of [
      'docs/DEVELOPER_AUDIT.md',
      'docs/AUDIT_RULES.md',
      'docs/AUDIT_EXPORT_SCHEMA.md',
    ]) {
      // Docs may quote the forbidden phrases to forbid them; they may not use them as claims.
      const paragraphs = readFileSync(doc, 'utf8')
        .split(/\n\s*\n/)
        .filter((p) => !/\b(?:never|not|no|must not|do not|does not|without)\b/i.test(p));
      expect(claimsIn(paragraphs.join('\n\n')), doc).toEqual([]);
    }
  });

  it('no accessibility score, grade or percentage exists in the report or the UI', () => {
    const report = createAuditReport(everyRuleSnapshot(), 1);
    expect(Object.keys(report.summary).sort()).toEqual(
      [
        'adapted',
        'affectedElements',
        'byAdaptation',
        'byAssessment',
        'byCategory',
        'byConfidence',
        'bySeverity',
        'findings',
        'manualReview',
        'unresolved',
      ].sort(),
    );
    for (const file of ['src/entrypoints/audit/components.tsx', 'src/entrypoints/audit/App.tsx']) {
      expect(claimsIn(readFileSync(file, 'utf8')), file).toEqual([]);
      expect(readFileSync(file, 'utf8')).not.toMatch(/<meter|<progress|role="meter"/);
    }
  });
});

describe('M9.R1 rule registry contracts', () => {
  const assessments: AuditAssessment[] = ['issue', 'manual-review', 'analysis-limitation'];
  it('every rule is complete and consistent', () => {
    for (const id of AUDIT_RULE_IDS) {
      const rule = AUDIT_RULES[id];
      expect(rule.id).toBe(id);
      expect(id).toMatch(/^CA-(?:COLOR|GEN|SEM|SVG|CHART|IMG)-\d{3}$/);
      expect(rule.title.length).toBeGreaterThan(0);
      expect(rule.description.length).toBeGreaterThan(20);
      expect(rule.summary.length).toBeGreaterThan(0);
      expect(rule.recommendation.summary.length).toBeGreaterThan(0);
      expect(rule.recommendation.actions.length).toBeGreaterThan(0);
      expect(rule.source.subsystem.length).toBeGreaterThan(0);
      expect(assessments).toContain(rule.assessment);
      // Only an `issue` may be a defect; the others are capped by the severity model.
      if (rule.assessment === 'analysis-limitation') expect(rule.defaultSeverity).toBe('info');
      if (rule.assessment === 'manual-review')
        expect(['info', 'low']).toContain(rule.defaultSeverity);
    }
  });

  it('manual-review and limitation rules never tell the developer the page is inaccessible or broken', () => {
    for (const rule of Object.values(AUDIT_RULES)) {
      if (rule.assessment === 'issue') continue;
      const text = [rule.summary, rule.description, rule.recommendation.summary]
        .join(' ')
        .replace(/does not call it a defect/g, '');
      expect(text, rule.id).not.toMatch(
        /\b(?:inaccessible|broken|defect|wrong|must be fixed|is a problem|fails?)\b/i,
      );
    }
  });

  it('every rule id is documented in docs/AUDIT_RULES.md, and the doc lists no unknown rule', () => {
    const doc = readFileSync('docs/AUDIT_RULES.md', 'utf8');
    for (const id of AUDIT_RULE_IDS) expect(doc, id).toContain(id);
    const mentioned = new Set(doc.match(/CA-(?:COLOR|GEN|SEM|SVG|CHART|IMG)-\d{3}/g) ?? []);
    for (const id of mentioned) expect(AUDIT_RULE_IDS as string[], id).toContain(id);
  });

  it('the summary table of docs/AUDIT_RULES.md agrees with the registry on every column', () => {
    const doc = readFileSync('docs/AUDIT_RULES.md', 'utf8');
    for (const id of AUDIT_RULE_IDS) {
      const rule = AUDIT_RULES[id];
      const table = doc.slice(doc.indexOf('Summary:'));
      const row = table.split(String.fromCharCode(10)).find((line) => line.startsWith(`| ${id} `));
      expect(row, `${id} has a row in the summary table`).toBeDefined();
      const cells = (row ?? '').split('|').map((cell) => cell.trim());
      expect(cells[2], `${id} category`).toBe(rule.category);
      expect(cells[3], `${id} default severity`).toBe(rule.defaultSeverity);
      expect(cells[4]?.startsWith(rule.assessment), `${id} assessment`).toBe(true);
      expect(cells[5]?.startsWith(rule.source.primary), `${id} source`).toBe(true);
      expect(cells[6], `${id} simulation`).toBe(rule.simulationBased ? 'yes' : 'no');
      const start = doc.indexOf(`## ${id} `);
      const end = doc.indexOf(`${String.fromCharCode(10)}## `, start + 3);
      const section = doc.slice(start, end === -1 ? undefined : end);
      expect(section, `${id} section`).toContain(`**Default severity**: ${rule.defaultSeverity}`);
      const related = rule.wcag.map((w) => w.criterion);
      if (related.length === 0) expect(section).toMatch(/\*\*Related to\*\*: none/);
      for (const criterion of related) expect(section).toContain(criterion);
    }
  });

  it('a rule that depends on a simulation says so only when it can carry model metadata', () => {
    for (const rule of Object.values(AUDIT_RULES)) {
      if (rule.simulationBased) expect(rule.assessment).toBe('issue');
    }
  });
});

describe('M9.R1 severity: critical guard and confidence independence', () => {
  const MAX: SeverityFactors = {
    functionalImpact: 'major',
    informationLoss: 'total',
    interactive: true,
    redundancy: 'absent',
  };
  const input = (over: Partial<Parameters<typeof computeSeverity>[0]> = {}) => ({
    base: 'high' as const,
    assessment: 'issue' as const,
    confidence: 'HIGH' as AuditConfidence,
    factors: MAX,
    adaptation: 'no-safe-candidate' as const,
    modelConfidence: null,
    ...over,
  });

  it('is critical only with HIGH confidence, total loss and an interactive element', () => {
    expect(computeSeverity(input()).severity).toBe('critical');
  });

  for (const confidence of ['LOW', 'MEDIUM'] as const) {
    it(`${confidence} confidence is never critical`, () => {
      expect(computeSeverity(input({ confidence })).severity).not.toBe('critical');
    });
  }
  for (const modelConfidence of ['MODEL_ASSUMPTION', 'APPROXIMATION'] as const) {
    it(`a ${modelConfidence} simulation is never critical`, () => {
      expect(computeSeverity(input({ modelConfidence })).severity).not.toBe('critical');
    });
  }
  it('a SUPPORTED_MODEL simulation may be critical', () => {
    expect(computeSeverity(input({ modelConfidence: 'SUPPORTED_MODEL' })).severity).toBe(
      'critical',
    );
  });
  it('manual review and analysis limitations are never critical, high or medium', () => {
    for (const assessment of ['manual-review', 'analysis-limitation'] as const) {
      for (const base of ['critical', 'high', 'medium'] as const) {
        const { severity } = computeSeverity(input({ assessment, base }));
        expect(['low', 'info']).toContain(severity);
      }
    }
  });
  it('partial loss, a non-interactive element or redundancy cannot reach critical', () => {
    expect(
      computeSeverity(input({ factors: { ...MAX, informationLoss: 'partial' } })).severity,
    ).not.toBe('critical');
    expect(computeSeverity(input({ factors: { ...MAX, interactive: false } })).severity).not.toBe(
      'critical',
    );
    expect(
      computeSeverity(input({ factors: { ...MAX, redundancy: 'present' } })).severity,
    ).not.toBe('critical');
  });

  it('severity and confidence are independent: every combination is representable', () => {
    const seen = new Set<string>();
    for (const confidence of AUDIT_CONFIDENCES) {
      for (const base of ['low', 'medium', 'high'] as const) {
        for (const factors of [FACTORS, MAX]) {
          const { severity } = computeSeverity(input({ confidence, base, factors }));
          seen.add(`${severity}/${confidence}`);
        }
      }
    }
    expect(seen.has('high/MEDIUM')).toBe(true);
    expect(seen.has('medium/HIGH')).toBe(true);
    expect(seen.has('high/HIGH')).toBe(true);
    expect(seen.has('medium/LOW')).toBe(true);
  });

  it('grouping keeps each finding’s own confidence and severity', () => {
    const snapshot = buildSnapshot({
      candidates: [
        candidate({
          confidence: 'MEDIUM',
          context: 'a',
          factors: MAX,
          target: target('html>body>a:nth-of-type(1)', 'a'),
        }),
        candidate({
          confidence: 'HIGH',
          context: 'b',
          target: target('html>body>p:nth-of-type(1)', 'p'),
        }),
      ],
      generation: 1,
      timestamp: 1,
      page: { origin: 'https://example.test', pathname: '/' },
      extensionVersion: '0.1.0',
      settings: { activeProfile: 'deuteranopia', auditedProfiles: [], adaptationEnabled: false },
      coverage: {
        elementsAnalyzed: 2,
        analysisTruncated: false,
        semanticCandidates: 0,
        svgUnits: 0,
        charts: 0,
        canvases: 0,
        images: 0,
      },
    }).snapshot;
    const confidences = snapshot.findings.map((f) => `${f.severity}/${f.confidence}`).sort();
    expect(confidences).toContain('high/MEDIUM');
    expect(confidences).toContain('medium/HIGH');
  });

  it('ranks the documented comparison sensibly', () => {
    const sev = (over: Parameters<typeof input>[0]) => computeSeverity(input(over)).severity;
    const rank = (s: string) => ['info', 'low', 'medium', 'high', 'critical'].indexOf(s);
    const interactiveTotal = sev({ base: 'medium' });
    const textContrast = sev({
      base: 'medium',
      factors: { ...FACTORS, informationLoss: 'none', functionalImpact: 'moderate' },
      adaptation: 'adapted',
    });
    const chartManual = sev({ base: 'info', assessment: 'manual-review' });
    const svgUnsupported = sev({ base: 'info', assessment: 'manual-review', factors: FACTORS });
    expect(rank(interactiveTotal)).toBeGreaterThan(rank(textContrast));
    expect(rank(textContrast)).toBeGreaterThan(rank(chartManual));
    expect(rank(chartManual)).toBeGreaterThanOrEqual(rank(svgUnsupported));
  });
});
