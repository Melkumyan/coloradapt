import { describe, expect, it } from 'vitest';
import { canonicalPacket } from '@core/semantic-ai';
import { createChartEnvironment } from '../charts/engine';
import { DEUTAN, mountAudit } from './kit';
import { REPRESENTATIVE_CSS, REPRESENTATIVE_MARKUP } from './fixtures';

/** Class names only: the state is inferred (CA-SEM-002, manual review), color is the only difference. */
const CLASS_ONLY_CSS = `
  .pill { display: inline-block; width: 12px; height: 12px; border-radius: 6px; }
  .pill.is-error { background: #c62828; }
  .pill.is-success { background: #2e7d32; }
  body { margin: 0; background: #fff; color: #111; }
`;
const CLASS_ONLY = `
  <ul id="list" aria-label="Services">
    <li><span id="p1" class="pill is-error"></span> <span>Payments</span></li>
    <li><span id="p2" class="pill is-success"></span> <span>Search</span></li>
    <li><span id="p3" class="pill is-success"></span> <span>Mail</span></li>
  </ul>
`;

describe('AuditController.semanticCases', () => {
  it('has nothing to ask before the first pass', () => {
    const rig = mountAudit(CLASS_ONLY, { css: CLASS_ONLY_CSS });
    expect(rig.audit.semanticCases({ includeIds: [] })).toEqual({
      generation: 0,
      page: null,
      eligible: 0,
      cases: [],
      heterogeneous: [],
    });
  });

  it('builds packets only for manual-review findings of eligible rules', () => {
    const rig = mountAudit(REPRESENTATIVE_MARKUP, {
      css: REPRESENTATIVE_CSS,
      chartEnv: createChartEnvironment(document),
      settings: DEUTAN,
    });
    const snapshot = rig.run();
    const response = rig.audit.semanticCases({ includeIds: [] });
    const manual = snapshot.findings.filter((f) => f.assessment === 'manual-review');
    expect(manual.length).toBeGreaterThan(0);
    // Confirmed issues (contrast, simulation, chart series, declared state) never reach the model.
    const confirmed = new Set(
      snapshot.findings.filter((f) => f.assessment === 'issue').map((f) => f.id),
    );
    for (const item of response.cases) {
      expect(confirmed.has(item.findingId)).toBe(false);
      const finding = snapshot.findings.find((f) => f.id === item.findingId);
      expect(finding?.assessment).toBe('manual-review');
      expect(item.bound.query.context.ruleIds).toEqual([finding?.ruleId]);
    }
    expect(response.cases.map((c) => c.task).sort()).toEqual(
      manual.map(() => 'ASSESS_MANUAL_REVIEW_CASE').sort(),
    );
    expect(response.generation).toBe(snapshot.generation);
  });

  it('gives clean pages no case at all', () => {
    const rig = mountAudit('<p id="fine">Perfectly readable paragraph</p>', {
      css: 'body{background:#fff;color:#111}',
    });
    rig.run();
    expect(rig.audit.semanticCases({ includeIds: [] }).cases).toEqual([]);
  });

  it('carries no form value and no URL in any packet of a page that has both', () => {
    const rig = mountAudit(
      `${REPRESENTATIVE_MARKUP}
       <input id="secret" type="text" value="hunter2-secret-value" aria-label="Token">
       <a href="https://example.test/reset?token=SECRET#frag">Reset password</a>
       <textarea id="note">my private note</textarea>
       <div contenteditable="true">editable private text</div>`,
      { css: REPRESENTATIVE_CSS, chartEnv: createChartEnvironment(document), settings: DEUTAN },
    );
    rig.run();
    const text = rig.audit
      .semanticCases({ includeIds: [] })
      .cases.map((c) => canonicalPacket(c.bound.query))
      .join('\n');
    for (const secret of ['hunter2', 'SECRET', 'my private note', 'editable private', 'https://']) {
      expect(text).not.toContain(secret);
    }
  });

  it('is deterministic: the same page gives the same fingerprints', () => {
    const rig = mountAudit(REPRESENTATIVE_MARKUP, {
      css: REPRESENTATIVE_CSS,
      chartEnv: createChartEnvironment(document),
      settings: DEUTAN,
    });
    rig.run();
    const first = rig.audit.semanticCases({ includeIds: [] });
    rig.run();
    const second = rig.audit.semanticCases({ includeIds: [] });
    expect(second.cases.map((c) => [c.findingId, c.bound.inputHash])).toEqual(
      first.cases.map((c) => [c.findingId, c.bound.inputHash]),
    );
  });

  it('changes the fingerprint when the element is replaced by a different one', () => {
    const rig = mountAudit(REPRESENTATIVE_MARKUP, {
      css: REPRESENTATIVE_CSS,
      chartEnv: createChartEnvironment(document),
      settings: DEUTAN,
    });
    rig.run();
    const before = rig.audit.semanticCases({ includeIds: [] }).cases;
    const canvas = document.querySelector('#canvas-chart');
    canvas?.setAttribute('aria-label', 'Sales by region');
    rig.run();
    const after = rig.audit.semanticCases({ includeIds: [] }).cases;
    const find = (cases: typeof before) =>
      cases.find((c) => c.bound.query.context.ruleIds[0] === 'CA-CHART-004');
    expect(find(before)?.findingId).toBe(find(after)?.findingId);
    expect(find(before)?.bound.inputHash).not.toBe(find(after)?.bound.inputHash);
  });
});

describe('AuditController.semanticCases: a state inferred from class names', () => {
  it('asks about it, and gives the packet no unrelated class name and no id', () => {
    const rig = mountAudit(CLASS_ONLY, { css: CLASS_ONLY_CSS });
    const snapshot = rig.run();
    const response = rig.audit.semanticCases({ includeIds: [] });
    expect(response.eligible).toBe(snapshot.findings.length);
    expect(response.cases.map((c) => c.task)).toEqual(
      response.cases.map(() => 'CLASSIFY_STATUS_MEANING'),
    );
    for (const item of response.cases) {
      const text = canonicalPacket(item.bound.query);
      expect(text).not.toContain('pill is-');
      expect(text).not.toContain('"p1"');
      expect(text).not.toContain('Services');
      expect(item.bound.query.deterministicEvidence.map((e) => e.kind).sort()).toEqual([
        'class',
        'context',
      ]);
    }
  });

  describe('representative-per-group safety', () => {
    /** One finding (CA-SVG-002, same reason) holds icons that mean different things. */
    const icon = (label: string, i: number): string =>
      `<button type="button"><svg aria-label="${label}" role="img" width="24" height="24" viewBox="0 0 24 24"><defs><linearGradient id="g${i}"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><path d="M0 0h24v24H0z" fill="url(#g${i})"/></svg></button>`;
    const mount = (labels: readonly string[]) =>
      mountAudit(labels.map(icon).join(''), {
        css: 'body{background:#fff}',
        settings: DEUTAN,
        svgEngine: true,
      });

    it('never gives one answer to a finding whose elements mean different things', () => {
      const rig = mount(['Close', 'Delete', 'Search']);
      const snapshot = rig.run();
      expect(snapshot.findings).toHaveLength(1);
      expect(snapshot.findings[0]?.affected).toHaveLength(3);
      const response = rig.audit.semanticCases({ includeIds: [] });
      expect(response.cases).toEqual([]);
      expect(response.heterogeneous).toEqual([snapshot.findings[0]?.id]);
      expect(response.eligible).toBe(1);
    });

    it('asks about a group whose sampled elements agree once, as its representative', () => {
      const rig = mount(['Close', 'Close', 'Close']);
      rig.run();
      const response = rig.audit.semanticCases({ includeIds: [] });
      expect(response.heterogeneous).toEqual([]);
      expect(response.cases).toHaveLength(1);
      expect(response.cases[0]).toMatchObject({ instances: 3, sampled: 3 });
    });

    it('splits a group the moment one sampled element differs, even the last of four', () => {
      const rig = mount(['Close', 'Close', 'Close', 'Search']);
      rig.run();
      expect(rig.audit.semanticCases({ includeIds: [] }).heterogeneous).toHaveLength(1);
    });

    it('says honestly that elements beyond the sample were not compared', () => {
      const rig = mount(['Close', 'Close', 'Close', 'Close', 'Close', 'Search']);
      rig.run();
      const response = rig.audit.semanticCases({ includeIds: [] });
      // The sixth element is outside the sample: the answer is labelled representative-only.
      expect(response.cases[0]).toMatchObject({ instances: 6, sampled: 4 });
    });

    it('is hidden again when the group stops being uniform', () => {
      const rig = mount(['Close', 'Close']);
      rig.run();
      const before = rig.audit.semanticCases({ includeIds: [] });
      expect(before.cases).toHaveLength(1);
      const labels = document.querySelectorAll('svg');
      labels[1]?.setAttribute('aria-label', 'Delete');
      rig.run();
      const after = rig.audit.semanticCases({ includeIds: [before.cases[0]?.findingId ?? ''] });
      expect(after.cases).toEqual([]);
    });
  });
});
