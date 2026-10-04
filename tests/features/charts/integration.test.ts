import { afterEach, describe, expect, it } from 'vitest';
import { CHART_NODE_ATTRIBUTE } from '@core/charts';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '@domain/models';
import { createDynamicContentController } from '@features/dynamic-analysis';
import {
  CONFLICT_STYLE,
  createManualScheduler,
  html,
  isAdapted,
  ruleCount,
} from '../dynamic/helpers';
import { REDS } from '../../core/charts/builders';
import { createChartEnvironment, lineChartSvg, barChartSvg } from './engine';

/**
 * The chart layer wired into the pipeline (M3 color rules, M4 incremental passes, M5 SVG units, M6
 * cues), in jsdom: ownership between layers, dynamic updates through M4 with no observer of its own,
 * self-mutation filtering, and settings. Real-browser behavior is in e2e/chart-*.spec.ts.
 */
const SETTINGS: UserSettings = {
  ...DEFAULT_USER_SETTINGS,
  visionProfile: 'deuteranopia',
  adaptationStrength: 1,
  adaptCharts: true,
};

let current: ReturnType<typeof createDynamicContentController> | null = null;

function setup(markup: string, settings: UserSettings = SETTINGS) {
  document.head.innerHTML = '';
  html(markup);
  const scheduler = createManualScheduler();
  const controller = createDynamicContentController(
    document,
    { now: () => 0 },
    { scheduler },
    { chartEnv: createChartEnvironment(document) },
  );
  current = controller;
  const initial = controller.enableAdaptation('https://example.com', settings);
  return { controller, scheduler, dynamic: controller.dynamic, initial };
}

afterEach(() => {
  current?.dynamic.dispose();
  current?.disableAdaptation();
  current = null;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

const svgOf = (id = 'chart') => document.getElementById(id) as unknown as SVGSVGElement;
const marked = () => document.querySelectorAll('[data-coloradapt-chart-mark]').length;
const nodes = () => document.querySelectorAll(`[${CHART_NODE_ATTRIBUTE}]`).length;

describe('ownership between layers', () => {
  it('M5 reports an owned chart as chart-owned and writes no color rule for any of its marks', () => {
    const { initial } = setup(lineChartSvg(REDS));
    const unit = initial.analysis.elements.find((element) => element.svg);
    expect(unit?.svg?.unsupportedReason).toBe('chart-owned');
    expect(
      initial.adaptation.changes.filter((change) =>
        svgOf().contains(document.querySelector(`[data-coloradapt-id="${change.elementId}"]`)),
      ),
    ).toEqual([]);
    expect(marked()).toBeGreaterThan(0);
  });

  it("adaptCharts off: the chart is left alone by M7 (and is M5's as before)", () => {
    const { initial } = setup(lineChartSvg(REDS), { ...SETTINGS, adaptCharts: false });
    expect(marked()).toBe(0);
    expect(nodes()).toBe(0);
    expect(
      initial.analysis.elements.find((element) => element.svg)?.svg?.unsupportedReason,
    ).not.toBe('chart-owned');
  });

  it('a non-chart SVG next to a chart is not owned', () => {
    const { initial } = setup(
      `${lineChartSvg(REDS)}<svg id="icon" viewBox="0 0 24 24"><path d="M0 0 L10 10 L20 0 Z" fill="#c0392b" data-box="0,0,20,10"/></svg>`,
    );
    const reasons = initial.analysis.elements
      .filter((element) => element.svg)
      .map((element) => element.svg?.unsupportedReason);
    expect(reasons).toContain('chart-owned');
    expect(reasons.filter((reason) => reason === 'chart-owned')).toHaveLength(1);
  });

  it('M6 never writes a cue inside a chart', () => {
    setup(lineChartSvg(REDS).replace('<g class="legend">', '<g class="legend error">'));
    expect(svgOf().querySelectorAll('[data-coloradapt-cue]')).toHaveLength(0);
  });

  it('page colors and charts are adapted side by side', () => {
    setup(`<p id="p" style="${CONFLICT_STYLE}">warn</p>${lineChartSvg(REDS)}`);
    expect(isAdapted(document.getElementById('p')!)).toBe(true);
    expect(marked()).toBeGreaterThan(0);
  });
});

describe("dynamic charts flow through M4 (no observer of the chart layer's own)", () => {
  it('a series added to the chart is picked up in one incremental pass, with no loop', () => {
    const { dynamic } = setup(lineChartSvg(REDS.slice(0, 2), { legend: false }));
    const before = marked();
    const third = svgOf().querySelector('path.line')!.cloneNode(true) as Element;
    for (const name of third.getAttributeNames())
      if (name.startsWith('data-coloradapt')) third.removeAttribute(name);
    third.setAttribute('stroke', REDS[2]!);
    svgOf().querySelector('path.line:last-of-type')!.after(third);
    const diag = dynamic.flush();
    expect(diag.incrementalPasses).toBe(1);
    expect(diag.fullRescans).toBe(0);
    expect(marked()).toBeGreaterThan(before);
    // Our own writes (attributes, defs, overlays, sheet) never start another pass.
    const again = dynamic.flush();
    expect(again.incrementalPasses).toBe(1);
    expect(again.selfMutationsIgnored).toBeGreaterThan(0);
    expect(again.charts.chartPending).toBe(0);
  });

  it('a dash change by the page invalidates the chart (stroke-dasharray is observed)', () => {
    const { dynamic } = setup(lineChartSvg(REDS, { legend: false }));
    const pathOf = (n: number) => svgOf().querySelector(`path.line-${n}`)!;
    const diag0 = dynamic.diagnostics();
    pathOf(0).setAttribute('stroke-dasharray', '9 3');
    pathOf(1).setAttribute('stroke-dasharray', '2 2');
    pathOf(2).setAttribute('stroke-dasharray', '4 4 1 4');
    const diag = dynamic.flush();
    // all three are now told apart by the page itself: nothing of ours stays
    expect(diag.incrementalPasses).toBe(diag0.incrementalPasses + 1);
    expect(marked()).toBe(0);
    expect(nodes()).toBe(0);
    expect(svgOf().hasAttribute('data-coloradapt-chart-owned')).toBe(true); // still ours, nothing to add
  });

  it('a color change by the page re-plans the chart', () => {
    const { dynamic } = setup(lineChartSvg(['#d62728', '#2ca02c', '#0072b2'], { legend: false }));
    expect(nodes()).toBe(0); // red/green: dashed series 1 only (no defs needed)
    const first = marked();
    svgOf().querySelector('path.line-1')!.setAttribute('stroke', '#0072b2');
    svgOf().querySelector('path.line-2')!.setAttribute('stroke', '#d55e00');
    dynamic.flush();
    expect(marked()).toBeLessThanOrEqual(first);
  });

  it('removing the chart removes every artifact, rule and sheet', () => {
    const { dynamic } = setup(lineChartSvg(REDS));
    expect(document.getElementById('coloradapt-stylesheet')?.textContent).toContain(
      'data-coloradapt-chart',
    );
    svgOf().remove();
    dynamic.flush();
    expect(marked()).toBe(0);
    expect(nodes()).toBe(0);
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
    expect(dynamic.diagnostics().charts).toMatchObject({
      chartOwners: 0,
      chartRules: 0,
      chartDefs: 0,
      chartPending: 0,
    });
  });

  it('replacing the chart (a framework re-render) adapts the new one and cleans the old one', () => {
    const { dynamic } = setup(`<div id="host">${lineChartSvg(REDS)}</div>`);
    document.getElementById('host')!.innerHTML = lineChartSvg(REDS, { id: 'chart2' });
    dynamic.flush();
    expect(document.getElementById('chart')).toBeNull();
    expect(svgOf('chart2').hasAttribute('data-coloradapt-chart-owned')).toBe(true);
    expect(svgOf('chart2').querySelectorAll('[data-coloradapt-chart-mark]').length).toBeGreaterThan(
      0,
    );
    expect(dynamic.diagnostics().charts.chartsSupported).toBe(1);
  });

  it('a page that deletes our <style> gets it back with the chart rules', () => {
    const { dynamic } = setup(lineChartSvg(REDS));
    document.getElementById('coloradapt-stylesheet')!.remove();
    dynamic.flush();
    expect(document.getElementById('coloradapt-stylesheet')?.textContent).toContain(
      'data-coloradapt-chart',
    );
  });

  it('turning adaptation off restores the page exactly', () => {
    html(lineChartSvg(REDS) + barChartSvg(['#d62728', '#2ca02c'], { id: 'bars' }));
    const before = document.body.innerHTML;
    document.body.innerHTML = '';
    const { controller } = setup(before);
    expect(marked()).toBeGreaterThan(0);
    controller.disableAdaptation();
    // ids assigned to analyzed elements by M3/M5 remain attributes; strip only data-coloradapt-id
    const stripped = document.body.innerHTML.replace(/ data-coloradapt-id="[^"]*"/g, '');
    expect(stripped).toBe(before);
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
  });
});

describe('chart diagnostics in the dynamic counters', () => {
  it('report what happened, without telemetry', () => {
    const { dynamic } = setup(lineChartSvg(REDS));
    const charts = dynamic.diagnostics().charts;
    expect(charts).toMatchObject({
      chartsDetected: 1,
      chartsSupported: 1,
      seriesAnalyzed: 3,
      seriesAdapted: 2,
      legendsMapped: 1,
    });
    expect(ruleCount()).toBe(0);
  });
});
