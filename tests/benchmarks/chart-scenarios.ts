import type { VisionProfile } from '@domain/models';
import {
  areaChartSvg,
  barChartSvg,
  diagramSvg,
  heatmapSvg,
  iconSvg,
  lineChartSvg,
  logoSvg,
  mapSvg,
  pieChartSvg,
  scatterChartSvg,
  stackedBarSvg,
  type createChartEnvironment,
} from '../features/charts/engine';
import type { ChartController } from '@features/charts';

export type Outcome = 'adapted' | 'untouched' | 'refused' | 'not-claimed';

/** What a scenario's steps can do to the page after the first pass. */
export interface ScenarioContext {
  readonly charts: ChartController;
  readonly env: ReturnType<typeof createChartEnvironment> & { scale: number };
  /** The (first) chart's `<svg>`, looked up fresh. */
  svg(): SVGSVGElement;
  /** Runs the chart layer over the whole body (what M4 hands it after a change). */
  update(): void;
  /** Runs it over one element only (a resize, a legend change...). */
  updateAt(element: Element, anchors?: Element[]): void;
}

export interface Scenario {
  readonly name: string;
  readonly category: string;
  readonly profile: VisionProfile;
  readonly markup: string;
  readonly expect: Outcome;
  /** Reason the chart layer must give when it refuses. */
  readonly reason?: string;
  /** Changes the page after the first pass (dynamic and responsive scenarios); the verdict is on the final state. */
  readonly steps?: (ctx: ScenarioContext) => void;
  /** Extra assertions on the final state. */
  readonly verify?: (ctx: ScenarioContext) => void;
}

export const RED_GREEN = ['#d62728', '#2ca02c'];
export const CONFUSABLE = ['#d62728', '#2ca02c', '#ff7f0e'];
export const REDS = ['#d62728', '#d82a29', '#da2c2b'];
export const SIX = [...REDS, '#dc2e2d', '#de302f', '#e03231'];
export const OKABE = ['#0072b2', '#d55e00', '#f0e442', '#009e73'];
export const TAB10 = [
  '#1f77b4',
  '#ff7f0e',
  '#2ca02c',
  '#d62728',
  '#9467bd',
  '#8c564b',
  '#e377c2',
  '#7f7f7f',
  '#bcbd22',
  '#17becf',
];

/** A line chart whose `marker-mid` the page already set (an existing non-color channel). */
export const withMarkers = (svg: string) =>
  svg
    .replace(
      /<path class="line line-(\d)"/g,
      (_m, i: string) => `<path marker-mid="url(#pm${i})" class="line line-${i}"`,
    )
    .replace('</svg>', '<defs><marker id="pm0"/><marker id="pm1"/><marker id="pm2"/></defs></svg>');
/** Bars the page already filled with its own patterns. */
export const withPatterns = (svg: string) =>
  svg
    .replace(
      /<rect class="bar" fill="[^"]*"/g,
      (_m, offset: number) => `<rect class="bar" fill="url(#hatch${offset % 2})"`,
    )
    .replace('</svg>', '<defs><pattern id="hatch0"/><pattern id="hatch1"/></defs></svg>');
export const dense = (colors: readonly string[], points: number) => {
  const svg = lineChartSvg(colors);
  const d = Array.from(
    { length: points },
    (_, k) => `${k === 0 ? 'M' : 'L'}${60 + k * 2} ${100 + ((k * 7) % 40)}`,
  ).join(' ');
  return svg.replace(/d="M60 [^"]*"/g, `d="${d}"`);
};
export const directLabels = (svg: string, colors: readonly string[]) =>
  svg.replace(
    '</svg>',
    colors
      .map(
        (color, i) =>
          `<text x="268" y="${110 + i * 10}" fill="${color}" data-box="262,${100 + i * 10},30,10">S${i}</text>`,
      )
      .join('') + '</svg>',
  );
const gradientLine = (svg: string) =>
  svg
    .replace('stroke="#2ca02c"', 'stroke="url(#g)"')
    .replace(
      '</svg>',
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#2ca02c"/></linearGradient></defs></svg>',
    );
const withFilter = (svg: string) => svg.replace('<svg ', '<svg style="filter: blur(0.5px)" ');
const htmlLegend = (svg: string) =>
  `<div class="chart-box">${svg}<ul class="legend"><li>Red</li><li>Green</li></ul></div>`;
const duplicateColorLegend = () =>
  lineChartSvg(['#d62728', '#d62728', '#2ca02c'], { dashes: [null, '4 2', null] });

export const BASE_SCENARIOS: readonly Scenario[] = [
  // ------------------------------------------------------------ safe adaptation
  {
    name: 'line, red/green, deuteranopia',
    category: 'safe adaptation',
    profile: 'deuteranopia',
    markup: lineChartSvg(RED_GREEN),
    expect: 'adapted',
  },
  {
    name: 'line, red/green/orange, deuteranopia',
    category: 'safe adaptation',
    profile: 'deuteranopia',
    markup: lineChartSvg(CONFUSABLE),
    expect: 'adapted',
  },
  {
    name: 'line, red/green/orange, protanopia',
    category: 'multi-profile',
    profile: 'protanopia',
    markup: lineChartSvg(CONFUSABLE),
    expect: 'adapted',
  },
  {
    name: 'line, blue/green, tritanopia',
    category: 'multi-profile',
    profile: 'tritanopia',
    markup: lineChartSvg(['#1f77b4', '#2ca02c']),
    expect: 'adapted',
  },
  {
    name: 'line, six reds, deuteranopia (markers)',
    category: 'safe adaptation',
    profile: 'deuteranopia',
    markup: lineChartSvg(SIX),
    expect: 'adapted',
  },
  {
    name: 'line, six reds, protanopia',
    category: 'multi-profile',
    profile: 'protanopia',
    markup: lineChartSvg(SIX),
    expect: 'adapted',
  },
  {
    name: 'line, six reds, tritanopia',
    category: 'multi-profile',
    profile: 'tritanopia',
    markup: lineChartSvg(SIX),
    expect: 'adapted',
  },
  {
    name: 'line, no legend',
    category: 'safe adaptation',
    profile: 'deuteranopia',
    markup: lineChartSvg(REDS, { legend: false }),
    expect: 'adapted',
  },
  {
    name: 'line, red/green, deuteranomaly (MODEL_ASSUMPTION)',
    category: 'multi-profile',
    profile: 'deuteranomaly',
    markup: lineChartSvg(REDS),
    expect: 'adapted',
  },
  {
    name: 'line, reds, tritanomaly (APPROXIMATION)',
    category: 'multi-profile',
    profile: 'tritanomaly',
    markup: lineChartSvg(REDS),
    expect: 'adapted',
  },
  {
    name: 'line, reds, achromatopsia (APPROXIMATION)',
    category: 'multi-profile',
    profile: 'achromatopsia',
    markup: lineChartSvg(REDS),
    expect: 'adapted',
  },
  {
    name: 'bars, red/green',
    category: 'safe adaptation',
    profile: 'deuteranopia',
    markup: barChartSvg(RED_GREEN),
    expect: 'adapted',
  },
  {
    name: 'bars, tab10 x4, deuteranopia',
    category: 'safe adaptation',
    profile: 'deuteranopia',
    markup: barChartSvg([TAB10[2]!, TAB10[3]!, TAB10[1]!, TAB10[5]!]),
    expect: 'adapted',
  },
  {
    name: 'scatter, red/green',
    category: 'safe adaptation',
    profile: 'deuteranopia',
    markup: scatterChartSvg(RED_GREEN),
    expect: 'adapted',
  },
  {
    name: 'scatter, three reds, protanopia',
    category: 'multi-profile',
    profile: 'protanopia',
    markup: scatterChartSvg(REDS),
    expect: 'adapted',
  },
  {
    name: 'pie, three reds with legend',
    category: 'safe adaptation',
    profile: 'deuteranopia',
    markup: pieChartSvg(REDS),
    expect: 'adapted',
  },
  // ------------------------------------------------------ already distinguishable
  {
    name: 'line, dashes already drawn',
    category: 'already distinguishable',
    profile: 'deuteranopia',
    markup: lineChartSvg(REDS, { dashes: [null, '6 3', '2 2'] }),
    expect: 'untouched',
  },
  {
    name: 'line, markers already drawn',
    category: 'already distinguishable',
    profile: 'deuteranopia',
    markup: withMarkers(lineChartSvg(REDS, { legend: false })),
    expect: 'untouched',
  },
  {
    name: 'line, direct labels',
    category: 'already distinguishable',
    profile: 'deuteranopia',
    markup: directLabels(lineChartSvg(REDS, { legend: false }), REDS),
    expect: 'untouched',
  },
  {
    name: 'bars, patterns already drawn',
    category: 'already distinguishable',
    profile: 'deuteranopia',
    markup: withPatterns(barChartSvg(RED_GREEN, { legend: false })),
    expect: 'untouched',
  },
  {
    name: 'line, Okabe-Ito, deuteranopia',
    category: 'already distinguishable',
    profile: 'deuteranopia',
    markup: lineChartSvg(OKABE.slice(0, 3)),
    expect: 'untouched',
  },
  {
    name: 'line, Okabe-Ito, protanopia',
    category: 'already distinguishable',
    profile: 'protanopia',
    markup: lineChartSvg(OKABE.slice(0, 3)),
    expect: 'untouched',
  },
  {
    name: 'bars, Okabe-Ito',
    category: 'already distinguishable',
    profile: 'deuteranopia',
    markup: barChartSvg(OKABE.slice(0, 3)),
    expect: 'untouched',
  },
  // ------------------------------------------------------------ legend / limits
  {
    name: 'line, legend with duplicate colors',
    category: 'ambiguous legend',
    profile: 'deuteranopia',
    markup: duplicateColorLegend(),
    expect: 'refused',
    reason: 'legend-ambiguous',
  },
  {
    name: 'line, HTML legend',
    category: 'ambiguous legend',
    profile: 'deuteranopia',
    markup: htmlLegend(lineChartSvg(RED_GREEN, { legend: false })),
    expect: 'refused',
    reason: 'html-legend',
  },
  {
    name: 'pie-like arcs without a legend (a gauge or a logo)',
    category: 'false positive: SVG',
    profile: 'deuteranopia',
    markup: pieChartSvg(REDS, { legend: false }),
    expect: 'not-claimed',
  },
  {
    name: 'line, 13 series',
    category: 'unsupported complex chart',
    profile: 'deuteranopia',
    markup: lineChartSvg(
      Array.from({ length: 13 }, (_, i) => `#${(200 + i).toString(16)}2828`),
      { legend: false },
    ),
    expect: 'refused',
    reason: 'too-many-series',
  },
  // ------------------------------------------------------- unsupported complex
  {
    name: 'heatmap',
    category: 'unsupported complex chart',
    profile: 'deuteranopia',
    markup: heatmapSvg(),
    expect: 'refused',
    reason: 'heatmap-sequential',
  },
  {
    name: 'area',
    category: 'unsupported complex chart',
    profile: 'deuteranopia',
    markup: areaChartSvg(RED_GREEN),
    expect: 'refused',
    reason: 'type-not-adapted',
  },
  {
    name: 'bars in a single-hue ramp (sequential)',
    category: 'unsupported complex chart',
    profile: 'deuteranopia',
    markup: barChartSvg(['#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#3182bd']),
    expect: 'refused',
    reason: 'sequential-palette',
  },
  {
    name: 'stacked bars',
    category: 'unsupported complex chart',
    profile: 'deuteranopia',
    markup: stackedBarSvg(REDS),
    expect: 'refused',
    reason: 'type-not-adapted',
  },
  {
    name: 'line with a gradient stroke',
    category: 'unsupported complex chart',
    profile: 'deuteranopia',
    markup: gradientLine(lineChartSvg(RED_GREEN, { legend: false })),
    expect: 'refused',
    reason: 'paint-gradient',
  },
  {
    name: 'line filtered by CSS',
    category: 'unsupported complex chart',
    profile: 'deuteranopia',
    markup: withFilter(lineChartSvg(RED_GREEN)),
    expect: 'refused',
    reason: 'filter',
  },
  // ------------------------------------------------------------ dense
  {
    name: '10 series x 100 points, tab10, deuteranopia',
    category: 'dense series',
    profile: 'deuteranopia',
    markup: dense(TAB10, 100),
    expect: 'adapted',
  },
  {
    name: '6 reds x 400 points (dash styles run out)',
    category: 'dense series',
    profile: 'deuteranopia',
    markup: dense(SIX, 400),
    expect: 'refused',
    reason: 'encoding-exhausted',
  },
  // ----------------------------------------------------- false-positive checks
  {
    name: 'logo (ring of colored arcs)',
    category: 'false positive: SVG',
    profile: 'deuteranopia',
    markup: logoSvg(),
    expect: 'not-claimed',
  },
  {
    name: 'map-like illustration',
    category: 'false positive: SVG',
    profile: 'deuteranopia',
    markup: mapSvg(),
    expect: 'not-claimed',
  },
  {
    name: 'diagram without a data series',
    category: 'false positive: SVG',
    profile: 'deuteranopia',
    markup: diagramSvg(),
    expect: 'not-claimed',
  },
  {
    name: 'complex icon',
    category: 'false positive: SVG',
    profile: 'deuteranopia',
    markup: iconSvg(),
    expect: 'not-claimed',
  },
];
