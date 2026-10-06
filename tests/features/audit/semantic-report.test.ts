import { describe, expect, it } from 'vitest';
import {
  createAuditReport,
  parseAuditReport,
  renderAuditHtml,
  serializeAuditReport,
  type AuditSemanticAssistEntry,
} from '@core/audit';
import {
  MockSemanticProvider,
  SemanticAssistEngine,
  assistReport,
  emptyAssistReport,
  entryOf,
  type AssistOutcome,
  type ProviderRequest,
  type SemanticQuery,
} from '@core/semantic-ai';
import { createChartEnvironment } from '../charts/engine';
import { DEUTAN, mountAudit } from './kit';
import { REPRESENTATIVE_CSS } from './fixtures';

/** A confirmed issue, and a canvas chart inside a control (named, operated: two independent facts). */
const MARKUP = `
  <p id="low" class="low">Low contrast paragraph that is hard to read</p>
  <button id="b" type="button"><canvas id="c" class="sales-chart" aria-label="Sales by region" width="300" height="150"></canvas></button>
  <p class="x">${'x'.repeat(0)}</p>
`;

function setup() {
  const rig = mountAudit(MARKUP, {
    css: REPRESENTATIVE_CSS,
    chartEnv: createChartEnvironment(document),
    settings: DEUTAN,
  });
  const snapshot = rig.run();
  return { rig, snapshot, response: rig.audit.semanticCases({ includeIds: [] }) };
}

/** A model that always says the target carries information, citing the evidence it was shown. */
function informative(request: ProviderRequest): string {
  const query = JSON.parse(request.payload) as SemanticQuery;
  return JSON.stringify({
    schemaVersion: 1,
    outcome: 'SUPPORTED_HYPOTHESIS',
    label: 'carries-information',
    confidence: 0.91,
    evidenceRefs: query.deterministicEvidence.slice(0, 2).map((e) => e.id),
  });
}

async function interpret() {
  const { snapshot, response } = setup();
  const provider = new MockSemanticProvider({ respond: informative, model: 'replay-1' });
  const engine = new SemanticAssistEngine(provider);
  const entries: AuditSemanticAssistEntry[] = [];
  const queries = new Map(response.cases.map((c) => [c.findingId, c.bound.query]));
  const summary = await engine.run(
    response.cases.map((c) => ({ id: c.findingId, bound: c.bound, priority: c.priority })),
    {
      isCurrent: () => true,
      onResult: (outcome: AssistOutcome) => {
        const query = queries.get(outcome.id);
        const entry = query ? entryOf(outcome, query) : null;
        if (entry) entries.push(entry);
      },
    },
  );
  return {
    snapshot,
    report: assistReport({
      coverage: summary.coverage,
      provider: provider.identity(),
      stats: summary.stats,
      entries,
    }),
  };
}

describe('the report with an AI-assisted section', () => {
  it('validates, and never changes a finding', async () => {
    const { snapshot, report } = await interpret();
    expect(report.entries.length).toBeGreaterThan(0);
    const plain = createAuditReport(snapshot, 1_700_000_000_000);
    const assisted = createAuditReport(snapshot, 1_700_000_000_000, report);
    const parsed = parseAuditReport(serializeAuditReport(assisted));
    expect(parsed.ok).toBe(true);
    // Take the section away and the report is byte-identical to one that never had it.
    const { semanticAssist: _removed, ...rest } = assisted;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(plain));
    expect(assisted.findings).toEqual(plain.findings);
    expect(assisted.summary).toEqual(plain.summary);
  });

  it('records provenance and nothing raw', async () => {
    const { snapshot, report } = await interpret();
    const json = serializeAuditReport(createAuditReport(snapshot, 1, report));
    const section = JSON.parse(json).semanticAssist as typeof report;
    expect(section.aiAssisted).toBe(true);
    expect(section.provider).toEqual({ id: 'mock', model: 'replay-1' });
    expect(section.semanticSchemaVersion).toBe(1);
    for (const entry of section.entries) {
      expect(Object.keys(entry).sort()).toEqual([
        'evidenceRefs',
        'findingId',
        'hypothesis',
        'inputFingerprint',
        'instances',
        'modelConfidence',
        'modelStatus',
        'sampled',
        'supportingEvidence',
        'task',
        'validatorReason',
        'validatorStatus',
      ]);
    }
    // No prompt, no instructions, no packet, no model text.
    for (const word of [
      'instructions',
      'PAYLOAD',
      'allowedLabels',
      'deterministicEvidence',
      'schemaVersion":1,"outcome',
    ]) {
      expect(json).not.toContain(word);
    }
  });

  it('is rejected when an entry names a finding that is not in the report, or smuggles a field', async () => {
    const { snapshot, report } = await interpret();
    const entry = report.entries[0]!;
    const bad = (mutate: (e: Record<string, unknown>) => void): boolean => {
      const copy = JSON.parse(serializeAuditReport(createAuditReport(snapshot, 1, report)));
      mutate(copy.semanticAssist.entries[0]);
      return parseAuditReport(JSON.stringify(copy)).ok;
    };
    expect(bad(() => undefined)).toBe(true);
    expect(bad((e) => (e.findingId = 'CA-SEM-002:0000000000000000'))).toBe(false);
    expect(bad((e) => (e.rawOutput = '{"label":"error"}'))).toBe(false);
    expect(bad((e) => (e.validatorStatus = 'CONFIRMED'))).toBe(false);
    expect(bad((e) => (e.modelConfidence = 7))).toBe(false);
    expect(bad((e) => (e.inputFingerprint = 'not-a-hash'))).toBe(false);
    expect(bad((e) => ((e.validatorStatus = 'ACCEPTED_ADVISORY'), (e.hypothesis = null)))).toBe(
      false,
    );
    expect(entry.validatorStatus).toBe('ACCEPTED_ADVISORY');
  });

  it('says so when the review was off or not run, and never looks like a clean result', () => {
    const { snapshot } = setup();
    for (const coverage of ['disabled', 'not-run', 'unavailable'] as const) {
      const section = emptyAssistReport(coverage, { provider: 'disabled', model: null });
      const report = createAuditReport(snapshot, 1, section);
      expect(parseAuditReport(serializeAuditReport(report)).ok).toBe(true);
      expect(report.semanticAssist?.entries).toEqual([]);
      expect(report.semanticAssist?.aiAssisted).toBe(false);
    }
  });

  it('renders apart from the findings, labelled advisory, with every string escaped', async () => {
    const { snapshot, report } = await interpret();
    const html = renderAuditHtml(createAuditReport(snapshot, 1, report));
    expect(html).toContain('AI-assisted interpretation');
    expect(html).toContain('Not a confirmed deterministic finding');
    expect(html).toContain('Likely meaning');
    expect(html).not.toMatch(/<script/i);
    const marker = html.indexOf('<h2>AI-assisted interpretation</h2>');
    expect(marker).toBeGreaterThan(html.lastIndexOf('</details>') - 1);
  });

  it('escapes hostile text in the section', async () => {
    const { snapshot, report } = await interpret();
    const hostile = {
      ...report,
      provider: { id: 'mock', model: '<img src=x onerror=alert(1)>' },
    };
    const html = renderAuditHtml(createAuditReport(snapshot, 1, hostile));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});
