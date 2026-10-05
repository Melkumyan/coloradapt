import { describe, expect, it } from 'vitest';
import { createChartEnvironment } from '../charts/engine';
import { DEUTAN, findingsOf, mountAudit } from './kit';
import { REPRESENTATIVE_CSS, REPRESENTATIVE_MARKUP, SVG_ICON_MARKUP } from './fixtures';

const rows = (snapshot: ReturnType<ReturnType<typeof mountAudit>['run']>) =>
  snapshot.findings
    .map((f) => `${f.ruleId} ${f.affected.map((a) => a.locator.path).join(',')}`)
    .sort();

function representative() {
  return mountAudit(REPRESENTATIVE_MARKUP, {
    css: REPRESENTATIVE_CSS,
    chartEnv: createChartEnvironment(document),
    settings: DEUTAN,
  });
}

describe('representative page (audit-only: adaptation is off)', () => {
  it('produces exactly the expected findings, and nothing else', () => {
    const snapshot = representative().run();
    expect(rows(snapshot)).toEqual([
      'CA-CHART-001 #bad-chart',
      'CA-CHART-004 #canvas-chart',
      'CA-COLOR-001 #cvd',
      'CA-COLOR-001 #low',
      'CA-COLOR-002 #cvd',
      'CA-IMG-002 #raster-chart',
      'CA-SEM-001 #email-a',
    ]);
  });

  it('leaves safe and already-accessible things alone', () => {
    const snapshot = representative().run();
    const flagged = snapshot.findings.flatMap((f) => f.affected.map((a) => a.locator.path));
    for (const id of [
      'fine',
      'brand',
      'deco-a',
      'deco-b',
      'ok-badge',
      'bad-badge',
      'game',
      'good-chart',
      'photo',
      'logo',
    ]) {
      expect(
        flagged.some((p) => p.endsWith(`#${id}`)),
        id,
      ).toBe(false);
    }
  });

  it('separates issues from reviews, and never rates a review above low', () => {
    const snapshot = representative().run();
    for (const finding of snapshot.findings.filter((f) => f.assessment !== 'issue')) {
      expect(['low', 'info']).toContain(finding.severity);
    }
    expect(snapshot.summary.manualReview).toBe(2);
    expect(snapshot.summary.byAssessment.issue).toBe(5);
  });

  it('rates a color-only invalid control above every other finding of the page', () => {
    const snapshot = representative().run();
    expect(snapshot.findings[0]?.ruleId).toBe('CA-SEM-001');
    expect(snapshot.findings[0]?.severity).toBe('critical');
  });

  it('keeps finding confidence separate from the simulation model it rests on', () => {
    const snapshot = representative().run();
    const cvd = findingsOf(snapshot, 'CA-COLOR-002')[0];
    expect(cvd?.confidence).toBe('HIGH');
    expect(cvd?.simulation).toEqual([
      expect.objectContaining({ profile: 'deuteranopia', modelConfidence: 'SUPPORTED_MODEL' }),
    ]);
    const sem = findingsOf(snapshot, 'CA-SEM-001')[0];
    expect(sem?.simulation).toEqual([]);
    expect(sem?.visionProfiles).toEqual([]);
  });

  it('propagates M2’s weaker model status into a finding (anomalous trichromacy is an assumption)', () => {
    const rig = mountAudit(REPRESENTATIVE_MARKUP, {
      css: REPRESENTATIVE_CSS,
      chartEnv: createChartEnvironment(document),
      settings: { ...DEUTAN, visionProfile: 'deuteranomaly', adaptationStrength: 1 },
    });
    const snapshot = rig.run('active');
    for (const finding of snapshot.findings.filter((f) => f.simulation.length > 0)) {
      expect(finding.simulation.every((s) => s.modelConfidence === 'MODEL_ASSUMPTION')).toBe(true);
      expect(['critical']).not.toContain(finding.severity);
    }
  });

  it('records where each finding comes from', () => {
    const snapshot = representative().run();
    expect(findingsOf(snapshot, 'CA-COLOR-001')[0]?.source.primary).toBe('M1');
    expect(findingsOf(snapshot, 'CA-COLOR-002')[0]?.source.primary).toBe('M2');
    expect(findingsOf(snapshot, 'CA-SEM-001')[0]?.source.primary).toBe('M6');
    expect(findingsOf(snapshot, 'CA-CHART-001')[0]?.source.primary).toBe('M7');
    expect(findingsOf(snapshot, 'CA-IMG-002')[0]?.source.primary).toBe('M8');
  });

  it('reports adaptation as off, not as a problem of the page', () => {
    const snapshot = representative().run();
    for (const finding of snapshot.findings.filter((f) => f.assessment === 'issue')) {
      expect(['not-enabled', 'not-applicable']).toContain(finding.adaptationStatus);
    }
    expect(snapshot.settings.adaptationEnabled).toBe(true); // the user setting; the rig never applied it
  });

  it('labels evidence so that facts, inferences, thresholds and estimates are never mixed up', () => {
    const snapshot = representative().run();
    const contrast = findingsOf(snapshot, 'CA-COLOR-001')[0];
    const bases = new Map(contrast?.evidence.map((e) => [e.key, e.basis]));
    expect(bases.get('contrast.ratio')).toBe('observed-fact');
    expect(bases.get('contrast.target')).toBe('engineering-threshold');
    const cvd = findingsOf(snapshot, 'CA-COLOR-002')[0];
    expect(cvd?.evidence.find((e) => e.key.endsWith('distance.simulated'))?.basis).toBe(
      'model-estimate',
    );
    const sem = findingsOf(snapshot, 'CA-SEM-001')[0];
    expect(sem?.evidence.find((e) => e.key === 'semantic.state')?.basis).toBe('inference');
  });

  it('makes no formal claim about WCAG: only "related to"', () => {
    const snapshot = representative().run();
    const text = JSON.stringify(snapshot);
    expect(text).not.toMatch(/violat|non-?compliant|fails? WCAG|does not conform/i);
    expect(findingsOf(snapshot, 'CA-COLOR-001')[0]?.wcag).toEqual([
      { criterion: '1.4.3', name: 'Contrast (Minimum)', relation: 'related-to' },
    ]);
    expect(findingsOf(snapshot, 'CA-COLOR-002')[0]?.wcag).toEqual([]);
  });

  it('has no score anywhere', () => {
    expect(JSON.stringify(representative().run())).not.toMatch(/score/i);
  });

  it('gives each finding a recommendation that names what to do', () => {
    for (const finding of representative().run().findings) {
      expect(finding.recommendation.summary.length).toBeGreaterThan(10);
      expect(finding.recommendation.actions.length).toBeGreaterThan(0);
      expect(finding.sourceNote).toMatch(/original page/);
    }
  });
});

describe('inline SVG (with the fake paint engine)', () => {
  it('reports a pale functional icon and skips a decorative or a dark one', () => {
    const rig = mountAudit(SVG_ICON_MARKUP, { svgEngine: true, settings: DEUTAN });
    const snapshot = rig.run();
    expect(rows(snapshot)).toEqual(['CA-SVG-001 #icon']);
    const finding = findingsOf(snapshot, 'CA-SVG-001')[0];
    expect(finding?.assessment).toBe('issue');
    expect(finding?.wcag[0]?.criterion).toBe('1.4.11');
  });
});
