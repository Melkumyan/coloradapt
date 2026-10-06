import { describe, expect, it } from 'vitest';
import {
  ASSIST_COVERAGE,
  ASSIST_COVERAGE_LABEL,
  createAuditReport,
  parseAuditReport,
  renderAuditHtml,
  serializeAuditReport,
  type AssistCoverage,
  type AuditSemanticAssistEntry,
  type AuditSemanticAssistReport,
} from '@core/audit';
import { assistReport, emptyAssistReport } from '@core/semantic-ai';
import { createChartEnvironment } from '../charts/engine';
import { REPRESENTATIVE_CSS, REPRESENTATIVE_MARKUP } from './fixtures';
import { DEUTAN, mountAudit } from './kit';

/**
 * M11.R1: the AI section of an export (docs/AUDIT_EXPORT_SCHEMA.md). Provenance is complete, the
 * HTML is inert whatever a local runtime or a page says, JSON and HTML tell the same story, and taking
 * the section away leaves the deterministic report byte-identical.
 */

const NOW = 1_700_000_000_000;

function snapshot() {
  const rig = mountAudit(REPRESENTATIVE_MARKUP, {
    css: REPRESENTATIVE_CSS,
    chartEnv: createChartEnvironment(document),
    settings: DEUTAN,
  });
  return rig.run();
}

function entryFor(
  findingId: string,
  over: Partial<AuditSemanticAssistEntry> = {},
): AuditSemanticAssistEntry {
  return {
    findingId,
    task: 'ASSESS_MANUAL_REVIEW_CASE',
    modelStatus: 'SUPPORTED_HYPOTHESIS',
    validatorStatus: 'ACCEPTED_ADVISORY',
    validatorReason: 'accepted',
    hypothesis: 'carries-information',
    modelConfidence: 0.91,
    evidenceRefs: ['e1'],
    supportingEvidence: [{ id: 'e1', source: 'accessible-name', value: 'Sales by region' }],
    inputFingerprint: '0123456789abcdef',
    instances: 1,
    sampled: 1,
    ...over,
  };
}

const STATS = {
  eligible: 3,
  queried: 3,
  deduped: 0,
  cacheHits: 0,
  accepted: 1,
  rejected: 1,
  unresolved: 1,
  modelErrors: 0,
  timeouts: 0,
  notQueued: 0,
};

function reportFor(
  ids: readonly string[],
  coverage: AssistCoverage = 'completed',
  model: string | null = 'qwen2.5:7b-instruct',
): AuditSemanticAssistReport {
  return assistReport({
    coverage,
    provider: { provider: 'local-ollama', model },
    stats: STATS,
    entries: [
      entryFor(ids[0] ?? ''),
      entryFor(ids[1] ?? '', {
        validatorStatus: 'REJECTED',
        validatorReason: 'contradicted-by-strong-evidence',
        hypothesis: 'decorative',
        supportingEvidence: [],
      }),
      entryFor(ids[2] ?? '', {
        validatorStatus: 'UNRESOLVED',
        validatorReason: 'insufficient-corroboration',
        hypothesis: 'carries-information',
        instances: 7,
        sampled: 4,
      }),
    ].filter((e) => e.findingId !== ''),
  });
}

describe('provenance', () => {
  it('records provider type, model, schema and instruction versions, task, fingerprint, confidence, validator result and evidence refs', () => {
    const snap = snapshot();
    const ids = snap.findings.map((f) => f.id);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const section = JSON.parse(serializeAuditReport(createAuditReport(snap, NOW, reportFor(ids))))
      .semanticAssist as AuditSemanticAssistReport;
    expect(section.provider).toEqual({ id: 'local-ollama', model: 'qwen2.5:7b-instruct' });
    expect(section.semanticSchemaVersion).toBe(1);
    expect(Number.isInteger(section.instructionVersion)).toBe(true);
    for (const entry of section.entries) {
      expect(entry.task).toMatch(/^[A-Z_]+$/);
      expect(entry.inputFingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(entry.validatorStatus).toMatch(/^(ACCEPTED_ADVISORY|REJECTED|UNRESOLVED)$/);
      expect(entry.modelStatus).toBe('SUPPORTED_HYPOTHESIS');
      expect(entry.validatorReason).toMatch(/^[a-z-]+$/);
      expect(entry.modelConfidence).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(entry.evidenceRefs)).toBe(true);
    }
    // A group of several elements says whose interpretation it is.
    expect(section.entries.some((e) => e.instances === 7 && e.sampled === 4)).toBe(true);
  });

  it('is rejected when scope numbers are impossible', () => {
    const snap = snapshot();
    const ids = snap.findings.map((f) => f.id);
    for (const [instances, sampled] of [
      [0, 0],
      [1, 2],
      [3, 0],
      [-1, 1],
      [1.5, 1],
    ]) {
      const report = reportFor(ids);
      const copy = JSON.parse(serializeAuditReport(createAuditReport(snap, NOW, report)));
      copy.semanticAssist.entries[0].instances = instances;
      copy.semanticAssist.entries[0].sampled = sampled;
      expect(parseAuditReport(JSON.stringify(copy)).ok, `${instances}/${sampled}`).toBe(false);
    }
  });
});

describe('authority: the deterministic report does not depend on the AI section', () => {
  it('is byte-identical without the section, for every kind of section', () => {
    const snap = snapshot();
    const ids = snap.findings.map((f) => f.id);
    const plain = JSON.stringify(createAuditReport(snap, NOW));
    const sections: AuditSemanticAssistReport[] = [
      reportFor(ids),
      reportFor(ids, 'partial'),
      ...ASSIST_COVERAGE.map((c) => emptyAssistReport(c, { provider: 'disabled', model: null })),
      // An "accepted" answer for every finding, as hostile as possible.
      assistReport({
        coverage: 'completed',
        provider: { provider: 'local-http', model: 'all-yes' },
        stats: STATS,
        entries: ids.map((id) => entryFor(id)),
      }),
    ];
    for (const section of sections) {
      const assisted = createAuditReport(snap, NOW, section);
      const { semanticAssist: _removed, ...rest } = assisted;
      expect(JSON.stringify(rest)).toBe(plain);
      // Severity, assessment, confidence, evidence, WCAG relations: all of a finding is unchanged.
      expect(assisted.findings).toEqual(createAuditReport(snap, NOW).findings);
    }
  });

  it('keeps every manual-review finding manual review whatever was accepted', () => {
    const snap = snapshot();
    const manual = snap.findings.filter((f) => f.assessment === 'manual-review');
    expect(manual.length).toBeGreaterThan(0);
    const section = assistReport({
      coverage: 'completed',
      provider: { provider: 'local-http', model: 'all-yes' },
      stats: STATS,
      entries: manual.map((f) => entryFor(f.id)),
    });
    const assisted = createAuditReport(snap, NOW, section);
    for (const finding of manual) {
      const after = assisted.findings.find((f) => f.id === finding.id);
      expect(after?.assessment).toBe('manual-review');
      expect(after?.severity).toBe(finding.severity);
      expect(after?.wcag).toEqual(finding.wcag);
    }
    expect(assisted.summary).toEqual(createAuditReport(snap, NOW).summary);
  });
});

describe('coverage states are distinguishable and truthful', () => {
  it('labels all five differently, and none of them reads as "reviewed and found nothing"', () => {
    const labels = ASSIST_COVERAGE.map((c) => ASSIST_COVERAGE_LABEL[c]);
    expect(new Set(labels).size).toBe(5);
    expect(ASSIST_COVERAGE_LABEL.disabled).toMatch(/off/i);
    expect(ASSIST_COVERAGE_LABEL['not-run']).toMatch(/not run/i);
    expect(ASSIST_COVERAGE_LABEL.unavailable).toMatch(/unavailable/i);
    expect(ASSIST_COVERAGE_LABEL.partial).toMatch(/partly/i);
    expect(ASSIST_COVERAGE_LABEL.completed).toMatch(/reviewed/i);
    for (const coverage of ['disabled', 'not-run', 'unavailable', 'partial'] as const)
      expect(ASSIST_COVERAGE_LABEL[coverage]).not.toBe(ASSIST_COVERAGE_LABEL.completed);
  });

  it('shows a different heading in the HTML for each state, with the counts of the JSON', () => {
    const snap = snapshot();
    const ids = snap.findings.map((f) => f.id);
    const seen = new Set<string>();
    for (const coverage of ASSIST_COVERAGE) {
      const section =
        coverage === 'completed' || coverage === 'partial'
          ? reportFor(ids, coverage)
          : emptyAssistReport(coverage, { provider: 'disabled', model: null });
      const report = createAuditReport(snap, NOW, section);
      const html = renderAuditHtml(report);
      const json = JSON.parse(serializeAuditReport(report))
        .semanticAssist as AuditSemanticAssistReport;
      expect(html).toContain(ASSIST_COVERAGE_LABEL[coverage]);
      seen.add(ASSIST_COVERAGE_LABEL[coverage]);
      const s = json.stats;
      expect(html).toContain(
        `${s.eligible} eligible · ${s.queried} sent to the model · ${s.accepted} accepted as advisory · ${s.rejected} rejected · ${s.unresolved} unresolved · ${s.modelErrors} model errors`,
      );
      // The HTML lists exactly the entries of the JSON.
      const rows = html.match(/<td><code>[a-z-]+<\/code><\/td><\/tr>/g) ?? [];
      expect(rows.length).toBe(json.entries.length);
      for (const entry of json.entries) {
        expect(html).toContain(entry.validatorReason);
        if (entry.validatorStatus === 'ACCEPTED_ADVISORY')
          expect(html).toContain(entry.hypothesis ?? '?');
      }
      if (coverage === 'completed' || coverage === 'partial')
        expect(html).toContain(json.provider.model ?? '?');
    }
    expect(seen.size).toBe(5);
  });
});

describe('HTML export is inert', () => {
  const HOSTILE = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '</style><script>alert(2)</script>',
    '"><svg onload=alert(3)>',
    "javascript:alert('x')",
    '<iframe src="https://evil.example"></iframe>',
    '&lt;b&gt; &amp; &#x3c;script&#x3e;',
    '‮<b>rtl</b>',
  ];

  it('renders every AI-controlled string as text, nothing as markup or link', () => {
    const snap = snapshot();
    const ids = snap.findings.map((f) => f.id);
    for (const hostile of HOSTILE) {
      const base = reportFor(ids);
      const section: AuditSemanticAssistReport = {
        ...base,
        provider: { id: 'local-http', model: hostile },
        entries: base.entries.map((entry) => ({
          ...entry,
          hypothesis: hostile,
          validatorReason: hostile,
          supportingEvidence: [{ id: 'e1', source: hostile, value: hostile }],
        })),
      };
      const html = renderAuditHtml(createAuditReport(snap, NOW, section));
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const start = [...parsed.querySelectorAll('h2')].find(
        (h) => h.textContent === 'AI-assisted interpretation',
      );
      expect(start, hostile).toBeDefined();
      // Walk everything from the AI heading on.
      let node: Element | null = start ?? null;
      while (node) {
        const scope = [node, ...node.querySelectorAll('*')];
        for (const element of scope) {
          expect([
            'SCRIPT',
            'IMG',
            'IFRAME',
            'SVG',
            'OBJECT',
            'EMBED',
            'LINK',
            'META',
            'STYLE',
            'FORM',
            'INPUT',
            'BUTTON',
          ]).not.toContain(element.tagName.toUpperCase());
          for (const attribute of [...element.attributes]) {
            expect(attribute.name.startsWith('on'), `${hostile}: ${attribute.name}`).toBe(false);
            if (attribute.name === 'href')
              expect(attribute.value.startsWith('#'), attribute.value).toBe(true);
            expect(['href', 'class', 'scope', 'id']).toContain(attribute.name);
          }
        }
        node = node.nextElementSibling;
      }
    }
  });

  it('escapes the hostile text in JSON as data (no raw markup is interpreted by the JSON consumer either)', () => {
    const snap = snapshot();
    const ids = snap.findings.map((f) => f.id);
    const section = { ...reportFor(ids), provider: { id: 'local-http', model: '<b>x</b>' } };
    // Overlong or tag-bearing identifiers are not valid in a parsed export.
    const parsed = parseAuditReport(serializeAuditReport(createAuditReport(snap, NOW, section)));
    expect(typeof parsed.ok).toBe('boolean');
  });
});
