import { describe, expect, it } from 'vitest';
import {
  AUDIT_LIMITS,
  AUDIT_SUBSYSTEM_IDS,
  buildSnapshot,
  createAuditReport,
  parseAuditReport,
  renderAuditHtml,
  serializeAuditReport,
  type AuditCandidate,
} from '@core/audit';
import { candidate, target } from './builders';

const snapshotOf = (
  candidates: readonly AuditCandidate[],
  coverage: Partial<Parameters<typeof buildSnapshot>[0]['coverage']> = {},
) =>
  buildSnapshot({
    candidates,
    generation: 1,
    timestamp: 1,
    page: { origin: 'https://example.test', pathname: '/' },
    extensionVersion: '0.1.0',
    settings: { activeProfile: 'deuteranopia', auditedProfiles: [], adaptationEnabled: true },
    coverage: {
      elementsAnalyzed: 10,
      analysisTruncated: false,
      semanticCandidates: 0,
      svgUnits: 0,
      charts: 0,
      canvases: 0,
      images: 0,
      ...coverage,
    },
  }).snapshot;

const level = (snapshot: ReturnType<typeof snapshotOf>, id: string) =>
  snapshot.coverage.subsystems.find((s) => s.id === id)?.level;

describe('M9.R1 coverage model', () => {
  it('lists every subsystem once, in a fixed order, whatever the page', () => {
    const a = snapshotOf([]);
    const b = snapshotOf([candidate()], { analysisTruncated: true, imagePixelAudit: true });
    expect(a.coverage.subsystems.map((s) => s.id)).toEqual([...AUDIT_SUBSYSTEM_IDS]);
    expect(b.coverage.subsystems.map((s) => s.id)).toEqual([...AUDIT_SUBSYSTEM_IDS]);
  });

  it('M8 pixel audit is disclosed as disabled unless the image layer is on', () => {
    const off = snapshotOf([]);
    expect(level(off, 'image-pixels')).toBe('disabled');
    const note = off.coverage.subsystems.find((s) => s.id === 'image-pixels')?.note ?? '';
    expect(note).toMatch(/image adaptation is disabled/i);
    expect(note).toMatch(/says nothing about the images/i);
    expect(level(snapshotOf([], { imagePixelAudit: true }), 'image-pixels')).toBe('partial');
  });

  it('shadow DOM, frames, borders and focus are never reported as audited', () => {
    for (const snap of [snapshotOf([]), snapshotOf([], { imagePixelAudit: true })]) {
      for (const id of ['shadow-dom', 'iframes', 'borders-focus']) {
        expect(level(snap, id)).toBe('unsupported');
      }
    }
  });

  it('a hit element budget is disclosed once, not as a flood of limitations', () => {
    const snap = snapshotOf([], {
      analysisTruncated: true,
      elementsAnalyzed: 5000,
      budgetsReached: ['analyzed elements'],
    });
    expect(level(snap, 'color-contrast')).toBe('partial');
    expect(snap.coverage.subsystems.find((s) => s.id === 'color-contrast')?.note).toMatch(
      /Audit truncated/,
    );
    expect(snap.findings).toHaveLength(0);
  });

  it('a chart-mark or candidate budget marks only its own subsystem partial with a truncation note', () => {
    const snap = snapshotOf([], { budgetsReached: ['semantic candidates', 'chart marks'] });
    expect(snap.coverage.subsystems.find((s) => s.id === 'semantic-cues')?.note).toMatch(
      /Audit truncated/,
    );
    expect(snap.coverage.subsystems.find((s) => s.id === 'charts')?.note).toMatch(
      /Audit truncated/,
    );
    expect(level(snap, 'color-contrast')).toBe('complete');
  });

  it('budgetsReached is sorted so analysis order cannot change the bytes', () => {
    const a = snapshotOf([], { budgetsReached: ['images', 'chart marks'] });
    const b = snapshotOf([], { budgetsReached: ['chart marks', 'images'] });
    expect(a.coverage.budgetsReached).toEqual(b.coverage.budgetsReached);
  });
});

describe('M9.R1 finding cap boundaries (999 / 1000 / 1001)', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      candidate({
        context: `c${i}`,
        target: target(`html>body>p:nth-of-type(${i + 1})`, `p${i}`),
      }),
    );
  for (const [n, kept, cut] of [
    [AUDIT_LIMITS.maxFindings - 1, 999, 0],
    [AUDIT_LIMITS.maxFindings, 1000, 0],
    [AUDIT_LIMITS.maxFindings + 1, 1000, 1],
    [AUDIT_LIMITS.maxFindings + 250, 1000, 250],
  ] as const) {
    it(`${n} groups -> ${kept} listed, ${cut} counted as truncated, never silently dropped`, () => {
      const snap = snapshotOf(many(n));
      expect(snap.findings).toHaveLength(kept);
      expect(snap.coverage.truncatedFindings).toBe(cut);
      expect(level(snap, 'findings')).toBe(cut > 0 ? 'partial' : 'complete');
      const html = renderAuditHtml(createAuditReport(snap, 1));
      expect(html.includes('Audit truncated: coverage limited')).toBe(cut > 0);
    });
  }
});

describe('M9.R1 exact affected counts beyond the sample cap', () => {
  for (const n of [49, 50, 51, 500, 5000]) {
    it(`${n} elements of one component: count is exact, sample is capped at ${AUDIT_LIMITS.sampleTargets}`, () => {
      const snap = snapshotOf(
        Array.from({ length: n }, (_, i) =>
          candidate({ target: target(`html>body>ul>li:nth-of-type(${i + 1})`, 'li.item') }),
        ),
      );
      expect(snap.findings).toHaveLength(1);
      const finding = snap.findings[0]!;
      expect(finding.affectedCount).toBe(n);
      expect(finding.affected.length).toBe(Math.min(n, AUDIT_LIMITS.sampleTargets));
      expect(snap.summary.affectedElements).toBe(n);
      expect(parseAuditReport(serializeAuditReport(createAuditReport(snap, 1))).ok).toBe(true);
    });
  }
});

describe('M9.R1 coverage in the report', () => {
  it('JSON carries coverage, HTML shows the same levels and notes', () => {
    const snap = snapshotOf([candidate()], { analysisTruncated: true, elementsAnalyzed: 5000 });
    const report = createAuditReport(snap, 1);
    const html = renderAuditHtml(report);
    for (const s of report.coverage.subsystems) {
      expect(html).toContain(s.name.replace(/&/g, '&amp;'));
    }
    expect(html).toContain('Audit truncated: coverage limited');
    expect(html).toMatch(/Confirmed issues: 1 · Manual review: 0 · Analysis limitations: 0\./);
  });

  it('a clean snapshot says what “no findings” means and does not claim completeness', () => {
    const html = renderAuditHtml(createAuditReport(snapshotOf([]), 1));
    expect(html).toMatch(/never that the page is free of problems/);
    expect(html).not.toContain('Audit truncated');
  });

  it('the parser refuses a report that hides a truncation or claims an unsupported area', () => {
    const good = () =>
      JSON.parse(
        serializeAuditReport(
          createAuditReport(snapshotOf([candidate()], { analysisTruncated: true }), 1),
        ),
      ) as Record<string, any>;
    const errors = (data: unknown) => {
      const r = parseAuditReport(JSON.stringify(data));
      return r.ok ? '' : r.errors.join('|');
    };
    expect(errors(good())).toBe('');
    const hide = good();
    hide.coverage.subsystems.find((s: any) => s.id === 'color-contrast').level = 'complete';
    expect(errors(hide)).toContain('hides a truncated analysis');
    const claim = good();
    claim.coverage.subsystems.find((s: any) => s.id === 'iframes').level = 'complete';
    expect(errors(claim)).toContain('iframes');
    const missing = good();
    missing.coverage.subsystems.pop();
    expect(errors(missing)).toContain('lacks');
    const cut = good();
    cut.coverage.truncatedFindings = 3;
    cut.coverage.subsystems.find((s: any) => s.id === 'findings').level = 'complete';
    expect(errors(cut)).toContain('hides truncated findings');
  });
});
