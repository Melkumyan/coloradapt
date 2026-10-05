import { describe, expect, it } from 'vitest';
import { CHART_NODE_ATTRIBUTE } from '@core/charts';
import { CUE_ATTRIBUTE } from '@features/semantics';
import { createChartEnvironment } from '../charts/engine';
import { FakeImageEnvironment } from '../images/fake-env';
import { RED, abs, iconPixels, makeImage } from '../images/kit';
import { DEUTAN, OFF, findingsOf, mountAudit, sourceFingerprint, type RigOptions } from './kit';
import { REPRESENTATIVE_CSS, REPRESENTATIVE_MARKUP } from './fixtures';

/**
 * The central promise of the audit: it reports the page as authored. Whatever ColorAdapt did to the
 * page (recolored text, a cue next to a state, dashes and patterns on a chart, a generated bitmap)
 * is ignored, so adaptation can never make a page look more accessible than its source is.
 */
const options = (extra: Partial<RigOptions> = {}): RigOptions => ({
  css: REPRESENTATIVE_CSS,
  chartEnv: createChartEnvironment(document),
  settings: DEUTAN,
  ...extra,
});

function audited(adapt: boolean) {
  const rig = mountAudit(REPRESENTATIVE_MARKUP, options({ adapt }));
  return { rig, snapshot: rig.run() };
}

const ownedAttributes = (): string[] =>
  [...document.querySelectorAll('*')]
    .flatMap((el) => [...el.attributes].map((a) => a.name))
    .filter((name) => name.startsWith('data-coloradapt-') && name !== 'data-coloradapt-id');

describe('adaptation ON vs OFF', () => {
  it('finds the same source problems with the same ids, evidence and severities', () => {
    const off = audited(false).snapshot;
    document.body.innerHTML = '';
    const on = audited(true).snapshot;
    expect(sourceFingerprint(on)).toEqual(sourceFingerprint(off));
    expect(on.findings.map((f) => f.id)).toEqual(off.findings.map((f) => f.id));
  });

  it('really adapted the page in the ON run (the comparison is not vacuous)', () => {
    audited(true);
    expect(document.getElementById('coloradapt-stylesheet')).not.toBeNull();
    expect(document.querySelectorAll(`[${CUE_ATTRIBUTE}]`).length).toBeGreaterThan(0);
    expect(document.querySelectorAll('[data-coloradapt-chart-mark]').length).toBeGreaterThan(0);
  });

  it('changes only the adaptation status, never the problem', () => {
    const off = audited(false).snapshot;
    document.body.innerHTML = '';
    const on = audited(true).snapshot;
    const status = (snapshot: typeof on, rule: string) =>
      findingsOf(snapshot, rule)[0]?.adaptationStatus;
    expect(status(off, 'CA-COLOR-002')).toBe('not-enabled');
    expect(status(on, 'CA-COLOR-002')).toBe('adapted');
    expect(status(off, 'CA-SEM-001')).toBe('not-enabled');
    expect(status(on, 'CA-SEM-001')).toBe('adapted');
    expect(status(off, 'CA-CHART-001')).toBe('not-enabled');
    expect(status(on, 'CA-CHART-001')).toBe('adapted');
    expect(on.summary.adapted).toBeGreaterThan(0);
    expect(off.summary.adapted).toBe(0);
  });

  it('keeps the original colors in the evidence of a recolored element', () => {
    const { snapshot } = audited(true);
    const pair = findingsOf(snapshot, 'CA-COLOR-002')[0]?.evidence.find(
      (e) => e.key === 'colors.pair',
    );
    expect(pair?.value).toEqual({ kind: 'colors', foreground: '#d62728', background: '#2ca02c' });
  });

  it('does not take ColorAdapt’s own cue for a cue the page already had', () => {
    const { snapshot } = audited(true);
    const sem = findingsOf(snapshot, 'CA-SEM-001')[0];
    expect(document.getElementById('email-a')?.hasAttribute(CUE_ATTRIBUTE)).toBe(true);
    expect(sem?.affected[0]?.locator.path).toBe('#email-a');
    expect(sem?.adaptationStatus).toBe('adapted');
  });

  it('does not take ColorAdapt’s dashes, markers and patterns for the page’s own encodings', () => {
    const { snapshot } = audited(true);
    expect(document.querySelectorAll('[data-coloradapt-chart-mark]').length).toBeGreaterThan(0);
    const chart = findingsOf(snapshot, 'CA-CHART-001')[0];
    expect(chart?.affected[0]?.locator.path).toBe('#bad-chart');
    expect(chart?.adaptationStatus).toBe('adapted');
  });

  it('is repeatable while adapted: audit, audit again, same ids, no growth', () => {
    const { rig, snapshot } = audited(true);
    const again = rig.run();
    expect(sourceFingerprint(again)).toEqual(sourceFingerprint(snapshot));
    expect(again.findings).toHaveLength(snapshot.findings.length);
  });
});

describe('the audit changes nothing on the page', () => {
  it('adaptation ON: markup, injected stylesheet and owned attributes are the same after an audit', () => {
    const rig = mountAudit(REPRESENTATIVE_MARKUP, options({ adapt: true }));
    const strip = (html: string) => html.replace(/ data-coloradapt-id="[^"]*"/g, '');
    const before = {
      html: strip(document.body.innerHTML),
      css: document.getElementById('coloradapt-stylesheet')?.textContent,
    };
    rig.run();
    rig.run('major');
    expect(strip(document.body.innerHTML)).toBe(before.html);
    expect(document.getElementById('coloradapt-stylesheet')?.textContent).toBe(before.css);
  });

  it('adaptation OFF (audit-only): no stylesheet, no cue, no chart node, no pattern, no generated image', () => {
    const rig = mountAudit(REPRESENTATIVE_MARKUP, options({ settings: OFF }));
    rig.run();
    rig.run('major');
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
    expect(document.querySelectorAll(`[${CUE_ATTRIBUTE}]`)).toHaveLength(0);
    expect(document.querySelectorAll(`[${CHART_NODE_ATTRIBUTE}]`)).toHaveLength(0);
    expect(ownedAttributes()).toEqual([]);
    expect(document.documentElement.querySelector('[data-coloradapt-audit-overlay]')).toBeNull();
    expect([...document.querySelectorAll('img')].every((img) => !img.src.startsWith('blob:'))).toBe(
      true,
    );
  });

  it('works whatever the setting: a disabled ColorAdapt still audits', () => {
    const snapshot = mountAudit(REPRESENTATIVE_MARKUP, options({ settings: OFF })).run();
    expect(snapshot.findings.length).toBeGreaterThan(0);
    expect(snapshot.settings.adaptationEnabled).toBe(false);
    for (const finding of snapshot.findings.filter((f) => f.assessment === 'issue')) {
      expect(finding.adaptationStatus).toBe('not-enabled');
    }
  });
});

describe('M8: the generated bitmap is never the source', () => {
  const ICON_URL = abs('/i/alert.png');

  async function imagePage(adaptImages: boolean) {
    const env = new FakeImageEnvironment().set(ICON_URL, iconPixels(RED, 24));
    const rig = mountAudit('<div id="host"></div>', {
      imageEnv: env,
      settings: { ...DEUTAN, adaptImages, semanticCuesEnabled: false, adaptCharts: false },
      adapt: true,
    });
    document.body.setAttribute('style', 'background-color: #2ca02c');
    const button = document.createElement('button');
    const img = makeImage({ src: ICON_URL, attrs: { class: 'icon', alt: 'Alert' } });
    button.append(img);
    document.getElementById('host')?.append(button);
    rig.adapt();
    await rig.content.settleImages();
    return { rig, img, env };
  }

  it('reports a recolored functional icon against the page’s own image', async () => {
    const { rig, img } = await imagePage(true);
    expect(img.getAttribute('src')).toMatch(/^blob:/); // ColorAdapt really swapped it
    const snapshot = rig.run();
    const finding = findingsOf(snapshot, 'CA-IMG-001')[0];
    expect(finding?.assessment).toBe('issue');
    expect(finding?.adaptationStatus).toBe('adapted');
    expect(JSON.stringify(snapshot)).not.toContain('blob:');
  });

  it('reports no image finding when the layer is off (no pixels are ever read for an audit)', async () => {
    const { rig, env } = await imagePage(false);
    expect(findingsOf(rig.run(), 'CA-IMG-001')).toEqual([]);
    expect(env.reads).toHaveLength(0);
  });

  it('does not read a single pixel for the audit itself', async () => {
    const { rig, env } = await imagePage(true);
    const reads = env.reads.length;
    rig.run();
    rig.run('major');
    expect(env.reads).toHaveLength(reads);
  });
});
