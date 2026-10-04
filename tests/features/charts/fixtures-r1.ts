/**
 * M7.R1 fixtures for the jsdom engine (./engine.ts): SVGs that are NOT supported charts but look
 * enough like one to be traps, and variants of real charts (labels, widths, legends in odd places).
 * Boxes come from `data-box="x,y,w,h"` (pixels in the SVG), as everywhere in this engine.
 */
const box = (x: number, y: number, w: number, h: number) => `data-box="${x},${y},${w},${h}"`;
const open = (id: string, w = 400, h = 300) =>
  `<svg id="${id}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`;

const PALETTE = ['#e63946', '#457b9d', '#2a9d8f', '#e9c46a', '#f4a261', '#264653'];

/** Boxes with text joined by elbow connectors, tidy as an org chart. */
export function orgChartSvg(id = 'org'): string {
  const node = (x: number, y: number, label: string, fill: string) =>
    `<rect fill="${fill}" x="${x}" y="${y}" width="70" height="30" ${box(x, y, 70, 30)}></rect><text x="${x + 6}" y="${y + 20}" fill="#fff" ${box(x + 6, y + 10, 50, 12)}>${label}</text>`;
  const link = (d: string, b: string) => `<path fill="none" stroke="#666" d="${d}" ${b}></path>`;
  return `${open(id)}${node(165, 10, 'CEO', PALETTE[0]!)}${node(30, 100, 'CTO', PALETTE[1]!)}${node(165, 100, 'CFO', PALETTE[2]!)}${node(300, 100, 'COO', PALETTE[3]!)}${node(10, 200, 'Dev', PALETTE[4]!)}${node(90, 200, 'Ops', PALETTE[5]!)}${node(250, 200, 'HR', PALETTE[1]!)}${node(330, 200, 'Legal', PALETTE[2]!)}${link('M200 40 V70 H65 V100', box(65, 40, 135, 60))}${link('M200 40 V100', box(200, 40, 0, 60))}${link('M200 40 V70 H335 V100', box(200, 40, 135, 60))}${link('M65 130 V160 H45 V200', box(45, 130, 20, 70))}${link('M65 130 V160 H125 V200', box(65, 130, 60, 70))}${link('M335 130 V160 H285 V200', box(285, 130, 50, 70))}${link('M335 130 V160 H365 V200', box(335, 130, 30, 70))}</svg>`;
}

/** Network diagram: circles joined by straight lines, labelled. */
export function networkSvg(id = 'network'): string {
  const points: Array<[number, number]> = [
    [60, 60],
    [160, 40],
    [260, 90],
    [340, 50],
    [90, 170],
    [200, 150],
    [300, 210],
    [140, 250],
    [250, 270],
  ];
  const edges = [
    [0, 1],
    [1, 2],
    [2, 3],
    [0, 4],
    [1, 5],
    [2, 5],
    [5, 6],
    [4, 7],
    [5, 8],
    [6, 8],
  ]
    .map(([a, b]) => {
      const [x1, y1] = points[a!]!;
      const [x2, y2] = points[b!]!;
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#999" ${box(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1))}></line>`;
    })
    .join('');
  const nodes = points
    .map(
      ([x, y], i) =>
        `<circle cx="${x}" cy="${y}" r="10" fill="${PALETTE[i % PALETTE.length]}" ${box(x - 10, y - 10, 20, 20)}></circle><text x="${x - 4}" y="${y + 24}" fill="#333" ${box(x - 6, y + 14, 14, 10)}>n${i}</text>`,
    )
    .join('');
  return `${open(id)}${edges}${nodes}</svg>`;
}

/** Flow diagram: rounded boxes, diamonds and arrows. */
export function flowSvg(id = 'flow'): string {
  const step = (x: number, y: number, fill: string, label: string) =>
    `<rect rx="6" fill="${fill}" x="${x}" y="${y}" width="80" height="34" ${box(x, y, 80, 34)}></rect><text x="${x + 8}" y="${y + 22}" fill="#fff" ${box(x + 8, y + 12, 60, 12)}>${label}</text>`;
  const arrow = (x1: number, y1: number, x2: number, y2: number) =>
    `<path fill="none" stroke="#444" stroke-width="1.5" d="M${x1} ${y1} L${x2} ${y2}" ${box(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1))}></path>`;
  return `${open(id)}${step(20, 20, PALETTE[1]!, 'Start')}${step(160, 20, PALETTE[2]!, 'Validate')}${step(300, 20, PALETTE[3]!, 'Store')}${step(160, 120, PALETTE[4]!, 'Retry')}${step(300, 120, PALETTE[0]!, 'Fail')}${step(160, 220, PALETTE[5]!, 'Done')}${arrow(100, 37, 160, 37)}${arrow(240, 37, 300, 37)}${arrow(200, 54, 200, 120)}${arrow(240, 137, 300, 137)}${arrow(200, 154, 200, 220)}</svg>`;
}

/** Timeline: one axis, dated events as dots in a row (collinear) with labels. */
export function timelineSvg(id = 'timeline'): string {
  const events = [2014, 2016, 2017, 2019, 2020, 2022, 2023, 2024];
  const dots = events
    .map((year, i) => {
      const x = 30 + i * 46;
      return `<circle cx="${x}" cy="150" r="6" fill="${PALETTE[i % PALETTE.length]}" ${box(x - 6, 144, 12, 12)}></circle><text x="${x - 12}" y="180" fill="#333" ${box(x - 12, 170, 24, 10)}>${year}</text>`;
    })
    .join('');
  return `${open(id)}<path d="M20 150 H380" stroke="#888" fill="none" ${box(20, 150, 360, 0)}></path>${dots}</svg>`;
}

/** Calendar: a 7-column grid of day cells with day numbers (a heatmap-like grid). */
export function calendarSvg(id = 'calendar'): string {
  let cells = '';
  for (let day = 0; day < 35; day += 1) {
    const x = 20 + (day % 7) * 52;
    const y = 30 + Math.floor(day / 7) * 46;
    const fill = day % 9 === 0 ? '#ffd6d6' : day % 5 === 0 ? '#d6ffd6' : '#f3f3f3';
    cells += `<rect fill="${fill}" stroke="#ccc" x="${x}" y="${y}" width="48" height="42" ${box(x, y, 48, 42)}></rect><text x="${x + 4}" y="${y + 14}" fill="#333" ${box(x + 4, y + 4, 12, 10)}>${day + 1}</text>`;
  }
  return `${open(id)}${cells}</svg>`;
}

/** A ring of progress: a track circle and a dashed value circle. */
export function progressRingSvg(id = 'ring'): string {
  return `${open(id, 100, 100)}<circle cx="50" cy="50" r="40" fill="none" stroke="#e5e5e5" stroke-width="8" ${box(10, 10, 80, 80)}></circle><circle cx="50" cy="50" r="40" fill="none" stroke="#2ca02c" stroke-width="8" stroke-dasharray="180 251" ${box(10, 10, 80, 80)}></circle><text x="38" y="56" fill="#333" ${box(38, 46, 24, 12)}>72%</text></svg>`;
}

/** A decorative donut-like icon: ring segments of several colors, no legend, no axes. */
export function donutIconSvg(id = 'donut-icon'): string {
  const seg = (fill: string, d: string) =>
    `<path fill="${fill}" d="${d}" ${box(8, 8, 84, 84)}></path>`;
  return `${open(id, 100, 100)}${seg('#e63946', 'M50 8 A42 42 0 0 1 92 50 L74 50 A24 24 0 0 0 50 26 Z')}${seg('#457b9d', 'M92 50 A42 42 0 0 1 50 92 L50 74 A24 24 0 0 0 74 50 Z')}${seg('#2a9d8f', 'M50 92 A42 42 0 0 1 8 50 L26 50 A24 24 0 0 0 50 74 Z')}</svg>`;
}

/** An infographic: big colored shapes, icons and labels, a few numbers; no axes. */
export function infographicSvg(id = 'infographic'): string {
  const bar = (x: number, h: number, fill: string, label: string) =>
    `<rect fill="${fill}" x="${x}" y="${200 - h}" width="60" height="${h}" rx="8" ${box(x, 200 - h, 60, h)}></rect><text x="${x + 10}" y="${200 - h - 8}" fill="#222" ${box(x + 10, 200 - h - 18, 40, 12)}>${label}</text>`;
  return `${open(id)}${bar(20, 120, PALETTE[0]!, '42%')}${bar(120, 80, PALETTE[1]!, '28%')}${bar(220, 60, PALETTE[2]!, '21%')}<circle cx="350" cy="60" r="30" fill="${PALETTE[3]}" ${box(320, 30, 60, 60)}></circle><text x="30" y="280" fill="#555" ${box(30, 270, 150, 12)}>Share of respondents</text></svg>`;
}

/** A sparkline: a single tiny line with a dot, inline decoration (no axes, no legend). */
export function sparklineSvg(id = 'spark'): string {
  return `${open(id, 100, 24)}<path d="M0 18 L12 12 L24 15 L36 6 L48 10 L60 4 L72 8 L84 3 L100 5" fill="none" stroke="#2ca02c" stroke-width="1.5" ${box(0, 3, 100, 15)}></path><circle cx="100" cy="5" r="2" fill="#d62728" ${box(98, 3, 4, 4)}></circle></svg>`;
}

/** A dashboard KPI icon: three bars and an arrow, a few colored shapes. */
export function kpiIconSvg(id = 'kpi'): string {
  return `${open(id, 32, 32)}<rect x="4" y="16" width="6" height="12" fill="#2ca02c" ${box(4, 16, 6, 12)}></rect><rect x="13" y="10" width="6" height="18" fill="#d62728" ${box(13, 10, 6, 18)}></rect><rect x="22" y="4" width="6" height="24" fill="#1f77b4" ${box(22, 4, 6, 24)}></rect></svg>`;
}

/** A pie-shaped logo with a hint in its class name (still no legend). */
export function hintedLogoSvg(id = 'brand-chart-logo'): string {
  const wedge = (fill: string, d: string) =>
    `<path fill="${fill}" d="${d}" ${box(10, 10, 80, 80)}></path>`;
  return `<svg id="${id}" class="chart-logo" viewBox="0 0 100 100" width="96" height="96">${wedge('#e63946', 'M50 50 L90 50 A40 40 0 0 1 50 90 Z')}${wedge('#457b9d', 'M50 50 L50 90 A40 40 0 0 1 10 50 Z')}${wedge('#ffb703', 'M50 50 L10 50 A40 40 0 0 1 50 10 Z')}</svg>`;
}

/** Spinner: arcs of a gray ramp. */
export function spinnerSvg(id = 'spinner'): string {
  const arc = (fill: string, d: string) =>
    `<path fill="${fill}" d="${d}" ${box(8, 8, 84, 84)}></path>`;
  return `${open(id, 100, 100)}${arc('#bbbbbb', 'M50 8 A42 42 0 0 1 92 50 L74 50 A24 24 0 0 0 50 26 Z')}${arc('#999999', 'M92 50 A42 42 0 0 1 50 92 L50 74 A24 24 0 0 0 74 50 Z')}${arc('#777777', 'M50 92 A42 42 0 0 1 8 50 L26 50 A24 24 0 0 0 50 74 Z')}${arc('#555555', 'M8 50 A42 42 0 0 1 50 8 L50 26 A24 24 0 0 0 26 50 Z')}</svg>`;
}

/** Avatar ring: a single ring around a face. */
export function avatarRingSvg(id = 'avatar'): string {
  return `${open(id, 100, 100)}<circle cx="50" cy="50" r="44" fill="none" stroke="#e63946" stroke-width="5" ${box(6, 6, 88, 88)}></circle><circle cx="50" cy="40" r="14" fill="#f4a261" ${box(36, 26, 28, 28)}></circle><path d="M24 84 A26 26 0 0 1 76 84 Z" fill="#457b9d" ${box(24, 58, 52, 26)}></path></svg>`;
}

/** A gauge: a half-circle track and a colored value arc. */
export function gaugeSvg(id = 'gauge'): string {
  return `${open(id, 200, 120)}<path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="#e5e5e5" stroke-width="14" ${box(20, 20, 160, 80)}></path><path d="M20 100 A80 80 0 0 1 120 28" fill="none" stroke="#2ca02c" stroke-width="14" ${box(20, 20, 100, 80)}></path><text x="90" y="95" fill="#333" ${box(90, 85, 24, 14)}>62</text></svg>`;
}

// ------------------------------------------------------------- variants of real charts

/** Line chart whose series carry different stroke widths (width is the page's own channel). */
export function withWidths(svg: string, widths: readonly number[]): string {
  return svg.replace(
    /<path class="line line-(\d)"([^>]*?) stroke-width="2"/g,
    (_m, i: string, rest: string) =>
      `<path class="line line-${i}"${rest} stroke-width="${widths[Number(i)] ?? 2}"`,
  );
}

/** Direct labels next to bars: a text in the series' own color above the series' first bar (barChartSvg geometry). */
export function barDirectLabels(svg: string, colors: readonly string[]): string {
  return svg.replace(
    '</svg>',
    colors
      .map((color, i) => {
        const x = 60 + i * 22;
        const y = 260 - (60 + ((i * 23) % 90)) - 14;
        return `<text x="${x}" y="${y + 10}" fill="${color}" ${box(x, y, 18, 10)}>B${i}</text>`;
      })
      .join('') + '</svg>',
  );
}

/** Slice labels in the slices' own colors (a label per slice, all inside the shared circle). */
export function sliceLabels(svg: string, colors: readonly string[]): string {
  return svg.replace(
    '</svg>',
    colors
      .map(
        (color, i) =>
          `<text x="${120 + i * 14}" y="${120 + i * 12}" fill="${color}" ${box(118 + i * 14, 110 + i * 12, 12, 10)}>${i + 1}</text>`,
      )
      .join('') + '</svg>',
  );
}

// ----------------------------------------------------------------- HTML legends

export const sw = (color: string, box = '0,0,12,12', extra = '') =>
  `<span style="background-color:${color}" data-box="${box}" ${extra}></span>`;

/** Legend markup variants: each is evidence of an HTML legend that M7 cannot keep in step (red and green series). */
export const HTML_LEGENDS: ReadonlyArray<readonly [string, string]> = [
  [
    'colored div + text',
    `<div class="items"><div><div style="background-color:#d62728" data-box="0,0,12,12"></div> Red</div><div><div style="background-color:#2ca02c" data-box="0,20,12,12"></div> Green</div></div>`,
  ],
  ['span swatch + label', `<p>${sw('#d62728')} Red</p><p>${sw('#2ca02c', '0,20,12,12')} Green</p>`],
  [
    'distinct gray swatches (a grayscale legend is still a legend)',
    `<p>${sw('#888888')} a</p><p>${sw('#bbbbbb', '0,20,12,12')} b</p>`,
  ],
  [
    'inline SVG swatch + text',
    `<div><svg data-box="0,0,12,12" width="12" height="12"><rect width="12" height="12" fill="#d62728"/></svg> Red</div><div><svg data-box="0,20,12,12" width="12" height="12"><rect width="12" height="12" fill="#2ca02c"/></svg> Green</div>`,
  ],
  [
    'CSS ::before swatch',
    `<ul><li data-before="content:'';background-color:#d62728;width:10px;height:10px">Red</li><li data-before="content:'';background-color:#2ca02c;width:10px;height:10px">Green</li></ul>`,
  ],
  [
    'CSS ::after swatch',
    `<ul><li data-after="content:'';background-color:#d62728;width:10px;height:10px">Red</li><li data-after="content:'';background-color:#2ca02c;width:10px;height:10px">Green</li></ul>`,
  ],
  [
    'CSS border-left color',
    `<ul><li style="border-left-width:4px;border-left-style:solid;border-left-color:#d62728" data-box="0,0,80,16">Red</li><li style="border-left-width:4px;border-left-style:solid;border-left-color:#2ca02c" data-box="0,20,80,16">Green</li></ul>`,
  ],
  [
    'background-color bullet',
    `<ul><li><i style="background-color:#d62728" data-box="0,0,8,8"></i> Red</li><li><i style="background-color:#2ca02c" data-box="0,20,8,8"></i> Green</li></ul>`,
  ],
  [
    'thin colored rule',
    `<p><i style="background-color:#d62728" data-box="0,0,24,3"></i> Red</p><p><i style="background-color:#2ca02c" data-box="0,20,24,3"></i> Green</p>`,
  ],
  [
    'glyph bullet',
    `<p><span style="color:#d62728">●</span> Red</p><p><span style="color:#2ca02c">●</span> Green</p>`,
  ],
  [
    'text colored like the series (no swatch at all)',
    `<p><span style="color:#d62728">Red</span> <span style="color:#2ca02c">Green</span></p>`,
  ],
  ['colored emoji squares', `<p><span>🟥</span> Red</p><p><span>🟩</span> Green</p>`],
  [
    'nested legend item',
    `<ul><li><span><b><i style="background-color:#d62728" data-box="0,0,10,10"></i></b></span> Red</li><li><span><b><i style="background-color:#2ca02c" data-box="0,20,10,10"></i></b></span> Green</li></ul>`,
  ],
  [
    'button legend item (toggle)',
    `<div><button aria-pressed="true"><i style="background-color:#d62728" data-box="0,0,10,10"></i>Red</button><button aria-pressed="true"><i style="background-color:#2ca02c" data-box="0,20,10,10"></i>Green</button></div>`,
  ],
  [
    'toggle buttons carrying the series color',
    `<div><button aria-pressed="true" style="background-color:#d62728">Red</button><button aria-pressed="true" style="background-color:#2ca02c">Green</button></div>`,
  ],
  [
    'checkbox legend item',
    `<div><label><input type="checkbox" style="accent-color:#d62728"> Red</label><label><input type="checkbox" style="accent-color:#2ca02c"> Green</label></div>`,
  ],
  [
    'controls that name the chart',
    `<div><button aria-controls="chart">Red</button><button aria-controls="chart">Green</button></div>`,
  ],
  ['named by class: legend', `<div class="chart-legend"><span>Red</span><span>Green</span></div>`],
  [
    'named by class: series key',
    `<div class="series-key"><span>Red</span><span>Green</span></div>`,
  ],
  ['named by id: legend', `<div id="legendBox"><span>Red</span><span>Green</span></div>`],
  [
    'named by role + label',
    `<div role="list" aria-label="Chart legend"><b>Red</b><b>Green</b></div>`,
  ],
];

// ------------------------------------------------------------------------ more charts

/** A donut: ring segments (two arcs each) in one circle, with a complete box legend. */
export function donutChartSvg(colors: readonly string[], id = 'chart'): string {
  const slices = colors
    .map(
      (color, i) =>
        `<path class="slice" fill="${color}" d="M150 50 A100 100 0 0 1 ${200 + i} ${60 + i} L${180 + i} ${80 + i} A70 70 0 0 0 150 80 Z" ${box(50, 50, 200, 200)}></path>`,
    )
    .join('');
  const legend = `<g class="legend">${colors
    .map((color, i) => {
      const y = 10 + i * 16;
      return `<g class="legend-item"><rect class="swatch" x="300" y="${y}" width="10" height="10" fill="${color}" ${box(300, y, 10, 10)}></rect><text x="325" y="${y + 10}" fill="#222" ${box(325, y, 50, 10)}>Part ${i + 1}</text></g>`;
    })
    .join('')}</g>`;
  return `<svg id="${id}" class="donut" viewBox="0 0 400 300" width="400" height="300">${slices}${legend}</svg>`;
}

/** Shapes (marks and texts) the chart layer counts in one `<svg>`. */
export function countShapes(svg: string): number {
  return (svg.match(/<(?:path|rect|circle|ellipse|line|polyline|polygon|text)\b/g) ?? []).length;
}

/** Elements the chart layer walks inside one `<svg>` (every descendant). */
export function countElements(svg: string): number {
  return (svg.match(/<[a-z][\w-]*/gi) ?? []).length - 1;
}

/** Pads `svg` with hairline gridlines (neutral lines are axes/grid, never data) until it holds `total` shapes. */
export function padShapes(svg: string, total: number): string {
  const missing = total - countShapes(svg);
  if (missing < 0) throw new Error(`already ${countShapes(svg)} shapes`);
  const grid = Array.from(
    { length: missing },
    (_, i) =>
      `<line x1="40" y1="${30 + (i % 200)}" x2="380" y2="${30 + (i % 200)}" stroke="#eeeeee" data-box="40,${30 + (i % 200)},340,0"></line>`,
  ).join('');
  return svg.replace('</svg>', `${grid}</svg>`);
}

/** Pads `svg` with empty groups until it holds `total` elements. */
export function padElements(svg: string, total: number): string {
  const missing = total - countElements(svg);
  if (missing < 0) throw new Error(`already ${countElements(svg)} elements`);
  return svg.replace('</svg>', `${'<g></g>'.repeat(missing)}</svg>`);
}

/** The SVG legend made interactive: each entry is a focusable button that toggles its series. */
export function interactiveLegend(svg: string): string {
  return svg.replace(
    /<g class="legend-item">/g,
    (_m, offset: number) =>
      `<g class="legend-item" role="button" tabindex="0" aria-pressed="true" aria-label="Toggle series ${offset}">`,
  );
}

/** A line of `vertices` points per path instead of the fixture's six. */
export function withVertices(svg: string, vertices: number, only?: number): string {
  const d = Array.from(
    { length: vertices },
    (_, k) => `${k === 0 ? 'M' : 'L'}${60 + k} ${100 + ((k * 7) % 40)}`,
  ).join(' ');
  return svg.replace(
    /<path class="line line-(\d)"([^>]*?) d="[^"]*"/g,
    (m, i: string, rest: string) =>
      only === undefined || Number(i) === only ? `<path class="line line-${i}"${rest} d="${d}"` : m,
  );
}

/** `extra` more paths of the last series' color (one series of many marks: marker instances add up). */
export function withExtraPaths(
  svg: string,
  color: string,
  extra: number,
  vertices: number,
): string {
  const d = Array.from(
    { length: vertices },
    (_, k) => `${k === 0 ? 'M' : 'L'}${60 + k} ${100 + ((k * 7) % 40)}`,
  ).join(' ');
  const more = Array.from(
    { length: extra },
    (_, i) =>
      `<path class="line line-extra" fill="none" stroke="${color}" stroke-width="2" d="${d}" ${box(60, 80 + i, 200, 60)}></path>`,
  ).join('');
  return svg.replace('<g class="legend">', `${more}<g class="legend">`);
}

// ---------------------------------------------------------------------------- canvas

export const CANVASES: ReadonlyArray<readonly [string, string, 'canvas-chart' | 'canvas-unknown']> =
  [
    [
      'Chart.js-like canvas',
      '<div class="chart-container"><canvas id="myChart" class="chartjs-render-monitor" width="400" height="300" aria-label="Revenue chart"></canvas></div>',
      'canvas-chart',
    ],
    [
      'game canvas',
      '<canvas id="game" class="game-canvas" width="640" height="480"></canvas>',
      'canvas-unknown',
    ],
    [
      'signature pad',
      '<div class="signature-pad"><canvas id="sig" width="400" height="150"></canvas></div>',
      'canvas-unknown',
    ],
    [
      'drawing app',
      '<canvas id="paint" class="drawing-board" width="800" height="600"></canvas>',
      'canvas-unknown',
    ],
    [
      'video-processing canvas',
      '<video id="v"></video><canvas id="frame" class="video-filter" width="640" height="360"></canvas>',
      'canvas-unknown',
    ],
    [
      'map canvas',
      '<div class="map"><canvas id="map" class="map-canvas" width="500" height="400"></canvas></div>',
      'canvas-unknown',
    ],
    [
      'canvas with a generic class "chart" (detected, still not adapted)',
      '<canvas id="c" class="chart" width="300" height="200"></canvas>',
      'canvas-chart',
    ],
  ];
