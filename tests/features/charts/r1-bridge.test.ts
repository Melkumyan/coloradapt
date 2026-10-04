import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StylesheetManager } from '@core/adaptation';
import { CHART_NODE_ATTRIBUTE } from '@core/charts';
import { ChartController, type ChartEnvironment } from '@features/charts';
import { REDS } from '../../core/charts/builders';
import { createChartEnvironment, lineChartSvg } from './engine';

/**
 * M7.R1: the resize / geometry bridge (docs/CHARTS.md, "Resize and geometry"). jsdom has no
 * ResizeObserver, so a controllable stand-in is installed; the MutationObserver is jsdom's own.
 */
const SETTINGS = { enabled: true, adaptCharts: true, visionProfile: 'deuteranopia' as const };

class FakeResizeObserver {
  static readonly live = new Set<FakeResizeObserver>();
  readonly targets = new Set<Element>();
  disconnected = false;
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.live.add(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
    this.disconnected = true;
    FakeResizeObserver.live.delete(this);
  }
  fire(target: Element, width: number, height: number): void {
    this.callback(
      [{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry],
      this,
    );
  }
}

/** Six near-identical reds: all pairs conflict, so some series need markers (a <defs>). */
const SIX = ['#d62728', '#d82a29', '#da2c2b', '#dc2e2d', '#de302f', '#e03231'];

const observedTargets = () => [...FakeResizeObserver.live].flatMap((o) => [...o.targets]);
const fire = (target: Element, width: number, height: number) => {
  for (const observer of FakeResizeObserver.live) {
    if (observer.targets.has(target)) observer.fire(target, width, height);
  }
};

let original: typeof ResizeObserver | undefined;
beforeEach(() => {
  original = (window as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  FakeResizeObserver.live.clear();
});
afterEach(() => {
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = original;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

function setup(
  profile: 'deuteranopia' | 'protanopia' | 'tritanopia' | 'normal' = 'deuteranopia',
  envOverrides: Partial<ChartEnvironment> = {},
) {
  const sheet = new StylesheetManager(document);
  const env = { ...createChartEnvironment(document), ...envOverrides };
  const charts = new ChartController({ doc: document, sheet, env });
  const signals: Element[] = [];
  charts.bindInvalidation((svg) => signals.push(svg));
  charts.begin({ ...SETTINGS, visionProfile: profile });
  const scan = () => charts.update([{ element: document.body, scope: 'subtree' }]);
  const mount = (html: string) => document.body.insertAdjacentHTML('beforeend', html);
  return { charts, sheet, env, signals, scan, mount };
}

const svgOf = (id = 'chart') => document.getElementById(id) as unknown as SVGSVGElement;
const nodes = () => document.querySelectorAll(`[${CHART_NODE_ATTRIBUTE}]`).length;

/** A line whose first series has `n` vertices (a straight run), the others as the fixture draws them. */
function setVertices(path: Element, n: number): void {
  const d = Array.from(
    { length: n },
    (_, k) => `${k === 0 ? 'M' : 'L'}${60 + k} ${100 + ((k * 7) % 40)}`,
  ).join(' ');
  path.setAttribute('d', d);
}

describe('resize bridge: one bounded observer for the charts the layer tracks', () => {
  it('watches an owned chart (and nothing else), with one observer', () => {
    const { charts, scan, mount } = setup();
    mount(`${lineChartSvg(REDS)}<svg id="icon" viewBox="0 0 24 24"><path d="M0 0h8v8z"/></svg>`);
    scan();
    expect(observedTargets()).toEqual([svgOf()]);
    expect(FakeResizeObserver.live.size).toBe(1);
    expect(charts.diagnostics()).toMatchObject({ chartWatched: 1, watchSubscriptions: 1 });
  });

  it('a size change asks for one pass over that chart; the first callback and an equal size do not', () => {
    const { charts, signals, scan, mount } = setup();
    mount(lineChartSvg(REDS));
    scan();
    // jsdom reports 0x0 for the observed size: an equal first report is not news
    fire(svgOf(), 0, 0);
    expect(signals).toEqual([]);
    fire(svgOf(), 320, 240);
    expect(signals).toEqual([svgOf()]);
    fire(svgOf(), 320, 240);
    expect(signals).toHaveLength(1);
    fire(svgOf(), 200, 240);
    expect(signals).toHaveLength(2);
    expect(charts.diagnostics().resizeSignals).toBe(2);
  });

  it('hatch and marker scale follow the size: a pass after a resize rebuilds the chart at the new scale', () => {
    let scale = 1;
    const { charts, signals, scan, mount } = setup('deuteranopia', {
      unitsPerPixel: () => scale,
    });
    mount(lineChartSvg(SIX));
    scan();
    const markerSize = () =>
      [...svgOf().querySelectorAll('marker')].map((m) => m.getAttribute('markerWidth')).join();
    const before = svgOf().querySelector('defs')?.innerHTML;
    expect(before).toBeTruthy();
    scale = 2;
    fire(svgOf(), 800, 600);
    expect(signals).toHaveLength(1);
    // the pipeline (M4) turns the signal into a pass over the chart
    charts.update([{ element: signals[0]!, scope: 'self' }]);
    expect(svgOf().querySelector('defs')?.innerHTML).not.toBe(before);
    expect(markerSize()).toBeDefined();
    // and a pass at the same scale writes nothing
    const stable = svgOf().querySelector('defs')?.innerHTML;
    charts.update([{ element: svgOf(), scope: 'self' }]);
    expect(svgOf().querySelector('defs')?.innerHTML).toBe(stable);
  });

  it('a removed chart is released: no retained target, no work', () => {
    const { charts, scan, mount } = setup();
    mount(lineChartSvg(REDS));
    scan();
    expect(observedTargets()).toHaveLength(1);
    svgOf().remove();
    charts.update([]);
    expect(observedTargets()).toEqual([]);
    expect(charts.diagnostics()).toMatchObject({ chartWatched: 0, chartOwners: 0 });
  });

  it('adaptCharts off, or an inactive profile: the observers are disconnected', () => {
    const { charts, scan, mount } = setup();
    mount(lineChartSvg(REDS));
    scan();
    expect(FakeResizeObserver.live.size).toBe(1);
    charts.begin({ ...SETTINGS, adaptCharts: false });
    expect(FakeResizeObserver.live.size).toBe(0);
    expect(charts.diagnostics().chartWatched).toBe(0);
    charts.begin({ ...SETTINGS, visionProfile: 'normal' });
    expect(FakeResizeObserver.live.size).toBe(0);
  });

  it('off and on again: one subscription per chart, never a duplicate', () => {
    const { charts, signals, scan, mount } = setup();
    mount(lineChartSvg(REDS));
    scan();
    for (let cycle = 0; cycle < 5; cycle += 1) {
      charts.end();
      expect(FakeResizeObserver.live.size).toBe(0);
      charts.begin(SETTINGS);
      scan();
      expect(FakeResizeObserver.live.size).toBe(1);
      expect(observedTargets()).toEqual([svgOf()]);
    }
    fire(svgOf(), 10, 10);
    expect(signals).toHaveLength(1);
  });

  it('a hidden chart is watched, so that showing it is noticed; a visible one forgets it', () => {
    const { charts, signals, scan, mount } = setup();
    mount(lineChartSvg(REDS));
    // nothing laid out: every mark loses its box
    for (const el of svgOf().querySelectorAll('[data-box]')) el.removeAttribute('data-box');
    scan();
    expect(charts.diagnostics().chartWatched).toBe(1);
    fire(svgOf(), 400, 300);
    expect(signals).toHaveLength(1);
  });

  it('a pass is never started by the layer itself: no signal after its own writes', () => {
    const { signals, scan, mount } = setup();
    mount(lineChartSvg(SIX));
    scan();
    scan();
    expect(nodes()).toBeGreaterThan(0);
    expect(signals).toEqual([]);
  });

  it('is bounded: more charts than the cap are not all watched', () => {
    const { charts, scan, mount } = setup();
    for (let i = 0; i < 140; i += 1) mount(lineChartSvg(REDS, { id: `c${i}` }));
    scan();
    expect(charts.diagnostics().chartWatched).toBeLessThanOrEqual(128);
    expect(observedTargets().length).toBeLessThanOrEqual(128);
  });

  it('without a bound invalidation nothing is watched', () => {
    const sheet = new StylesheetManager(document);
    const charts = new ChartController({
      doc: document,
      sheet,
      env: createChartEnvironment(document),
    });
    charts.begin(SETTINGS);
    document.body.insertAdjacentHTML('beforeend', lineChartSvg(REDS));
    charts.update([{ element: document.body, scope: 'subtree' }]);
    expect(FakeResizeObserver.live.size).toBe(0);
  });
});

describe('geometry bridge: d / points changes re-check the density policy', () => {
  async function flushMutations(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  it('one path that grows past the marker-vertex limit is signalled and replanned: no marker on it', async () => {
    const { env, charts, signals, scan, mount } = setup();
    mount(lineChartSvg(SIX));
    scan();
    const lines = [...svgOf().querySelectorAll('path.line')];
    const marker = (el: Element) => env.getStyle(el).getPropertyValue('marker-mid');
    const withMarker = lines.filter((line) => marker(line) !== 'none');
    expect(withMarker.length).toBeGreaterThanOrEqual(1);
    const grown = withMarker[0]!;
    setVertices(grown, 200);
    await flushMutations();
    expect(signals).toContain(svgOf());
    charts.update([{ element: svgOf(), scope: 'self' }]);
    expect(marker(grown)).toBe('none');
    expect(charts.diagnostics().geometrySignals).toBeGreaterThanOrEqual(1);
    // it is still told apart from the rest (a dash of its own), or the whole chart is refused: never half
    const info = charts.inspect(svgOf());
    if (info.status === 'supported') {
      expect(env.getStyle(grown).getPropertyValue('stroke-dasharray')).not.toBe('none');
    } else {
      expect(info).toMatchObject({ status: 'limited', reason: 'encoding-exhausted' });
      expect(nodes()).toBe(0);
    }
  });

  it('six series that all outgrow markers cannot be told apart by dashes alone: the chart is refused whole', async () => {
    const { charts, scan, mount } = setup();
    mount(lineChartSvg(SIX));
    scan();
    expect(nodes()).toBeGreaterThan(0);
    for (const line of svgOf().querySelectorAll('path.line')) setVertices(line, 200);
    await flushMutations();
    charts.update([{ element: svgOf(), scope: 'self' }]);
    expect(charts.inspect(svgOf())).toMatchObject({
      status: 'limited',
      reason: 'encoding-exhausted',
    });
    expect(nodes()).toBe(0);
    expect(document.querySelectorAll('[data-coloradapt-chart-mark]')).toHaveLength(0);
    expect(document.getElementById('coloradapt-stylesheet')).toBeNull();
  });

  it('and back: 200 -> 20 vertices is replanned deterministically (markers may return)', async () => {
    const { charts, signals, scan, mount } = setup();
    mount(lineChartSvg(SIX));
    for (const line of svgOf().querySelectorAll('path.line')) setVertices(line, 200);
    scan();
    const stylesheet = () => document.getElementById('coloradapt-stylesheet')?.textContent ?? '';
    const dense = stylesheet();
    expect(dense).not.toContain('marker-mid');
    for (const line of svgOf().querySelectorAll('path.line')) setVertices(line, 20);
    await flushMutations();
    expect(signals.length).toBeGreaterThanOrEqual(1);
    charts.update([{ element: svgOf(), scope: 'self' }]);
    const sparse = stylesheet();
    // the same input always gives the same output
    for (const line of svgOf().querySelectorAll('path.line')) setVertices(line, 200);
    charts.update([{ element: svgOf(), scope: 'self' }]);
    for (const line of svgOf().querySelectorAll('path.line')) setVertices(line, 20);
    charts.update([{ element: svgOf(), scope: 'self' }]);
    expect(stylesheet()).toBe(sparse);
  });

  it('a polyline whose points grow is signalled', async () => {
    const { signals, scan, mount } = setup();
    mount(
      lineChartSvg(REDS).replace(
        /<path class="line line-0"([^>]*) d="([^"]*)"/,
        (_m, rest: string) =>
          `<polyline class="line line-0"${rest} points="60,100 100,120 140,90 180,130 220,80 260,110"`,
      ),
    );
    scan();
    svgOf()
      .querySelector('polyline')!
      .setAttribute(
        'points',
        Array.from({ length: 90 }, (_, k) => `${60 + k},${100 + (k % 9)}`).join(' '),
      );
    await flushMutations();
    expect(signals).toContain(svgOf());
  });

  it('coordinates that move without changing the structure are not signalled (a transition, a refresh)', async () => {
    const { charts, signals, scan, mount } = setup();
    mount(lineChartSvg(REDS));
    scan();
    const line = svgOf().querySelector('path.line')!;
    for (let frame = 0; frame < 20; frame += 1) {
      line.setAttribute(
        'd',
        `M60 ${100 + frame} L100 ${120 + frame} L140 ${90 + frame} L180 ${130 - frame} L220 ${80 + frame} L260 ${110 + frame}`,
      );
    }
    await flushMutations();
    expect(signals).toEqual([]);
    expect(charts.diagnostics().geometrySignals).toBe(0);
  });

  it('a d change outside a watched chart is not observed', async () => {
    const { signals, scan, mount } = setup();
    mount(
      `${lineChartSvg(REDS)}<svg id="logo" viewBox="0 0 10 10"><path id="p" d="M0 0 L5 5"/></svg>`,
    );
    scan();
    document.getElementById('p')!.setAttribute('d', 'M0 0 L5 5 L9 0 L2 2');
    await flushMutations();
    expect(signals).toEqual([]);
  });
});
