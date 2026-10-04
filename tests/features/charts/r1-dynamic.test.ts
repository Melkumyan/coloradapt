import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StylesheetManager } from '@core/adaptation';
import { CHART_NODE_ATTRIBUTE } from '@core/charts';
import { DEFAULT_USER_SETTINGS, type UserSettings, type VisionProfile } from '@domain/models';
import { ChartController, readChartFacts } from '@features/charts';
import { createDynamicContentController } from '@features/dynamic-analysis';
import { createManualScheduler, html } from '../dynamic/helpers';
import { REDS } from '../../core/charts/builders';
import {
  barChartSvg,
  createChartEnvironment,
  lineChartSvg,
  pieChartSvg,
  scatterChartSvg,
} from './engine';

/**
 * M7.R1 in jsdom: identity over dynamic updates and profile switches, boundaries, retention across
 * many charts, removal / re-insertion, and the pipeline (M4) around the resize / geometry bridge.
 */
const SETTINGS = { enabled: true, adaptCharts: true, visionProfile: 'deuteranopia' as const };
const SIX = ['#d62728', '#d82a29', '#da2c2b', '#dc2e2d', '#de302f', '#e03231'];

function setup(profile: VisionProfile = 'deuteranopia', strength?: number) {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  const sheet = new StylesheetManager(document);
  const env = createChartEnvironment(document);
  const charts = new ChartController({ doc: document, sheet, env });
  charts.begin({
    ...SETTINGS,
    visionProfile: profile,
    ...(strength === undefined ? {} : { adaptationStrength: strength }),
  });
  const scan = () => charts.update([{ element: document.body, scope: 'subtree' }]);
  const mount = (markup: string) => document.body.insertAdjacentHTML('beforeend', markup);
  return { charts, sheet, env, scan, mount };
}

const svgOf = (id = 'chart') => document.getElementById(id) as unknown as SVGSVGElement;
const sheetText = () => document.getElementById('coloradapt-stylesheet')?.textContent ?? '';
const chartRules = () =>
  sheetText()
    .split('\n')
    .filter((l) => l.includes('data-coloradapt-chart'));
const nodes = () => document.querySelectorAll(`[${CHART_NODE_ATTRIBUTE}]`).length;
/** Identity of every line: dash + marker as the browser (engine) reports them. */
function identities(env: ReturnType<typeof createChartEnvironment>): string[] {
  return [...svgOf().querySelectorAll('path.line')].map((p) => {
    const style = env.getStyle(p);
    return `${style.getPropertyValue('stroke-dasharray')}|${style.getPropertyValue('marker-mid').replace(/coloradapt-c\d+-/, 'coloradapt-')}`;
  });
}
const original = (svg: Element) => {
  const clone = svg.cloneNode(true) as Element;
  for (const node of clone.querySelectorAll(`[${CHART_NODE_ATTRIBUTE}]`)) node.remove();
  for (const el of [clone, ...clone.querySelectorAll('*')])
    for (const name of el.getAttributeNames())
      if (name.startsWith('data-coloradapt')) el.removeAttribute(name);
  return clone.outerHTML;
};

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});
afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('profile switching recomputes, never accumulates', () => {
  const CONFUSABLE = ['#d62728', '#2ca02c', '#ff7f0e'];

  it('protanopia -> deuteranopia -> tritanopia -> protanopia: each profile gets what a fresh start would give', () => {
    const { charts, env, scan, mount } = setup('protanopia');
    mount(lineChartSvg(CONFUSABLE, { keys: true }));
    scan();
    const fresh = (profile: VisionProfile) => {
      const other = setup(profile);
      other.mount(lineChartSvg(CONFUSABLE, { keys: true }));
      other.scan();
      return { ids: identities(other.env), css: chartRules().length };
    };
    const expected = {
      protanopia: fresh('protanopia'),
      deuteranopia: fresh('deuteranopia'),
      tritanopia: fresh('tritanopia'),
    };
    // rebuild the page for the long-lived controller
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    const sheet = new StylesheetManager(document);
    const longEnv = createChartEnvironment(document);
    const long = new ChartController({ doc: document, sheet, env: longEnv });
    document.body.insertAdjacentHTML('beforeend', lineChartSvg(CONFUSABLE, { keys: true }));
    const sequence: VisionProfile[] = [
      'protanopia',
      'deuteranopia',
      'tritanopia',
      'protanopia',
      'tritanopia',
      'deuteranopia',
    ];
    for (const profile of sequence) {
      long.begin({ ...SETTINGS, visionProfile: profile });
      long.update([{ element: document.body, scope: 'subtree' }]);
      expect(identities(longEnv)).toEqual(expected[profile as keyof typeof expected].ids);
      expect(chartRules().length).toBe(expected[profile as keyof typeof expected].css);
    }
    void charts;
    void env;
  });

  it('a tritanope gets nothing for red/green/orange: no stale protanopia encoding is left', () => {
    const { charts, scan, mount } = setup('protanopia');
    mount(lineChartSvg(CONFUSABLE));
    scan();
    expect(nodes() + chartRules().length).toBeGreaterThan(0);
    charts.begin({ ...SETTINGS, visionProfile: 'tritanopia' });
    charts.update([{ element: document.body, scope: 'subtree' }]);
    expect(chartRules()).toEqual([]);
    expect(document.querySelectorAll('[data-coloradapt-chart-mark]')).toHaveLength(0);
    expect(nodes()).toBe(0);
  });

  it('the strength of the M3 adaptation changes nothing about chart encodings (documented policy)', () => {
    const outputs = [0.2, 0.5, 1].map((strength) => {
      const { scan, mount, env } = setup('deuteranopia', strength);
      mount(lineChartSvg(REDS));
      scan();
      return { ids: identities(env), rules: chartRules().map((r) => r.replace(/c\d+/g, 'c')) };
    });
    expect(outputs[1]).toEqual(outputs[0]);
    expect(outputs[2]).toEqual(outputs[0]);
  });
});

describe('series identity across data and palette updates', () => {
  it('geometry changes under the same data-series keys keep every encoding', () => {
    const { env, scan, mount } = setup();
    mount(lineChartSvg(SIX.slice(0, 4), { keys: true }));
    scan();
    const before = identities(env);
    for (const path of svgOf().querySelectorAll('path.line')) {
      path.setAttribute('d', 'M60 50 L100 70 L140 40 L180 90 L220 60 L260 100 L300 80');
    }
    scan();
    expect(identities(env)).toEqual(before);
  });

  it('A B -> A B C -> A C -> A B C: A and B never change; B returns to the identity it had', () => {
    const { env, scan, mount } = setup();
    mount(lineChartSvg(SIX.slice(0, 3), { keys: true, legend: false }));
    const paths = () => [...svgOf().querySelectorAll('path.line')];
    const c = paths()[2]!;
    const parent = c.parentElement!;
    const anchor = c.nextSibling;
    c.remove();
    scan();
    const ab = identities(env);
    expect(ab).toHaveLength(2);
    parent.insertBefore(c, anchor);
    scan();
    const abc = identities(env);
    expect(abc.slice(0, 2)).toEqual(ab);
    expect(new Set(abc).size).toBe(3);

    const b = paths()[1]!;
    const bAnchor = b.nextSibling;
    b.remove();
    scan();
    const ac = identities(env);
    expect(ac[0]).toBe(abc[0]);
    expect(ac[1]).toBe(abc[2]);

    parent.insertBefore(b, bAnchor);
    scan();
    expect(identities(env)).toEqual(abc);
  });

  it('a palette change is re-evaluated: red/green become blue/purple and need nothing', () => {
    const { env, scan, mount } = setup();
    mount(lineChartSvg(['#d62728', '#2ca02c'], { keys: true }));
    scan();
    expect(identities(env)[1]).not.toBe('none|none');
    const [a, b] = svgOf().querySelectorAll('path.line');
    const [la, lb] = svgOf().querySelectorAll('line.swatch');
    a!.setAttribute('stroke', '#0072b2');
    la!.setAttribute('stroke', '#0072b2');
    b!.setAttribute('stroke', '#f0e442');
    lb!.setAttribute('stroke', '#f0e442');
    scan();
    expect(identities(env)).toEqual(['none|none', 'none|none']);
    expect(chartRules()).toEqual([]);
    expect(nodes()).toBe(0);
  });

  it('a legend that loses an item makes the mapping partial: the whole chart is refused, nothing is left', () => {
    const { charts, scan, mount } = setup();
    mount(lineChartSvg(SIX.slice(0, 3), { keys: true }));
    scan();
    expect(chartRules().length).toBeGreaterThan(0);
    svgOf().querySelectorAll('g.legend-item')[2]!.remove();
    scan();
    expect(charts.inspect(svgOf())).toMatchObject({ status: 'limited' });
    expect(chartRules()).toEqual([]);
    expect(
      document.querySelectorAll('[data-coloradapt-chart-mark],[data-coloradapt-chart-legend]'),
    ).toHaveLength(0);
  });

  it('a legend that gains the missing item maps again and the chart is adapted', () => {
    const { charts, scan, mount } = setup();
    mount(lineChartSvg(SIX.slice(0, 3), { keys: true }));
    const item = svgOf().querySelectorAll('g.legend-item')[2]!;
    const parent = item.parentElement!;
    item.remove();
    scan();
    expect(charts.inspect(svgOf()).status).toBe('limited');
    parent.append(item);
    scan();
    expect(charts.inspect(svgOf())).toMatchObject({ status: 'supported' });
    expect(chartRules().length).toBeGreaterThan(0);
  });

  it('a legend label that changes (same swatch) keeps the mapping and the encoding', () => {
    const { env, scan, mount } = setup();
    mount(lineChartSvg(SIX.slice(0, 3), { keys: true }));
    scan();
    const before = identities(env);
    svgOf()
      .querySelectorAll('text')
      .forEach((t) => {
        if (t.textContent?.startsWith('Series')) t.textContent = `${t.textContent} (updated)`;
      });
    scan();
    expect(identities(env)).toEqual(before);
  });
});

describe('structural boundaries are exact', () => {
  const env = () => createChartEnvironment(document);
  const circles = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `<circle cx="${i}" cy="5" r="2" fill="#d62728" data-box="${i},3,4,4"></circle>`,
    ).join('');

  it('2000 marks are read in full; the 2001st is over the budget', () => {
    document.body.innerHTML = `<svg id="a">${circles(2000)}</svg><svg id="b">${circles(2001)}</svg>`;
    expect(readChartFacts(document.getElementById('a')!, env()).facts.overBudget).toBe(false);
    expect(readChartFacts(document.getElementById('a')!, env()).facts.marks).toHaveLength(2000);
    expect(readChartFacts(document.getElementById('b')!, env()).facts.overBudget).toBe(true);
  });

  it('marks and texts share the budget', () => {
    const texts = (n: number) =>
      Array.from({ length: n }, (_, i) => `<text data-box="${i},0,5,5">t${i}</text>`).join('');
    document.body.innerHTML = `<svg id="a">${circles(1000)}${texts(1000)}</svg><svg id="b">${circles(1000)}${texts(1001)}</svg>`;
    expect(readChartFacts(document.getElementById('a')!, env()).facts.overBudget).toBe(false);
    expect(readChartFacts(document.getElementById('b')!, env()).facts.overBudget).toBe(true);
  });

  it('6000 descendants are walked; the 6001st is over the budget', () => {
    const groups = (n: number) => '<g></g>'.repeat(n);
    document.body.innerHTML = `<svg id="a">${groups(6000)}</svg><svg id="b">${groups(6001)}</svg>`;
    expect(readChartFacts(document.getElementById('a')!, env()).facts.overBudget).toBe(false);
    expect(readChartFacts(document.getElementById('b')!, env()).facts.overBudget).toBe(true);
  });
});

describe('retention: many charts, several cycles, nothing left', () => {
  const kinds = [
    (id: string) => lineChartSvg(SIX, { id }),
    (id: string) => barChartSvg(SIX.slice(0, 3), { id }),
    (id: string) => pieChartSvg(SIX.slice(0, 3), { id }),
    (id: string) => scatterChartSvg(SIX.slice(0, 3), { id }),
  ];

  // 300 charts in jsdom: ~12 s alone (identical on M7 and M8), ~30 s when every
  // worker is busy. Stress category: its own hang guard, the global stays 30 s.
  it(
    '100 charts x 3 cycles: ids never collide while they live, and removal leaves 0 owners, defs, rules',
    { timeout: 90_000 },
    () => {
      const { charts, scan, mount } = setup();
      for (let cycle = 0; cycle < 3; cycle += 1) {
        for (let i = 0; i < 100; i += 1) mount(kinds[i % kinds.length]!(`c${cycle}-${i}`));
        scan();
        const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
        expect(new Set(ids).size).toBe(ids.length);
        const defs = document.querySelectorAll('defs[data-coloradapt-chart-node]');
        expect(defs.length).toBeGreaterThanOrEqual(75);
        const patternIds = [...document.querySelectorAll('pattern')].map((p) => p.id);
        expect(patternIds.length).toBeGreaterThan(0);
        expect(new Set(patternIds).size).toBe(patternIds.length);
        document.body.innerHTML = '';
        charts.update([]);
        expect(charts.diagnostics()).toMatchObject({
          chartOwners: 0,
          chartDefs: 0,
          chartOverlays: 0,
          chartRules: 0,
          chartPending: 0,
          chartWatched: 0,
        });
        expect(nodes()).toBe(0);
        expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
      }
    },
  );

  it('a chart removed and a look-alike inserted gets fresh ownership (no stale reference is reused)', () => {
    const { charts, scan, mount } = setup();
    mount(lineChartSvg(SIX));
    scan();
    const first = svgOf()
      .querySelector('[data-coloradapt-chart-owner]')!
      .getAttribute('data-coloradapt-chart-owner');
    const rules = chartRules().length;
    svgOf().remove();
    charts.update([]);
    expect(nodes()).toBe(0);
    mount(lineChartSvg(SIX));
    scan();
    const second = svgOf()
      .querySelector('[data-coloradapt-chart-owner]')!
      .getAttribute('data-coloradapt-chart-owner');
    expect(second).not.toBe(first);
    expect(chartRules().length).toBe(rules);
    expect(document.querySelectorAll('defs[data-coloradapt-chart-node]')).toHaveLength(1);
  });

  it('the page stays byte-identical underneath: only data-coloradapt names and owned nodes are ours', () => {
    const { scan, mount } = setup();
    mount(lineChartSvg(SIX));
    const before = svgOf().outerHTML;
    scan();
    expect(original(svgOf())).toBe(before);
  });
});

describe('the pipeline around the bridge (M4): one pass per change, no loop', () => {
  class FakeResizeObserver {
    static live = new Set<FakeResizeObserver>();
    targets = new Set<Element>();
    constructor(private readonly callback: ResizeObserverCallback) {
      FakeResizeObserver.live.add(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
      FakeResizeObserver.live.delete(this);
    }
    fire(target: Element, width: number, height: number) {
      this.callback(
        [{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry],
        this,
      );
    }
  }
  const SETTINGS_FULL: UserSettings = {
    ...DEFAULT_USER_SETTINGS,
    visionProfile: 'deuteranopia',
    adaptationStrength: 1,
    adaptCharts: true,
  };
  let original: unknown;
  let current: ReturnType<typeof createDynamicContentController> | null = null;

  beforeEach(() => {
    original = (window as unknown as { ResizeObserver?: unknown }).ResizeObserver;
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
    FakeResizeObserver.live.clear();
  });
  afterEach(() => {
    current?.dynamic.dispose();
    current?.disableAdaptation();
    current = null;
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = original;
  });

  function boot(markup: string, settings: UserSettings = SETTINGS_FULL) {
    document.head.innerHTML = '';
    html(markup);
    const controller = createDynamicContentController(
      document,
      { now: () => 0 },
      { scheduler: createManualScheduler() },
      { chartEnv: createChartEnvironment(document) },
    );
    current = controller;
    controller.enableAdaptation('https://example.com', settings);
    return controller;
  }
  const fire = (target: Element, w: number, h: number) => {
    for (const o of FakeResizeObserver.live) if (o.targets.has(target)) o.fire(target, w, h);
  };

  it('a resize becomes exactly one incremental pass over the chart, then silence', () => {
    const controller = boot(lineChartSvg(SIX));
    const { dynamic } = controller;
    const settled = dynamic.flush();
    expect(settled.charts.chartWatched).toBe(1);
    fire(svgOf(), 640, 480);
    const after = dynamic.flush();
    expect(after.incrementalPasses).toBe(settled.incrementalPasses + 1);
    expect(after.fullRescans).toBe(settled.fullRescans);
    expect(after.charts.resizeSignals).toBe(1);
    // nothing of ours restarts it
    const again = dynamic.flush();
    expect(again.incrementalPasses).toBe(after.incrementalPasses);
    expect(again.charts.chartPending).toBe(0);
  });

  it('a path whose vertex count changes becomes one incremental pass; coordinate-only changes become none', async () => {
    const controller = boot(lineChartSvg(SIX));
    const { dynamic } = controller;
    const settled = dynamic.flush();
    const line = svgOf().querySelector('path.line')!;
    line.setAttribute('d', 'M60 100 L100 121 L140 92 L180 129 L220 84 L260 112');
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(dynamic.flush().incrementalPasses).toBe(settled.incrementalPasses);
    line.setAttribute('d', 'M60 100 L100 120 L140 90 L180 130 L220 80 L260 110 L300 100');
    await new Promise<void>((r) => setTimeout(r, 0));
    const after = dynamic.flush();
    expect(after.incrementalPasses).toBe(settled.incrementalPasses + 1);
    expect(after.charts.geometrySignals).toBe(1);
  });

  it('adaptation off: every observer is gone; on again: one subscription, not two', () => {
    const controller = boot(lineChartSvg(SIX));
    expect(FakeResizeObserver.live.size).toBe(1);
    controller.disableAdaptation();
    expect(FakeResizeObserver.live.size).toBe(0);
    controller.enableAdaptation('https://example.com', SETTINGS_FULL);
    expect(FakeResizeObserver.live.size).toBe(1);
    expect([...FakeResizeObserver.live][0]!.targets.size).toBe(1);
    controller.enableAdaptation('https://example.com', SETTINGS_FULL);
    expect(FakeResizeObserver.live.size).toBe(1);
    expect([...FakeResizeObserver.live][0]!.targets.size).toBe(1);
  });

  it('adaptCharts false: no chart resize work at all', () => {
    const controller = boot(lineChartSvg(SIX), { ...SETTINGS_FULL, adaptCharts: false });
    expect(FakeResizeObserver.live.size).toBe(0);
    expect(controller.dynamic.flush().charts.chartWatched).toBe(0);
  });

  it('a legend that moves away (not deleted) leaves the chart on its own: the chart is read again', () => {
    const controller = boot(
      `<div id="wrap"><div class="card" id="card">${lineChartSvg(REDS, { legend: false })}<ul class="chart-legend" id="lg"><li>Red</li></ul></div></div><section id="far"><div><div><div id="deep"></div></div></div></section>`,
    );
    const { dynamic } = controller;
    dynamic.flush();
    expect(document.querySelectorAll('[data-coloradapt-chart-mark]')).toHaveLength(0);
    document.getElementById('deep')!.append(document.getElementById('lg')!);
    dynamic.flush();
    expect(document.querySelectorAll('[data-coloradapt-chart-mark]').length).toBeGreaterThan(0);
    document.getElementById('card')!.append(document.getElementById('lg')!);
    dynamic.flush();
    expect(document.querySelectorAll('[data-coloradapt-chart-mark]')).toHaveLength(0);
  });

  it('a legend that appears next to an adapted chart is a pass over the chart, and the adaptation goes', () => {
    const controller = boot(
      `<div class="card" id="card">${lineChartSvg(REDS, { legend: false })}</div>`,
    );
    const { dynamic } = controller;
    dynamic.flush();
    expect(document.querySelectorAll('[data-coloradapt-chart-mark]').length).toBeGreaterThan(0);
    document
      .getElementById('card')!
      .insertAdjacentHTML('beforeend', '<ul class="chart-legend"><li>Red</li><li>Green</li></ul>');
    dynamic.flush();
    expect(document.querySelectorAll('[data-coloradapt-chart-mark]')).toHaveLength(0);
    expect(nodes()).toBe(0);
    // and when it goes, the chart is adapted again, from the removal alone
    document.querySelector('.chart-legend')!.remove();
    dynamic.flush();
    expect(document.querySelectorAll('[data-coloradapt-chart-mark]').length).toBeGreaterThan(0);
  });
});
