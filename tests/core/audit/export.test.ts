import { describe, expect, it } from 'vitest';
import {
  AUDIT_SCHEMA_VERSION,
  buildSnapshot,
  canonicalJson,
  createAuditReport,
  parseAuditReport,
  renderAuditHtml,
  serializeAuditReport,
  type AuditCandidate,
} from '@core/audit';
import { FACTORS, candidate, target } from './builders';

const snapshotOf = (
  candidates: readonly AuditCandidate[],
  page = { origin: 'https://example.test', pathname: '/a' },
) =>
  buildSnapshot({
    candidates,
    generation: 3,
    timestamp: 1_700_000_000_000,
    page,
    extensionVersion: '0.1.0',
    settings: {
      activeProfile: 'deuteranopia',
      auditedProfiles: ['deuteranopia'],
      adaptationEnabled: true,
    },
    coverage: {
      elementsAnalyzed: 9,
      analysisTruncated: false,
      semanticCandidates: 2,
      svgUnits: 0,
      charts: 0,
      canvases: 0,
      images: 0,
    },
  }).snapshot;

const SAMPLE = [
  candidate({ target: target('html>body>p:nth-of-type(1)', 'p', { text: 'Hello' }) }),
  candidate({
    ruleId: 'CA-SEM-001',
    context: 'invalid',
    target: target('html>body>input:nth-of-type(1)', 'input:email', {
      tag: 'input',
      inputType: 'email',
    }),
    factors: { ...FACTORS, informationLoss: 'total', functionalImpact: 'major', interactive: true },
  }),
  candidate({
    ruleId: 'CA-CHART-004',
    assessment: 'manual-review',
    context: 'canvas',
    target: target('html>body>canvas', 'canvas'),
  }),
];

describe('JSON report', () => {
  it('has a schema version, a tool, a sanitized page and the summary of its findings', () => {
    const report = createAuditReport(snapshotOf(SAMPLE), 1_700_000_100_000);
    expect(report.schemaVersion).toBe(AUDIT_SCHEMA_VERSION);
    expect(report.tool).toEqual({ name: 'ColorAdapt', version: '0.1.0' });
    expect(report.generatedAt).toBe(new Date(1_700_000_100_000).toISOString());
    expect(report.audit.basis).toBe('original-page-state');
    expect(report.summary.findings).toBe(report.findings.length);
  });

  it('is byte-identical for identical input except generatedAt', () => {
    const a = serializeAuditReport(createAuditReport(snapshotOf(SAMPLE), 1_000));
    const b = serializeAuditReport(createAuditReport(snapshotOf([...SAMPLE].reverse()), 2_000));
    const strip = (text: string) => text.replace(/"generatedAt": "[^"]+"/, '"generatedAt": ""');
    expect(strip(b)).toBe(strip(a));
    expect(a).not.toBe(b);
  });

  it('sorts keys so a diff shows only what changed', () => {
    const text = canonicalJson({ b: 1, a: { d: 1, c: [{ z: 1, y: 2 }] } }, 0);
    expect(text).toBe('{"a":{"c":[{"y":2,"z":1}],"d":1},"b":1}');
  });

  it('round-trips through the validator', () => {
    const text = serializeAuditReport(createAuditReport(snapshotOf(SAMPLE), 5));
    const parsed = parseAuditReport(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.report.findings).toHaveLength(3);
  });

  it('round-trips an empty audit', () => {
    expect(parseAuditReport(serializeAuditReport(createAuditReport(snapshotOf([]), 5))).ok).toBe(
      true,
    );
  });
});

describe('report validation', () => {
  const good = () =>
    JSON.parse(serializeAuditReport(createAuditReport(snapshotOf(SAMPLE), 5))) as Record<
      string,
      any
    >;
  const errors = (data: unknown) => {
    const result = parseAuditReport(JSON.stringify(data));
    return result.ok ? [] : result.errors;
  };

  it('rejects text that is not JSON, and other versions', () => {
    expect(parseAuditReport('nope').ok).toBe(false);
    expect(errors({ ...good(), schemaVersion: 2 }).join()).toContain('schemaVersion');
  });

  it('rejects a summary that does not match its findings', () => {
    const data = good();
    data.summary.findings += 1;
    expect(errors(data).join()).toContain('summary does not match');
  });

  it('rejects a page with a query or fragment', () => {
    const data = good();
    data.page.pathname = '/a?token=SECRET';
    expect(errors(data).join()).toContain('query or fragment');
  });

  it('rejects text on a form control', () => {
    const data = good();
    const field = data.findings.find((f: any) => f.ruleId === 'CA-SEM-001');
    field.affected[0].locator.text = 'typed value';
    expect(errors(data).join()).toContain('form control');
  });

  it('rejects an unknown rule, a bad enum and a duplicate id', () => {
    const data = good();
    data.findings[0].ruleId = 'CA-NOPE-001';
    data.findings[1].severity = 'catastrophic';
    data.findings[2].id = data.findings[1].id;
    const found = errors(data).join('|');
    expect(found).toContain('unknown ruleId');
    expect(found).toContain('severity invalid');
    expect(found).toContain('duplicate id');
  });

  it('rejects more listed elements than were counted', () => {
    const data = good();
    data.findings[0].affectedCount = 1;
    data.findings[0].affected.push({ ...data.findings[0].affected[0], instanceId: 'x' });
    expect(errors(data).join()).toContain('more elements');
  });
});

describe('HTML report', () => {
  const hostile = [
    candidate({
      summary: '<script>alert(1)</script>',
      target: target('html>body>p', 'p', {
        text: '<img src=x onerror=alert(1)>',
        classes: ['"><svg onload=1>'],
      }),
      evidence: [
        {
          key: 'x',
          basis: 'observed-fact',
          label: '<b>label</b>',
          value: { kind: 'text', text: 'javascript:alert(1)' },
        },
      ],
    }),
  ];
  const html = renderAuditHtml(
    createAuditReport(
      snapshotOf(hostile, { origin: 'https://example.test', pathname: '/<script>' }),
      1,
    ),
  );

  it('escapes every page-derived string', () => {
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<svg onload');
    expect(html).not.toContain('<b>label</b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('contains no script element, no event handler attribute, and no link that loads anything', () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<[^>]*\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/<(?:link|img|iframe|object|embed|video|audio|source)\b/i);
    expect(html).not.toMatch(/<[^>]*\b(?:src|href)\s*=/i);
    expect(html).not.toMatch(/@import|url\(/i);
  });

  it('forbids everything but inline style with a Content-Security-Policy', () => {
    expect(html).toContain(`default-src 'none'; style-src 'unsafe-inline'`);
  });

  it('shows severity as a word and a shape, never an unlabeled color', () => {
    const report = renderAuditHtml(createAuditReport(snapshotOf(SAMPLE), 1));
    expect(report).toMatch(/[⬢▲◆■●] (?:Critical|High|Medium|Low|Info)/);
  });

  it('says what it is not: no score, no conformance claim', () => {
    expect(html).toMatch(/not a conformance statement and there is no score/);
  });
});
