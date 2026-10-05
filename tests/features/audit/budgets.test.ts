import { describe, expect, it } from 'vitest';
import {
  AUDIT_LIMITS,
  createAuditReport,
  parseAuditReport,
  serializeAuditReport,
} from '@core/audit';
import { AUDIT_MAX_ELEMENTS } from '@features/page-analysis';
import { DEUTAN, findingsOf, mountAudit } from './kit';

const CSS = `
  .low { color: #aaaaaa; background-color: #ffffff; }
  .f { border-top-style: solid; border-top-width: 1px; border-top-color: #888888; }
  .f[aria-invalid="true"] { border-top-color: #c0392b; }
`;

const rows = (count: number) =>
  Array.from({ length: count }, (_, i) => `<p class="low" id="p${i}">row ${i}</p>`).join('');

/**
 * Structural budgets, not clocks: nothing here asserts how long anything takes. The budgets are
 * injectable so most cases run small; one case runs the product's real budget end to end (it is the
 * heaviest test of the audit, so it is the only one at that size). The cap on the number of findings
 * is covered without a DOM in tests/core/audit/pipeline.test.ts.
 */
describe('large pages', () => {
  it('stops at the element budget, says so, and still counts exactly what it audited', () => {
    const rig = mountAudit(rows(200), { css: CSS, settings: DEUTAN, auditMaxElements: 120 });
    const snapshot = rig.run('active');
    expect(snapshot.coverage.analysisTruncated).toBe(true);
    expect(snapshot.coverage.elementsAnalyzed).toBe(120);
    const contrast = findingsOf(snapshot, 'CA-COLOR-001');
    expect(contrast).toHaveLength(1);
    expect(contrast[0]?.affectedCount).toBe(120);
    expect(contrast[0]?.affected).toHaveLength(AUDIT_LIMITS.sampleTargets);
    const limit = findingsOf(snapshot, 'CA-GEN-001')[0];
    expect(limit?.assessment).toBe('analysis-limitation');
    expect(limit?.severity).toBe('info');
    // Nothing is silently dropped: the limitation is a finding of its own.
    expect(snapshot.summary.findings).toBe(2);
  });

  it('does not report a limit when the page fits the budget', () => {
    const snapshot = mountAudit(rows(60), {
      css: CSS,
      settings: DEUTAN,
      auditMaxElements: 120,
    }).run('active');
    expect(snapshot.coverage.analysisTruncated).toBe(false);
    expect(findingsOf(snapshot, 'CA-GEN-001')).toEqual([]);
  });

  it('audits the product’s real budget of elements and says what it left out', () => {
    const rig = mountAudit(rows(AUDIT_MAX_ELEMENTS + 100), { css: CSS, settings: DEUTAN });
    const snapshot = rig.run('active');
    expect(snapshot.coverage.analysisTruncated).toBe(true);
    expect(snapshot.coverage.elementsAnalyzed).toBe(AUDIT_MAX_ELEMENTS);
    const contrast = findingsOf(snapshot, 'CA-COLOR-001');
    expect(contrast).toHaveLength(1);
    expect(contrast[0]?.affectedCount).toBe(AUDIT_MAX_ELEMENTS);
    expect(contrast[0]?.affected).toHaveLength(AUDIT_LIMITS.sampleTargets);
    expect(findingsOf(snapshot, 'CA-GEN-001')).toHaveLength(1);
    const text = serializeAuditReport(createAuditReport(snapshot, 1));
    expect(text.length).toBeLessThan(200_000); // 5000 problems, one finding, fifty listed
    expect(parseAuditReport(text).ok).toBe(true);
  }, 120_000);

  it('groups many identical problems into findings with exact counts and a small report', () => {
    const pairs = Array.from(
      { length: 120 },
      () => '<input class="f" aria-invalid="true" aria-label="x"><input class="f" aria-label="y">',
    ).join('');
    const snapshot = mountAudit(pairs, { css: CSS, settings: DEUTAN }).run('active');
    const found = findingsOf(snapshot, 'CA-SEM-001');
    expect(found.length).toBeGreaterThan(0);
    expect(found.reduce((sum, f) => sum + f.affectedCount, 0)).toBe(120);
    for (const f of found)
      expect(f.affected.length).toBeLessThanOrEqual(AUDIT_LIMITS.sampleTargets);
    const text = serializeAuditReport(createAuditReport(snapshot, 1));
    expect(text.length).toBeLessThan(100_000);
    expect(parseAuditReport(text).ok).toBe(true);
  });

  it('costs nothing when no audit is open: no pass, no observer, no read of the page layers', () => {
    const rig = mountAudit('<p class="low">x</p>', { css: CSS });
    expect(rig.reads()).toBe(0);
    expect(rig.audit.diagnostics()).toMatchObject({
      auditPasses: 0,
      auditWatching: false,
      auditHighlightVisible: false,
    });
  });
});
