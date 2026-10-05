import { describe, expect, it } from 'vitest';
import {
  evaluateCanvas,
  evaluateChart,
  evaluateCoverage,
  evaluateImage,
  evaluateSemantic,
  evaluateSvg,
  evaluateText,
  type AdaptationInfo,
  type AuditScope,
  type SemanticAuditInput,
} from '@core/audit';
import { analyzeChart } from '@core/charts';
import type { SemanticResult, SemanticState } from '@core/semantics';
import { parseColor } from '@core/color';
import type { ColorValue, SvgUnitInfo } from '@domain/models';
import { CONFUSABLE, DISTINCT, barChart, lineChart, pieChart } from '../charts/builders';
import { target } from './builders';

const c = (hex: string): ColorValue => {
  const color = parseColor(hex);
  if (!color) throw new Error(hex);
  return color;
};
const T = target('html>body>p:nth-of-type(1)', 'p');
const OFF: AdaptationInfo = { status: 'not-enabled' };
const scope = (
  active: AuditScope['activeProfile'],
  profiles: AuditScope['profiles'] = [active],
): AuditScope => ({
  activeProfile: active,
  profiles,
});

describe('text (CA-COLOR-001 / 002 / 003)', () => {
  const text = (fg: string, bg: string, extra: Partial<Parameters<typeof evaluateText>[0]> = {}) =>
    evaluateText(
      {
        target: T,
        foreground: c(fg),
        background: c(bg),
        analysisStatus: 'resolved',
        interactive: false,
        largeText: false,
        adaptation: OFF,
        ...extra,
      },
      scope('normal'),
    );

  it('reports text below the 4.5:1 target as an observed fact against an engineering threshold', () => {
    const [found] = text('#aaaaaa', '#ffffff');
    expect(found?.ruleId).toBe('CA-COLOR-001');
    expect(found?.assessment).toBe('issue');
    const ratio = found?.evidence.find((e) => e.key === 'contrast.ratio');
    const limit = found?.evidence.find((e) => e.key === 'contrast.target');
    expect(ratio?.basis).toBe('observed-fact');
    expect(limit?.basis).toBe('engineering-threshold');
    expect(limit?.value).toEqual({ kind: 'number', value: 4.5, unit: ':1' });
  });

  it('does not report text at or above the target', () => {
    expect(text('#000000', '#ffffff')).toEqual([]);
    expect(text('#595959', '#ffffff')).toEqual([]); // 7:1
  });

  it('uses 3:1 for large text', () => {
    expect(text('#8a8a8a', '#ffffff', { largeText: true })).toEqual([]); // 3.45:1
    expect(text('#8a8a8a', '#ffffff')).toHaveLength(1);
  });

  it('draws no contrast conclusion over a background it could not resolve (CA-COLOR-003, a limitation)', () => {
    for (const analysisStatus of ['partial', 'unsupported'] as const) {
      const found = text('#aaaaaa', '#ffffff', { analysisStatus });
      expect(found).toHaveLength(1);
      expect(found[0]?.ruleId).toBe('CA-COLOR-003');
      expect(found[0]?.assessment).toBe('analysis-limitation');
    }
  });

  it('never says WCAG or fails in its summaries', () => {
    expect(text('#aaaaaa', '#ffffff')[0]?.summary).not.toMatch(/wcag|fail|violat/i);
  });

  it('is profile-independent for contrast and profile-specific for distinguishability', () => {
    const found = evaluateText(
      {
        target: T,
        foreground: c('#c0392b'),
        background: c('#2e8b57'),
        analysisStatus: 'resolved',
        interactive: false,
        largeText: false,
        adaptation: OFF,
      },
      scope('normal', ['protanopia', 'deuteranopia']),
    );
    for (const candidate of found.filter((x) => x.ruleId === 'CA-COLOR-002')) {
      expect(candidate.profile).not.toBeNull();
      expect(candidate.simulation?.profile).toBe(candidate.profile);
      expect(candidate.evidence.some((e) => e.basis === 'model-estimate')).toBe(true);
    }
    for (const candidate of found.filter((x) => x.ruleId === 'CA-COLOR-001'))
      expect(candidate.profile).toBeNull();
  });

  it('only calls it a color-vision problem when normal vision tells the pair apart', () => {
    // Two near-identical grays: close for everyone, so a contrast problem and not a CVD one.
    const found = evaluateText(
      {
        target: T,
        foreground: c('#777777'),
        background: c('#7a7a7a'),
        analysisStatus: 'resolved',
        interactive: false,
        largeText: false,
        adaptation: OFF,
      },
      scope('deuteranopia'),
    );
    expect(found.map((x) => x.ruleId)).toEqual(['CA-COLOR-001']);
  });

  it('evaluates nothing for normal vision (no simulation)', () => {
    const found = evaluateText(
      {
        target: T,
        foreground: c('#c0392b'),
        background: c('#2e8b57'),
        analysisStatus: 'resolved',
        interactive: false,
        largeText: false,
        adaptation: OFF,
      },
      scope('normal', ['normal', 'custom']),
    );
    expect(found.filter((x) => x.ruleId === 'CA-COLOR-002')).toEqual([]);
  });

  it('carries the M3 suggestion and marks it as a suggestion, never as the status', () => {
    const [found] = text('#aaaaaa', '#ffffff', {
      adaptation: { status: 'adapted', suggestionHex: '#767676' },
    });
    expect(found?.adaptation).toBe('adapted');
    expect(found?.recommendation.suggestedHex).toBe('#767676');
  });

  it('passes M2’s weaker model status through, apart from a finding that is still HIGH confidence', () => {
    const merge = (profile: Parameters<typeof scope>[0]) =>
      evaluateText(
        {
          target: T,
          foreground: c('#b5651d'),
          background: c('#6b8e23'),
          analysisStatus: 'resolved',
          interactive: false,
          largeText: false,
          adaptation: OFF,
        },
        scope(profile),
      ).find((x) => x.ruleId === 'CA-COLOR-002');
    expect(merge('deuteranopia')?.simulation?.modelConfidence).toBe('SUPPORTED_MODEL');
    expect(merge('deuteranomaly')?.simulation).toMatchObject({
      model: 'machado2009',
      modelConfidence: 'MODEL_ASSUMPTION',
      fidelity: 'published',
    });
    expect(merge('deuteranomaly')?.confidence).toBe('HIGH');
    expect(merge('achromatopsia')?.simulation?.modelConfidence).toBe('APPROXIMATION');
  });

  it('gives a non-active profile no adaptation status of its own', () => {
    const found = evaluateText(
      {
        target: T,
        foreground: c('#c0392b'),
        background: c('#2e8b57'),
        analysisStatus: 'resolved',
        interactive: false,
        largeText: false,
        adaptation: { status: 'adapted' },
      },
      scope('deuteranopia', ['protanopia', 'deuteranopia']),
    ).filter((x) => x.ruleId === 'CA-COLOR-002');
    for (const candidate of found) {
      expect(candidate.adaptation).toBe(
        candidate.profile === 'deuteranopia' ? 'adapted' : 'not-applicable',
      );
    }
  });
});

describe('SVG (CA-SVG-001 / 002)', () => {
  const unit = (extra: Partial<SvgUnitInfo> = {}): SvgUnitInfo => ({
    kind: 'icon',
    paintCount: 1,
    shapeCount: 1,
    textCount: 0,
    useCount: 0,
    targets: [],
    ...extra,
  });
  const run = (
    svg: SvgUnitInfo,
    fg = '#dddddd',
    bg = '#ffffff',
    status: 'resolved' | 'partial' = 'resolved',
  ) =>
    evaluateSvg(
      {
        target: T,
        svg,
        foreground: c(fg),
        background: c(bg),
        analysisStatus: status,
        interactive: false,
        adaptation: OFF,
      },
      scope('normal'),
    );

  it('reports a single-paint SVG below 3:1', () => {
    const [found] = run(unit());
    expect(found?.ruleId).toBe('CA-SVG-001');
    expect(found?.context).toBe('contrast');
  });

  it('is quiet about a readable icon', () => {
    expect(run(unit(), '#222222')).toEqual([]);
  });

  it('separates a confirmed issue from an analysis limitation', () => {
    const multi = run(unit({ unsupportedReason: 'multi-paint', paintCount: 3 }));
    expect(multi[0]?.ruleId).toBe('CA-SVG-002');
    expect(multi[0]?.assessment).toBe('manual-review');
    const animated = run(unit({ unsupportedReason: 'animated' }));
    expect(animated[0]?.assessment).toBe('analysis-limitation');
  });

  it('leaves SVGs the chart layer owns to the chart rules', () => {
    expect(run(unit({ unsupportedReason: 'chart-owned' }))).toEqual([]);
    expect(run(unit({ unsupportedReason: 'chart-like' }))).toEqual([]);
  });

  it('does not judge an SVG over an unresolved background', () => {
    const found = run(unit(), '#dddddd', '#ffffff', 'partial');
    expect(found[0]?.ruleId).toBe('CA-SVG-002');
    expect(found[0]?.context).toBe('background-unresolved');
    expect(found.some((x) => x.ruleId === 'CA-SVG-001')).toBe(false);
  });
});

describe('semantic state (CA-SEM-001 / 002)', () => {
  const classified = (
    state: SemanticState,
    confidence: 'high' | 'medium' | 'low',
  ): SemanticResult => ({
    status: 'classified',
    state,
    confidence,
    evidence: [{ source: 'aria-invalid', value: 'true', supports: state, strength: 'strong' }],
  });
  const input = (overrides: Partial<SemanticAuditInput>): SemanticAuditInput => ({
    target: T,
    result: classified('invalid', 'high'),
    decision: { action: 'none', reason: 'below-threshold' },
    verdict: { colorOnly: true, basis: 'peer-comparison' },
    interactive: false,
    field: true,
    adaptation: { status: 'not-enabled' },
    ...overrides,
  });

  it('reports a high-confidence color-only state as an issue', () => {
    const [found] = evaluateSemantic(input({}));
    expect(found?.ruleId).toBe('CA-SEM-001');
    expect(found?.assessment).toBe('issue');
    expect(found?.confidence).toBe('HIGH');
    expect(found?.profile).toBeNull();
    expect(found?.context).toBe('invalid');
    expect(found?.evidence.find((e) => e.key === 'semantic.state')?.basis).toBe('inference');
    expect(found?.evidence.find((e) => e.key === 'semantic.colorOnly')?.basis).toBe(
      'observed-fact',
    );
  });

  it('turns a medium or low confidence state into a manual review, not a claim', () => {
    for (const confidence of ['medium', 'low'] as const) {
      const [found] = evaluateSemantic(input({ result: classified('error', confidence) }));
      expect(found?.ruleId).toBe('CA-SEM-002');
      expect(found?.assessment).toBe('manual-review');
      expect(found?.adaptation).toBe('not-applicable');
    }
  });

  it('reports nothing when color is not the only cue, nothing was compared, or the state is unknown', () => {
    expect(
      evaluateSemantic(input({ verdict: { colorOnly: false, reason: 'existing-cue' } })),
    ).toEqual([]);
    expect(evaluateSemantic(input({ verdict: null }))).toEqual([]);
    expect(
      evaluateSemantic(
        input({ result: { status: 'unknown', reason: 'no-evidence', evidence: [] } }),
      ),
    ).toEqual([]);
    expect(
      evaluateSemantic(
        input({ result: { status: 'conflict', states: ['error', 'success'], evidence: [] } }),
      ),
    ).toEqual([]);
  });

  it('bounds and sanitizes the signals it quotes', () => {
    const [found] = evaluateSemantic(
      input({
        result: {
          status: 'classified',
          state: 'error',
          confidence: 'high',
          evidence: Array.from({ length: 12 }, (_, i) => ({
            source: 'class-token' as const,
            value: i === 0 ? 'SECRET value with spaces and 123456789012' : `t${i}`,
            supports: 'error' as const,
            strength: 'medium' as const,
          })),
        },
      }),
    );
    const list = found?.evidence.find((e) => e.key === 'semantic.signals')?.value;
    expect(list?.kind === 'list' && list.items.length).toBe(6);
    expect(JSON.stringify(list)).not.toMatch(/123456789012/);
  });

  it('quotes a data-* signal by attribute name and a vocabulary-like value only, and text as a redacted snippet', () => {
    const evidenceOf = (source: 'data-token' | 'text-token' | 'class-token', value: string) => ({
      source,
      value,
      supports: 'error' as const,
      strength: 'strong' as const,
    });
    const [found] = evaluateSemantic(
      input({
        result: {
          status: 'classified',
          state: 'error',
          confidence: 'high',
          evidence: [
            evidenceOf('data-token', 'data-state=error'),
            evidenceOf('data-token', 'data-user-id=USER-998877'),
            evidenceOf('text-token', 'Contact jane@example.com about 4111 1111 1111 1111'),
            evidenceOf('class-token', 'Danger'),
          ],
        },
      }),
    );
    const list = found?.evidence.find((e) => e.key === 'semantic.signals')?.value;
    const items = list?.kind === 'list' ? list.items : [];
    expect(items[0]).toBe('data-token: data-state=error (strong)');
    expect(items[1]).toBe('data-token: data-user-id=[redacted] (strong)');
    expect(items[2]).toContain('[email]');
    expect(JSON.stringify(items)).not.toMatch(/jane|4111|998877/);
    expect(items[3]).toBe('class-token: danger (strong)');
  });

  it('keeps an error text message below an invalid control in severity', () => {
    const control = evaluateSemantic(input({ interactive: true }))[0];
    const message = evaluateSemantic(
      input({ field: false, result: classified('error', 'high') }),
    )[0];
    expect(control?.factors.interactive).toBe(true);
    expect(message?.factors.interactive).toBe(false);
  });
});

describe('charts (CA-CHART-001..004)', () => {
  const analyze = (builder: { build(): Parameters<typeof analyzeChart>[0] }) =>
    analyzeChart(builder.build());
  const audit = (
    builder: { build(): Parameters<typeof analyzeChart>[0] },
    s: AuditScope,
    adaptation = OFF,
  ) =>
    evaluateChart(
      { target: target('html>body>svg', 'svg'), analysis: analyze(builder), adaptation },
      s,
    );

  it('reports series told apart by color alone, with the model that says so', () => {
    const found = audit(lineChart(CONFUSABLE), scope('deuteranopia'));
    const issue = found.find((x) => x.ruleId === 'CA-CHART-001');
    expect(issue).toBeDefined();
    expect(issue?.profile).toBe('deuteranopia');
    expect(issue?.simulation?.modelConfidence).toBe('SUPPORTED_MODEL');
    expect(issue?.evidence.some((e) => e.key === 'chart.existing')).toBe(true);
  });

  it('is quiet about a chart whose series stay distinct', () => {
    expect(audit(lineChart(DISTINCT), scope('deuteranopia'))).toEqual([]);
  });

  it('is quiet when the page already tells the series apart without color', () => {
    const dashed = lineChart(CONFUSABLE, { dashes: [null, '6 3', '2 2'] });
    expect(audit(dashed, scope('deuteranopia'))).toEqual([]);
  });

  it('reports no color-vision finding for normal vision', () => {
    expect(audit(lineChart(CONFUSABLE), scope('normal', []))).toEqual([]);
  });

  it('groups profiles by emitting one candidate per profile', () => {
    const found = audit(
      lineChart(CONFUSABLE),
      scope('normal', ['protanopia', 'deuteranopia', 'tritanopia']),
    ).filter((x) => x.ruleId === 'CA-CHART-001');
    expect(found.map((x) => x.profile)).toEqual(
      expect.arrayContaining(['protanopia', 'deuteranopia']),
    );
  });

  it('asks for a manual review of a legend it cannot pair, not a failure', () => {
    const ambiguous = lineChart(CONFUSABLE, { labels: ['A', 'A', 'A'] });
    const found = audit(ambiguous, scope('deuteranopia'));
    for (const x of found.filter((y) => y.ruleId !== 'CA-CHART-001'))
      expect(x.assessment).toBe('manual-review');
  });

  it('draws no pair verdict on a sequential palette (color means magnitude there)', () => {
    const blues = ['#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#3182bd', '#08519c'];
    const found = audit(barChart(blues), scope('deuteranopia'));
    expect(found.some((x) => x.ruleId === 'CA-CHART-001')).toBe(false);
    expect(found.every((x) => x.assessment === 'manual-review')).toBe(true);
  });

  it('does not report an SVG that might be a chart (low confidence is just an SVG)', () => {
    expect(
      evaluateChart(
        { target: T, analysis: { status: 'unknown' }, adaptation: OFF },
        scope('deuteranopia'),
      ),
    ).toEqual([]);
    expect(
      evaluateChart(
        {
          target: T,
          analysis: {
            status: 'unsupported',
            reason: 'low-confidence',
            type: 'bar',
            confidence: 'MEDIUM',
          },
          adaptation: OFF,
        },
        scope('deuteranopia'),
      ),
    ).toEqual([]);
  });

  it('reports a heatmap-like chart as manual review at most low', () => {
    const found = evaluateChart(
      {
        target: T,
        analysis: {
          status: 'unsupported',
          reason: 'heatmap-sequential',
          type: 'heatmap',
          confidence: 'HIGH',
        },
        adaptation: OFF,
      },
      scope('deuteranopia'),
    );
    expect(found[0]?.ruleId).toBe('CA-CHART-003');
    expect(found[0]?.assessment).toBe('manual-review');
  });

  it('reports a canvas chart as manual review and any other canvas as nothing', () => {
    const chart = evaluateCanvas({
      target: T,
      verdict: { kind: 'canvas-chart', reason: 'chart-hint' },
    });
    expect(chart[0]?.ruleId).toBe('CA-CHART-004');
    expect(chart[0]?.assessment).toBe('manual-review');
    expect(
      evaluateCanvas({ target: T, verdict: { kind: 'canvas-unknown', reason: 'no-evidence' } }),
    ).toEqual([]);
  });

  it('pie charts without a legend are a review, not a color conflict', () => {
    const found = audit(pieChart(CONFUSABLE, { legend: false }), scope('deuteranopia'));
    expect(found.some((x) => x.assessment === 'issue' && x.ruleId !== 'CA-CHART-001')).toBe(false);
  });
});

describe('images (CA-IMG-001..003)', () => {
  const base = {
    target: T,
    kind: 'photograph' as const,
    confidence: 'HIGH' as const,
    layer: null,
    interactive: false,
    small: false,
    crossOrigin: false,
    adaptation: { status: 'not-applicable' as const },
  };

  it('never reports a photograph, a logo or an illustration', () => {
    for (const kind of [
      'photograph',
      'logo',
      'illustration',
      'screenshot',
      'complex-artwork',
      'unknown',
    ] as const) {
      expect(evaluateImage({ ...base, kind })).toEqual([]);
    }
  });

  it('reports a raster chart as a manual review', () => {
    const [found] = evaluateImage({ ...base, kind: 'chart-raster' });
    expect(found?.ruleId).toBe('CA-IMG-002');
    expect(found?.assessment).toBe('manual-review');
    expect(evaluateImage({ ...base, kind: 'chart-raster', confidence: 'LOW' })).toEqual([]);
  });

  it('reports a functional icon the image layer recolored (the page still has the problem)', () => {
    const [found] = evaluateImage({
      ...base,
      kind: 'monochrome-icon',
      layer: { action: 'pixel-adapted', reason: 'adapted', readability: 'readable' },
      interactive: true,
    });
    expect(found?.ruleId).toBe('CA-IMG-001');
    expect(found?.adaptation).toBe('adapted');
    expect(found?.assessment).toBe('issue');
  });

  it('reports no safe recoloring as such', () => {
    const [found] = evaluateImage({
      ...base,
      kind: 'monochrome-icon',
      layer: { action: 'unsupported', reason: 'no-safe-candidate', readability: 'readable' },
    });
    expect(found?.adaptation).toBe('no-safe-candidate');
  });

  it('asks for a manual review of an unreadable control image, only for small ones in controls', () => {
    const unreadable = { ...base, crossOrigin: true, interactive: true, small: true };
    expect(evaluateImage(unreadable)[0]?.ruleId).toBe('CA-IMG-003');
    expect(evaluateImage({ ...unreadable, interactive: false })).toEqual([]);
    expect(evaluateImage({ ...unreadable, small: false })).toEqual([]);
    expect(evaluateImage({ ...unreadable, crossOrigin: false })).toEqual([]);
    expect(
      evaluateImage({
        ...unreadable,
        crossOrigin: false,
        layer: { action: 'unsupported', reason: 'unreadable', readability: 'tainted' },
      })[0]?.ruleId,
    ).toBe('CA-IMG-003');
  });
});

describe('coverage (CA-GEN-001)', () => {
  it('is only reported when a budget ended the pass, and then as a limitation', () => {
    expect(evaluateCoverage([], 10, T)).toEqual([]);
    const [found] = evaluateCoverage(['analyzed elements'], 5000, T);
    expect(found?.ruleId).toBe('CA-GEN-001');
    expect(found?.assessment).toBe('analysis-limitation');
  });
});
