import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StylesheetManager } from '@core/adaptation';
import { CHART_NODE_ATTRIBUTE } from '@core/charts';
import { ChartController } from '@features/charts';
import { REDS } from '../../core/charts/builders';
import {
  barChartSvg,
  createChartEnvironment,
  lineChartSvg,
  pieChartSvg,
  scatterChartSvg,
} from './engine';

/**
 * The chart controller in jsdom, with the miniature engine of ./engine.ts standing in for the
 * browser's cascade and layout. These tests are about the controller's contracts: what it writes,
 * that it can be taken back exactly, that repeating it changes nothing, that it keeps nothing it
 * should not, and that it does not claim what the browser did not do.
 */
const SETTINGS = { enabled: true, adaptCharts: true, visionProfile: 'deuteranopia' as const };
const RED_GREEN = ['#d62728', '#2ca02c'];
/** Six near-identical reds: all pairs conflict, so five series need an encoding and some need markers (a <defs>). */
const SIX = ['#d62728', '#d82a29', '#da2c2b', '#dc2e2d', '#de302f', '#e03231'];

function setup(profile: 'deuteranopia' | 'protanopia' | 'tritanopia' | 'normal' = 'deuteranopia') {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  const sheet = new StylesheetManager(document);
  const env = createChartEnvironment(document);
  const charts = new ChartController({ doc: document, sheet, env });
  charts.begin({ ...SETTINGS, visionProfile: profile });
  const scan = () => charts.update([{ element: document.body, scope: 'subtree' }]);
  const mount = (html: string) => document.body.insertAdjacentHTML('beforeend', html);
  return { charts, sheet, env, scan, mount };
}

/** The chart as the page wrote it: our nodes and `data-coloradapt-*` attributes stripped. */
function original(svg: Element): string {
  const clone = svg.cloneNode(true) as Element;
  for (const node of clone.querySelectorAll(`[${CHART_NODE_ATTRIBUTE}]`)) node.remove();
  for (const element of [clone, ...clone.querySelectorAll('*')]) {
    for (const name of element.getAttributeNames()) {
      if (name.startsWith('data-coloradapt')) element.removeAttribute(name);
    }
  }
  return clone.outerHTML;
}

const svgOf = (id = 'chart') => document.getElementById(id) as unknown as SVGSVGElement;
const lineMarks = (svg: Element) => [...svg.querySelectorAll('path.line')];
const css = () => document.getElementById('coloradapt-stylesheet')?.textContent ?? '';
const leftovers = () => ({
  nodes: document.querySelectorAll(`[${CHART_NODE_ATTRIBUTE}]`).length,
  marks: document.querySelectorAll(
    '[data-coloradapt-chart-mark],[data-coloradapt-chart-legend],[data-coloradapt-chart-owned]',
  ).length,
  sheet: document.getElementById('coloradapt-stylesheet') !== null,
});

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});
afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('line chart: dash and marker redundancy, legend in step', () => {
  it('the series that color alone cannot separate get a dash and/or marker; the legend shows the same', () => {
    const { charts, env, scan, mount } = setup();
    mount(lineChartSvg(RED_GREEN));
    scan();
    const [first, second] = lineMarks(svgOf());
    expect(env.getStyle(first!).getPropertyValue('stroke-dasharray')).toBe('none');
    const dash = env.getStyle(second!).getPropertyValue('stroke-dasharray');
    expect(dash).not.toBe('none');

    const swatches = [...svgOf().querySelectorAll('line.swatch')];
    // A legend line sample takes the very same dash (scaled to its own stroke, here equal).
    expect(env.getStyle(swatches[1]!).getPropertyValue('stroke-dasharray')).toBe(dash);
    expect(env.getStyle(swatches[0]!).getPropertyValue('stroke-dasharray')).toBe('none');
    expect(charts.diagnostics()).toMatchObject({
      chartsSupported: 1,
      seriesAnalyzed: 2,
      seriesAdapted: 1,
      legendsMapped: 1,
    });
  });

  it('chart mark identity equals legend identity for every adapted series', () => {
    const { env, scan, mount } = setup();
    mount(lineChartSvg(REDS));
    scan();
    const marks = lineMarks(svgOf());
    const swatches = [...svgOf().querySelectorAll('line.swatch')];
    marks.forEach((mark, i) => {
      const style = env.getStyle(mark);
      const legend = env.getStyle(swatches[i]!);
      expect(legend.getPropertyValue('stroke-dasharray')).toBe(
        style.getPropertyValue('stroke-dasharray'),
      );
      const markerOf = (el: Element) =>
        el.getAttribute('data-coloradapt-chart-mark') ??
        el.getAttribute('data-coloradapt-chart-legend');
      expect(markerOf(swatches[i]!)).toBe(markerOf(mark));
    });
    // and the three are pairwise different by dash or marker
    const identities = marks.map((mark) => {
      const style = env.getStyle(mark);
      return `${style.getPropertyValue('stroke-dasharray')}|${style.getPropertyValue('marker-mid')}`;
    });
    expect(new Set(identities).size).toBe(3);
  });

  it('markers live in one owned <defs> with unique ids; nothing else of the page is edited', () => {
    const { charts, scan, mount } = setup();
    mount(lineChartSvg(SIX));
    const before = svgOf().outerHTML;
    scan();
    const defs = svgOf().querySelectorAll('defs[data-coloradapt-chart-node]');
    expect(defs).toHaveLength(1);
    const ids = [...defs[0]!.querySelectorAll('[id]')].map((el) => el.id);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith('coloradapt-'))).toBe(true);
    expect(original(svgOf())).toBe(before);
    expect(charts.diagnostics().markersCreated).toBeGreaterThanOrEqual(1);
  });

  it('a page id that looks like ours is never reused', () => {
    const { scan, mount } = setup();
    mount(`<div id="coloradapt-c1-m1"></div>${lineChartSvg(REDS)}`);
    scan();
    const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('palettes everybody can tell apart, and normal vision, are not touched', () => {
    const a = setup();
    a.mount(lineChartSvg(['#0072b2', '#d55e00', '#f0e442']));
    a.scan();
    expect(leftovers().nodes).toBe(0);
    expect(a.charts.diagnostics()).toMatchObject({ chartsSupported: 1, seriesAdapted: 0 });
    const b = setup('normal');
    b.mount(lineChartSvg(REDS));
    b.scan();
    expect(leftovers()).toEqual({ nodes: 0, marks: 0, sheet: false });
  });

  it('already-distinguishable charts (dashes the page drew) are not over-adapted', () => {
    const { charts, scan, mount } = setup();
    mount(lineChartSvg(REDS, { dashes: [null, '6 3', '2 2'] }));
    scan();
    expect(leftovers().nodes).toBe(0);
    expect(charts.diagnostics().seriesAdapted).toBe(0);
  });

  it('a chart without a legend is adapted without one', () => {
    const { env, scan, mount } = setup();
    mount(lineChartSvg(RED_GREEN, { legend: false }));
    scan();
    expect(env.getStyle(lineMarks(svgOf())[1]!).getPropertyValue('stroke-dasharray')).not.toBe(
      'none',
    );
  });
});

describe('profile changes', () => {
  it('what a profile needed does not outlive it: red/green dashed for a deuteranope is not dashed for a tritanope', () => {
    const { charts, env, scan, mount } = setup();
    mount(lineChartSvg(RED_GREEN));
    scan();
    expect(env.getStyle(lineMarks(svgOf())[1]!).getPropertyValue('stroke-dasharray')).not.toBe(
      'none',
    );
    charts.begin({ ...SETTINGS, visionProfile: 'tritanopia' });
    scan();
    expect(leftovers()).toEqual({ nodes: 0, marks: 1, sheet: false }); // only the ownership mark remains
    expect(env.getStyle(lineMarks(svgOf())[1]!).getPropertyValue('stroke-dasharray')).toBe('none');
  });
});

describe('reversibility', () => {
  it('end() restores the page exactly: no node, attribute, rule or sheet is left', () => {
    const { charts, scan, mount } = setup();
    mount(lineChartSvg(REDS) + barChartSvg(RED_GREEN, { id: 'bars' }));
    const before = document.body.innerHTML;
    scan();
    expect(leftovers().nodes).toBeGreaterThan(0);
    expect(document.body.innerHTML).not.toBe(before);
    charts.end();
    expect(document.body.innerHTML).toBe(before);
    expect(leftovers()).toEqual({ nodes: 0, marks: 0, sheet: false });
  });

  it('switching the profile to normal removes everything (begin with an inactive profile)', () => {
    const { charts, scan, mount } = setup();
    mount(lineChartSvg(REDS));
    const before = document.body.innerHTML;
    scan();
    charts.begin({ ...SETTINGS, visionProfile: 'normal' });
    expect(document.body.innerHTML).toBe(before);
  });

  it('adaptCharts off removes everything', () => {
    const { charts, scan, mount } = setup();
    mount(lineChartSvg(REDS));
    const before = document.body.innerHTML;
    scan();
    charts.begin({ ...SETTINGS, adaptCharts: false });
    expect(document.body.innerHTML).toBe(before);
  });
});

describe('idempotency', () => {
  it('scanning again changes nothing: no duplicate nodes, markers or rules, no rewrites', () => {
    const { charts, scan, mount } = setup();
    mount(lineChartSvg(SIX));
    scan();
    const html = document.body.innerHTML;
    const sheet = css();
    const created = charts.diagnostics();
    for (let i = 0; i < 3; i += 1) scan();
    expect(document.body.innerHTML).toBe(html);
    expect(css()).toBe(sheet);
    const after = charts.diagnostics();
    expect(after.markersCreated).toBe(created.markersCreated);
    expect(after.chartPassesSkipped).toBe(3);
    expect(after.chartDefs).toBe(1);
  });

  it('a full refresh (begin) rebuilds the same encodings', () => {
    const { charts, scan, mount } = setup();
    mount(lineChartSvg(REDS));
    scan();
    const html = document.body.innerHTML;
    charts.begin(SETTINGS);
    scan();
    expect(document.body.innerHTML).toBe(html);
  });
});

describe('dynamic charts', () => {
  const dashesOf = (env: ReturnType<typeof setup>['env']) =>
    lineMarks(svgOf()).map(
      (mark) =>
        env.getStyle(mark).getPropertyValue('stroke-dasharray') +
        '|' +
        env.getStyle(mark).getPropertyValue('marker-mid'),
    );

  it("a series appended keeps the others' identities and gets a new one", () => {
    const { env, scan, mount } = setup();
    mount(lineChartSvg(REDS.slice(0, 2)));
    scan();
    const before = dashesOf(env);
    svgOf().remove();
    // (the page redraws the chart with one more series: same element would be kept by a real
    // framework; here the same chart is rebuilt and the controller must give the old ones the same look)
    mount(lineChartSvg(REDS));
    scan();
    const after = dashesOf(env);
    expect(after.slice(0, 2)).toEqual(before);
    expect(new Set(after).size).toBe(3);
  });

  it('adding a path to the same <svg> is picked up and keeps the first two as they were', () => {
    const { env, scan, mount } = setup();
    mount(lineChartSvg(REDS.slice(0, 2), { legend: false }));
    scan();
    const before = dashesOf(env);
    const third = svgOf().querySelector('path.line')!.cloneNode(true) as Element;
    for (const name of third.getAttributeNames())
      if (name.startsWith('data-coloradapt')) third.removeAttribute(name);
    third.setAttribute('stroke', REDS[2]!);
    third.setAttribute('class', 'line line-2');
    svgOf().querySelector('path.line:last-of-type')!.after(third);
    scan();
    const after = dashesOf(env);
    expect(after.slice(0, 2)).toEqual(before);
    expect(new Set(after).size).toBe(3);
  });

  it("removing a series from the middle leaves the others' identities and no stale artifacts", () => {
    const { env, scan, mount } = setup();
    mount(lineChartSvg(REDS, { legend: false }));
    scan();
    const before = dashesOf(env);
    lineMarks(svgOf())[1]!.remove();
    scan();
    expect(dashesOf(env)).toEqual([before[0], before[2]]);
    // the series that left takes its marker with it: only the two remaining ones have rules
    expect(css().match(/data-coloradapt-chart-mark=/g)?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it('replacing the chart cleans up the old one and adapts the new one', () => {
    const { charts, scan, mount } = setup();
    mount(lineChartSvg(SIX));
    scan();
    const first = leftovers();
    expect(first.nodes).toBeGreaterThan(0);
    svgOf().remove();
    mount(lineChartSvg(SIX, { id: 'chart2' }));
    scan();
    expect(document.querySelectorAll('defs[data-coloradapt-chart-node]')).toHaveLength(1);
    expect(
      document.getElementById('chart2')!.querySelectorAll('defs[data-coloradapt-chart-node]'),
    ).toHaveLength(1);
    expect(charts.diagnostics().chartsSupported).toBe(1);
  });

  it('a removed chart leaves no rule behind, even when nothing else is scanned', () => {
    const { charts, scan, mount } = setup();
    mount(lineChartSvg(REDS));
    scan();
    expect(css()).toContain('coloradapt-chart');
    svgOf().remove();
    charts.update([]);
    expect(leftovers()).toEqual({ nodes: 0, marks: 0, sheet: false });
  });

  it('a page that removes our <defs> gets the chart re-adapted on the next pass', () => {
    const { scan, mount } = setup();
    mount(lineChartSvg(SIX));
    scan();
    svgOf().querySelector('defs[data-coloradapt-chart-node]')!.remove();
    scan();
    expect(svgOf().querySelectorAll('defs[data-coloradapt-chart-node]')).toHaveLength(1);
  });

  it('retention: 100 charts created, adapted and removed leave nothing', () => {
    const { charts, scan, mount } = setup();
    for (let i = 0; i < 100; i += 1) {
      mount(lineChartSvg(REDS, { id: `c${i}` }));
      scan();
      document.getElementById(`c${i}`)!.remove();
      charts.update([]);
    }
    expect(charts.diagnostics()).toMatchObject({
      chartOwners: 0,
      chartDefs: 0,
      chartOverlays: 0,
      chartRules: 0,
      chartPending: 0,
      chartsDetected: 0,
    });
    expect(leftovers()).toEqual({ nodes: 0, marks: 0, sheet: false });
  });
});

describe('interaction and accessibility safety', () => {
  it('overlays are decorative: hidden from assistive technology, not focusable, not hit-testable', () => {
    const { scan, mount } = setup();
    // a line chart whose legend swatches are boxes: the dash is drawn as a sample line over them
    mount(lineChartSvg(REDS, { legendKind: 'box' }));
    scan();
    const overlays = document.querySelectorAll(`[${CHART_NODE_ATTRIBUTE}="overlay"]`);
    expect(overlays.length).toBeGreaterThan(0);
    for (const overlay of overlays) {
      expect(overlay.getAttribute('aria-hidden')).toBe('true');
      expect(overlay.getAttribute('pointer-events')).toBe('none');
      expect(overlay.hasAttribute('tabindex')).toBe(false);
      expect(overlay.querySelector('title, desc, text')).toBeNull();
    }
  });

  it("adds no accessible names and no focusable nodes, and leaves the page's attributes alone", () => {
    const { scan, mount } = setup();
    mount(`<button id="b">go</button>${lineChartSvg(REDS)}`);
    const names = () =>
      [...document.querySelectorAll('[aria-label],[role],[tabindex],title')].length;
    const before = names();
    scan();
    expect(names()).toBe(before);
    expect(document.querySelectorAll('[tabindex]')).toHaveLength(0);
  });

  it('legend text and swatch elements stay where the page put them (no wrapping, no replacing)', () => {
    const { scan, mount } = setup();
    mount(lineChartSvg(REDS));
    const items = [...svgOf().querySelectorAll('.legend-item')];
    const before = items.map((item) => item.children.length);
    scan();
    const after = [...svgOf().querySelectorAll('.legend-item')];
    expect(after).toEqual(items); // same elements
    // only decorative overlays were added next to the swatches
    after.forEach((item, i) => {
      const own = [...item.children].filter((child) => !child.hasAttribute(CHART_NODE_ATTRIBUTE));
      expect(own).toHaveLength(before[i]!);
    });
  });
});

describe('what the browser reproduces is what is reported', () => {
  it('a page rule that out-ranks ours makes the chart "not applied": rolled back, nothing left', () => {
    const { charts, scan, mount } = setup();
    document.head.insertAdjacentHTML(
      'beforeend',
      '<style>#chart .line { stroke-dasharray: none !important }</style>',
    );
    mount(lineChartSvg(REDS));
    scan();
    expect(charts.diagnostics()).toMatchObject({
      chartNotApplied: 1,
      seriesAdapted: 0,
      chartDefs: 0,
      chartRules: 0,
    });
    expect(leftovers().nodes).toBe(0);
    expect(leftovers().marks).toBe(1); // only the ownership mark on the <svg>
    expect(charts.inspect(svgOf())).toMatchObject({ status: 'limited', reason: 'not-applied' });
  });

  it.each([
    ['class', '<style>.line { stroke-linecap: round }</style>'],
    ['id', '<style>#chart path { stroke-width: 3 }</style>'],
  ])('page %s rules that do not touch the properties M7 writes are no obstacle', (_name, style) => {
    const { charts, scan, mount } = setup();
    document.head.insertAdjacentHTML('beforeend', style);
    mount(lineChartSvg(REDS));
    scan();
    expect(charts.diagnostics().chartNotApplied).toBe(0);
    expect(charts.diagnostics().seriesAdapted).toBeGreaterThan(0);
  });
});

describe('bars, scatter and pie', () => {
  it('bars get a pattern fill from an owned <pattern>; the legend swatch gets the same fill', () => {
    const { charts, env, scan, mount } = setup();
    mount(barChartSvg(RED_GREEN));
    scan();
    const pattern = svgOf().querySelector('defs[data-coloradapt-chart-node] pattern');
    expect(pattern).not.toBeNull();
    const id = pattern!.id;
    const bars = [...svgOf().querySelectorAll('rect.bar')];
    const filled = bars.filter((bar) => env.getStyle(bar).getPropertyValue('fill').includes(id));
    expect(filled).toHaveLength(3); // the second series' three bars
    const swatches = [...svgOf().querySelectorAll('rect.swatch')];
    expect(env.getStyle(swatches[1]!).getPropertyValue('fill')).toContain(id);
    expect(env.getStyle(swatches[0]!).getPropertyValue('fill')).not.toContain('url');
    expect(charts.diagnostics().patternsCreated).toBe(1);
  });

  it('scatter series get another silhouette as CSS on their own points: no node, geometry untouched', () => {
    const { charts, env, scan, mount } = setup();
    mount(scatterChartSvg(RED_GREEN));
    const before = svgOf().outerHTML;
    scan();
    expect(original(svgOf())).toBe(before);
    expect(svgOf().querySelectorAll(`[${CHART_NODE_ATTRIBUTE}]`)).toHaveLength(0);
    const dots = [...svgOf().querySelectorAll('circle.dot')];
    const first = dots.filter((dot) => dot.classList.contains('dot-0'));
    const second = dots.filter((dot) => dot.classList.contains('dot-1'));
    expect(first).toHaveLength(8);
    expect(second).toHaveLength(8);
    expect(first.every((dot) => env.getStyle(dot).getPropertyValue('clip-path') === 'none')).toBe(
      true,
    );
    // the first catalog shape is a diamond: a polygon clip on all eight points and on the legend dot
    expect(
      second.every((dot) => env.getStyle(dot).getPropertyValue('clip-path').startsWith('polygon(')),
    ).toBe(true);
    const swatches = [...svgOf().querySelectorAll('circle.swatch')];
    expect(env.getStyle(swatches[1]!).getPropertyValue('clip-path')).toContain('polygon(');
    expect(env.getStyle(swatches[0]!).getPropertyValue('clip-path')).toBe('none');
    expect(charts.diagnostics()).toMatchObject({
      overlaysCreated: 0,
      chartOverlays: 0,
      seriesAdapted: 1,
    });
  });

  it('a hollow ring is the last shape of the catalog: fill none, a stroke in the series color', () => {
    const { env, scan, mount } = setup();
    const colors = ['#d62728', '#d82a29', '#da2c2b', '#dc2e2d', '#de302f', '#e03231'];
    mount(scatterChartSvg(colors, { id: 'many' }));
    scan();
    const last = svgOf('many').querySelector('circle.dot-5')!;
    expect(env.getStyle(last).getPropertyValue('fill')).toBe('none');
    expect(env.getStyle(last).getPropertyValue('stroke')).toBe('rgb(224, 50, 49)');
    const shapes = new Set(
      colors.map((_c, i) => {
        const dot = svgOf('many').querySelector(`circle.dot-${i}`)!;
        return `${env.getStyle(dot).getPropertyValue('clip-path')}|${env.getStyle(dot).getPropertyValue('fill')}`;
      }),
    );
    expect(shapes.size).toBe(6);
  });

  it('a pie with a complete legend gets distinct patterns; without one it is not adapted', () => {
    const a = setup();
    a.mount(pieChartSvg(REDS));
    a.scan();
    expect(svgOf().querySelectorAll('pattern').length).toBeGreaterThanOrEqual(2);
    expect(a.charts.diagnostics().chartsSupported).toBe(1);

    const b = setup();
    b.mount(pieChartSvg(REDS, { legend: false }));
    b.scan();
    expect(svgOf().querySelectorAll('pattern')).toHaveLength(0);
    // arcs in a circle without a legend entry per slice are not "a pie" yet (a logo, a gauge): not claimed
    expect(b.charts.inspect(svgOf())).toMatchObject({ status: 'unknown' });
    expect(b.charts.owns(svgOf())).toBe(false);
  });
});

describe('ownership (M5 does not touch what M7 owns)', () => {
  it('owns() is true for a HIGH-confidence chart, adapted or not, and false for other SVGs', () => {
    const { charts, mount } = setup();
    mount(lineChartSvg(REDS) + barChartSvg(['#0072b2', '#d55e00'], { id: 'ok' }));
    mount('<svg id="icon" viewBox="0 0 24 24"><path d="M0 0 L10 10 L20 0 Z" fill="#333"/></svg>');
    expect(charts.owns(svgOf())).toBe(true);
    expect(charts.owns(svgOf('ok'))).toBe(true);
    expect(charts.owns(svgOf('icon'))).toBe(false);
    charts.endPass();
    expect(charts.diagnostics().chartPending).toBe(0);
  });

  it('is false while the layer is inactive (setting off or normal vision)', () => {
    const { charts, mount } = setup('normal');
    mount(lineChartSvg(REDS));
    expect(charts.owns(svgOf())).toBe(false);
  });

  it('the ownership mark is data-coloradapt-chart-owned on the <svg>, removed when ownership ends', () => {
    const { charts, scan, mount } = setup();
    mount(lineChartSvg(REDS));
    scan();
    expect(svgOf().hasAttribute('data-coloradapt-chart-owned')).toBe(true);
    charts.end();
    expect(svgOf().hasAttribute('data-coloradapt-chart-owned')).toBe(false);
  });
});

describe('things that are not charts, and canvases', () => {
  it('logos, illustrations and icons get no attribute, no node, no state', () => {
    const { charts, scan, mount } = setup();
    mount(
      '<svg id="logo" viewBox="0 0 100 100"><path d="M50 50 L90 50 A40 40 0 0 1 50 90 Z" fill="#e63946" data-box="10,10,80,80"/><path d="M50 50 L50 90 A40 40 0 0 1 10 50 Z" fill="#457b9d" data-box="10,10,80,80"/><path d="M50 50 L10 50 A40 40 0 0 1 50 10 Z" fill="#1d3557" data-box="10,10,80,80"/><path d="M50 50 L50 10 A40 40 0 0 1 90 50 Z" fill="#ffb703" data-box="10,10,80,80"/></svg>',
    );
    const before = document.body.innerHTML;
    scan();
    expect(document.body.innerHTML).toBe(before);
    expect(charts.diagnostics()).toMatchObject({ chartsDetected: 0, chartsSupported: 0 });
  });

  it('canvases are classified, counted, and never touched', () => {
    const { charts, scan, mount } = setup();
    mount(
      '<div class="chart-container"><canvas id="a" width="300" height="150"></canvas></div>' +
        '<canvas id="game" class="game-board" width="300" height="300"></canvas>' +
        '<canvas id="sig" aria-label="signature pad"></canvas>' +
        '<canvas id="plain"></canvas>',
    );
    const before = document.body.innerHTML;
    scan();
    scan();
    expect(document.body.innerHTML).toBe(before);
    expect(charts.diagnostics()).toMatchObject({ canvasCharts: 1, canvasUnknown: 3 });
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
  });

  const signature = (proto: object, name: string): string => {
    const d = Object.getOwnPropertyDescriptor(proto, name) as
      { value?: unknown; get?: unknown } | undefined;
    return String(d?.value ?? d?.get);
  };

  it('CanvasRenderingContext2D is never patched', () => {
    const proto = (globalThis as { CanvasRenderingContext2D?: { prototype: object } })
      .CanvasRenderingContext2D?.prototype;
    const before = proto ? Object.getOwnPropertyNames(proto).map((n) => signature(proto, n)) : [];
    const { scan, mount } = setup();
    mount('<div class="chart"><canvas></canvas></div>');
    scan();
    const after = proto ? Object.getOwnPropertyNames(proto).map((n) => signature(proto, n)) : [];
    expect(after).toEqual(before);
  });
});

describe('structural limits', () => {
  it('a chart over the mark budget is read in bounded work and refused', () => {
    const { charts, scan, mount } = setup();
    const many = Array.from(
      { length: 2100 },
      (_, i) => `<circle cx="${i}" cy="5" r="2" fill="#d62728" data-box="${i},3,4,4"></circle>`,
    ).join('');
    mount(`<svg id="big" viewBox="0 0 400 300">${many}</svg>`);
    scan();
    expect(charts.diagnostics().marksScanned).toBeLessThanOrEqual(2100);
    expect(charts.diagnostics()).toMatchObject({ chartDefs: 0, chartRules: 0 });
  });
});
