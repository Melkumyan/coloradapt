/**
 * Static pages for the M7.R1 real-browser suites: charts as markup strings (served with
 * `server.serve`), HTML legend variants with real CSS, output shaped like common chart libraries'
 * (nested groups, clip paths, generated classes, separate legend groups), and non-chart traps.
 * No library is imported anywhere: production code is library-agnostic and so are these fixtures.
 */
export const pageHtml = (body: string, css = '', script = ''): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>R1</title><style>body{margin:16px;background:#fff;font:14px sans-serif;color:#222}${css}</style></head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;

const W = 480;
const H = 320;
const X0 = 50;
const X1 = 440;
const Y0 = 20;
const Y1 = 270;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

function axes(): string {
  let out = `<g class="axis x-axis" fill="none" transform="translate(0,${Y1})"><path class="domain" stroke="#666" d="M${X0} 0 H${X1}"></path>`;
  for (let i = 0; i <= 5; i += 1) {
    const x = X0 + (i * (X1 - X0)) / 5;
    out += `<g class="tick" transform="translate(${x},0)"><line stroke="#666" y2="6"></line><text fill="#222" y="18" text-anchor="middle" font-size="10">${i * 10}</text></g>`;
  }
  out += '</g>';
  out += `<g class="axis y-axis" fill="none" transform="translate(${X0},0)"><path class="domain" stroke="#666" d="M0 ${Y0} V${Y1}"></path>`;
  for (let i = 0; i <= 4; i += 1) {
    const y = Y1 - (i * (Y1 - Y0)) / 4;
    out += `<g class="tick" transform="translate(0,${y})"><line stroke="#666" x2="-6"></line><text fill="#222" x="-9" dy="0.32em" text-anchor="end" font-size="10">${i * 25}</text></g>`;
  }
  return `${out}</g>`;
}

export interface LineOptions {
  readonly id: string;
  readonly colors: readonly string[];
  readonly names?: readonly string[];
  readonly points?: number;
  readonly legend?: 'svg' | 'none';
  readonly keys?: boolean;
  readonly responsive?: boolean;
  readonly dashes?: ReadonlyArray<string | null>;
  readonly widths?: readonly number[];
  readonly klass?: string;
}

/** A D3-style line chart: axes, one path per series, `g.legend > g.legend-item > (line, text)`. */
export function lineSvg(o: LineOptions): string {
  const n = o.points ?? 8;
  const rand = lcg(7);
  const names = o.names ?? o.colors.map((_, i) => `Series ${i + 1}`);
  const paths = o.colors
    .map((color, i) => {
      const d = Array.from({ length: n }, (_, k) => {
        const v = 30 + i * 6 + 40 * Math.sin(k / 1.3 + i) + rand() * 10;
        return `${k === 0 ? 'M' : 'L'}${(X0 + (k * (X1 - X0 - 60)) / (n - 1)).toFixed(1)} ${(Y1 - v * 2).toFixed(1)}`;
      }).join(' ');
      const key = o.keys ? ` data-series="${names[i]}"` : '';
      const dash = o.dashes?.[i] ? ` stroke-dasharray="${o.dashes[i]}"` : '';
      return `<path class="series series-${i}"${key} fill="none" stroke="${color}" stroke-width="${o.widths?.[i] ?? 2}"${dash} d="${d}"></path>`;
    })
    .join('');
  const legend =
    o.legend === 'svg'
      ? `<g class="legend" transform="translate(330,8)">${o.colors
          .map((color, i) => {
            const key = o.keys ? ` data-series="${names[i]}"` : '';
            const dash = o.dashes?.[i] ? ` stroke-dasharray="${o.dashes[i]}"` : '';
            return `<g class="legend-item" transform="translate(0,${i * 16})"><line class="swatch"${key} x1="0" x2="20" y1="5" y2="5" stroke="${color}" stroke-width="2"${dash}></line><text x="26" y="10" fill="#222" font-size="11">${names[i]}</text></g>`;
          })
          .join('')}</g>`
      : '';
  const size = o.responsive ? 'style="width:100%;height:auto"' : `width="${W}" height="${H}"`;
  return `<svg id="${o.id}" class="${o.klass ?? 'chart line-chart'}" ${size} viewBox="0 0 ${W} ${H}">${axes()}<g class="plot">${paths}</g>${legend}</svg>`;
}

export interface BarOptions {
  readonly id: string;
  readonly colors: readonly string[];
  readonly legend?: 'svg' | 'none';
  readonly responsive?: boolean;
  readonly categories?: number;
}

export function barSvg(o: BarOptions): string {
  const cats = o.categories ?? 4;
  const k = o.colors.length;
  const rand = lcg(11);
  const groupW = (X1 - X0 - 40) / cats;
  const barW = Math.min(30, (groupW - 12) / k);
  let bars = '';
  for (let c = 0; c < cats; c += 1) {
    o.colors.forEach((color, i) => {
      const h = 40 + rand() * 150;
      bars += `<rect class="bar bar-${i}" fill="${color}" x="${X0 + 20 + c * groupW + i * barW}" y="${Y1 - h}" width="${barW - 2}" height="${h}"></rect>`;
    });
  }
  const legend =
    o.legend === 'svg'
      ? `<g class="legend" transform="translate(330,8)">${o.colors
          .map(
            (color, i) =>
              `<g class="legend-item" transform="translate(0,${i * 16})"><rect class="swatch" width="10" height="10" fill="${color}"></rect><text x="16" y="10" fill="#222" font-size="11">Bar ${i + 1}</text></g>`,
          )
          .join('')}</g>`
      : '';
  const size = o.responsive ? 'style="width:100%;height:auto"' : `width="${W}" height="${H}"`;
  return `<svg id="${o.id}" class="chart bar-chart" ${size} viewBox="0 0 ${W} ${H}">${axes()}<g class="plot">${bars}</g>${legend}</svg>`;
}

/** Slices as wedges (one arc each) around (240,150), with a box legend. */
export function pieSvg(
  id: string,
  colors: readonly string[],
  legend: boolean | number = true,
  klass = 'chart pie-chart',
): string {
  const total = colors.length;
  const cx = 150;
  const cy = 150;
  const r = 110;
  let angle = -Math.PI / 2;
  const slices = colors
    .map((color, i) => {
      const next = angle + (2 * Math.PI) / total;
      const large = next - angle > Math.PI ? 1 : 0;
      const d = `M${cx} ${cy} L${(cx + r * Math.cos(angle)).toFixed(2)} ${(cy + r * Math.sin(angle)).toFixed(2)} A${r} ${r} 0 ${large} 1 ${(cx + r * Math.cos(next)).toFixed(2)} ${(cy + r * Math.sin(next)).toFixed(2)} Z`;
      angle = next;
      return `<path class="slice slice-${i}" fill="${color}" d="${d}"></path>`;
    })
    .join('');
  const shown = legend === true ? total : legend === false ? 0 : legend;
  const key = colors
    .slice(0, shown)
    .map(
      (color, i) =>
        `<g class="legend-item" transform="translate(0,${i * 16})"><rect class="swatch" width="10" height="10" fill="${color}"></rect><text x="16" y="10" fill="#222" font-size="11">Slice ${i + 1}</text></g>`,
    )
    .join('');
  return `<svg id="${id}" class="${klass}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><g class="plot">${slices}</g>${shown > 0 ? `<g class="legend" transform="translate(330,8)">${key}</g>` : ''}</svg>`;
}

export function scatterSvg(id: string, colors: readonly string[], legend = true): string {
  const rand = lcg(5);
  const points = colors
    .map((color, i) =>
      Array.from({ length: 12 }, () => {
        const cx = X0 + 20 + rand() * (X1 - X0 - 40);
        const cy = Y0 + 10 + rand() * (Y1 - Y0 - 20);
        return `<circle class="dot dot-${i}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="${color}"></circle>`;
      }).join(''),
    )
    .join('');
  const key = legend
    ? `<g class="legend" transform="translate(330,8)">${colors
        .map(
          (color, i) =>
            `<g class="legend-item" transform="translate(0,${i * 16})"><circle class="swatch" cx="5" cy="5" r="5" fill="${color}"></circle><text x="16" y="10" fill="#222" font-size="11">Group ${i + 1}</text></g>`,
        )
        .join('')}</g>`
    : '';
  return `<svg id="${id}" class="chart scatter" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${axes()}<g class="plot">${points}</g>${key}</svg>`;
}

// ------------------------------------------------------------------ HTML legend variants

export const RED = '#d62728';
export const GREEN = '#2ca02c';

export interface LegendVariant {
  readonly name: string;
  readonly css: string;
  readonly html: string;
}

/** Real-CSS HTML legends for a red/green chart. Each one is evidence M7 must not ignore. */
export const LEGEND_VARIANTS: readonly LegendVariant[] = [
  {
    name: 'colored div + text',
    css: '.sq{width:12px;height:12px;display:inline-block;margin-right:4px}',
    html: `<div class="lg"><div><span class="sq" style="background:${RED}"></span>Red</div><div><span class="sq" style="background:${GREEN}"></span>Green</div></div>`,
  },
  {
    name: 'span swatch + label',
    css: '.sw{display:inline-block;width:10px;height:10px;margin:0 4px 0 12px}',
    html: `<p><span class="sw" style="background:${RED}"></span>Red<span class="sw" style="background:${GREEN}"></span>Green</p>`,
  },
  {
    name: 'inline SVG swatch + text',
    css: '',
    html: `<p><svg width="12" height="12"><rect width="12" height="12" fill="${RED}"/></svg> Red <svg width="12" height="12"><rect width="12" height="12" fill="${GREEN}"/></svg> Green</p>`,
  },
  {
    name: 'CSS ::before swatch',
    css: '.pb{list-style:none;padding:0;display:flex;gap:12px}.pb li::before{content:"";display:inline-block;width:10px;height:10px;margin-right:4px;background:var(--c)}',
    html: `<ul class="pb"><li style="--c:${RED}">Red</li><li style="--c:${GREEN}">Green</li></ul>`,
  },
  {
    name: 'CSS ::after swatch',
    css: '.pa{list-style:none;padding:0;display:flex;gap:12px}.pa li::after{content:"";display:inline-block;width:10px;height:10px;margin-left:4px;background:var(--c)}',
    html: `<ul class="pa"><li style="--c:${RED}">Red</li><li style="--c:${GREEN}">Green</li></ul>`,
  },
  {
    name: 'CSS border-left color',
    css: '.bl{list-style:none;padding:0}.bl li{border-left:4px solid var(--c);padding-left:6px;margin:2px 0}',
    html: `<ul class="bl"><li style="--c:${RED}">Red</li><li style="--c:${GREEN}">Green</li></ul>`,
  },
  {
    name: 'CSS background-color bullet',
    css: '.bu{list-style:none;padding:0}.bu i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}',
    html: `<ul class="bu"><li><i style="background:${RED}"></i>Red</li><li><i style="background:${GREEN}"></i>Green</li></ul>`,
  },
  {
    name: 'glyph bullet',
    css: '',
    html: `<p><span style="color:${RED}">●</span> Red &nbsp; <span style="color:${GREEN}">●</span> Green</p>`,
  },
  {
    name: 'colored text only (no swatch)',
    css: '',
    html: `<p><span style="color:${RED}">Red</span> &nbsp; <span style="color:${GREEN}">Green</span></p>`,
  },
  {
    name: 'nested legend item',
    css: '.sq2{display:inline-block;width:10px;height:10px;margin-right:4px}',
    html: `<ul><li><span><b><i class="sq2" style="background:${RED}"></i></b></span>Red</li><li><span><b><i class="sq2" style="background:${GREEN}"></i></b></span>Green</li></ul>`,
  },
  {
    name: 'button legend item',
    css: '.btn i{display:inline-block;width:10px;height:10px;margin-right:4px}',
    html: `<div class="btns"><button class="btn" aria-pressed="true"><i style="background:${RED}"></i>Red</button><button class="btn" aria-pressed="true"><i style="background:${GREEN}"></i>Green</button></div>`,
  },
  {
    name: 'checkbox legend item',
    css: '',
    html: `<div><label><input type="checkbox" checked style="accent-color:${RED}"> Red</label> <label><input type="checkbox" checked style="accent-color:${GREEN}"> Green</label></div>`,
  },
  {
    name: 'interactive legend (role=button items with a dot)',
    css: '.il span.dot{display:inline-block;width:10px;height:10px;margin-right:4px}',
    html: `<div class="il"><div role="button" tabindex="0" aria-pressed="true"><span class="dot" style="background:${RED}"></span>Red</div><div role="button" tabindex="0" aria-pressed="true"><span class="dot" style="background:${GREEN}"></span>Green</div></div>`,
  },
  {
    name: 'named legend, items without any color',
    css: '',
    html: `<ul class="chart-legend"><li>Red</li><li>Green</li></ul>`,
  },
  {
    name: 'toggle buttons that name the chart',
    css: '',
    html: `<div><button aria-controls="chart">Red</button><button aria-controls="chart">Green</button></div>`,
  },
];

// ------------------------------------------------------------ library-shaped output

/** D3 v7 conventions: a margin `g`, `g.x.axis` / `g.y.axis` with `path.domain` and `g.tick`, `path.line`. */
export function d3Like(id = 'chart'): string {
  const colors = ['#d62728', '#2ca02c', '#ff7f0e'];
  const series = colors
    .map((color, i) => {
      const d = Array.from(
        { length: 12 },
        (_, k) => `${k === 0 ? 'M' : 'L'}${k * 32},${150 - 40 * Math.sin(k / 2 + i) - i * 12}`,
      ).join('');
      return `<path class="line" fill="none" stroke="${color}" stroke-width="1.5" d="${d}"></path>`;
    })
    .join('');
  const ticks = (n: number, axis: 'x' | 'y') =>
    Array.from({ length: n }, (_, i) => {
      const pos = axis === 'x' ? `translate(${i * 70 + 0.5},0)` : `translate(0,${i * 50 + 0.5})`;
      return `<g class="tick" opacity="1" transform="${pos}"><line stroke="currentColor" ${axis === 'x' ? 'y2="6"' : 'x2="-6"'}></line><text fill="currentColor" ${axis === 'x' ? 'y="9" dy="0.71em"' : 'x="-9" dy="0.32em"'}>${i * 10}</text></g>`;
    }).join('');
  return `<svg id="${id}" width="480" height="320" viewBox="0 0 480 320" style="max-width:100%;height:auto"><g transform="translate(50,20)"><g class="x axis" transform="translate(0,250)" fill="none" font-size="10" font-family="sans-serif" text-anchor="middle"><path class="domain" stroke="currentColor" d="M0.5,6V0.5H350.5V6"></path>${ticks(6, 'x')}</g><g class="y axis" fill="none" font-size="10" font-family="sans-serif" text-anchor="end"><path class="domain" stroke="currentColor" d="M-6,250.5H0.5V0.5H-6"></path>${ticks(6, 'y')}</g><g class="lines">${series}</g><g class="legend" transform="translate(300,0)">${colors
    .map(
      (color, i) =>
        `<g class="legend-item" transform="translate(0,${i * 16})"><rect width="10" height="10" fill="${color}"></rect><text x="16" y="9" font-size="11">Series ${i + 1}</text></g>`,
    )
    .join('')}</g></g></svg>`;
}

/** Recharts conventions: a wrapper, a `recharts-surface` SVG with a clipPath and layers, an HTML legend wrapper. */
export function rechartsLike(id = 'chart'): string {
  const colors = ['#d62728', '#2ca02c', '#ff7f0e'];
  const curves = colors
    .map((color, i) => {
      const d = Array.from(
        { length: 10 },
        (_, k) => `${k === 0 ? 'M' : 'L'}${65 + k * 48},${180 - 60 * Math.sin(k / 2 + i) - i * 14}`,
      ).join('');
      return `<g class="recharts-layer recharts-line"><path stroke="${color}" stroke-width="1" fill="none" width="430" height="260" class="recharts-curve recharts-line-curve" d="${d}"></path></g>`;
    })
    .join('');
  const grid = [0, 1, 2, 3, 4]
    .map(
      (i) =>
        `<line stroke="#ccc" fill="none" x1="65" y1="${25 + i * 60}" x2="495" y2="${25 + i * 60}"></line>`,
    )
    .join('');
  const ticks = [0, 1, 2, 3, 4, 5]
    .map(
      (i) =>
        `<g class="recharts-layer recharts-cartesian-axis-tick"><line stroke="#666" fill="none" x1="${65 + i * 86}" y1="265" x2="${65 + i * 86}" y2="271"></line><text x="${65 + i * 86}" y="283" text-anchor="middle" fill="#666" class="recharts-text recharts-cartesian-axis-tick-value"><tspan>P${i}</tspan></text></g>`,
    )
    .join('');
  const legend = colors
    .map(
      (color, i) =>
        `<li class="recharts-legend-item legend-item-${i}" style="display:inline-block;margin-right:10px"><svg class="recharts-surface" width="14" height="14" viewBox="0 0 32 32" style="display:inline-block;vertical-align:middle;margin-right:4px"><path stroke="none" fill="${color}" d="M0,4h32v24h-32z" class="recharts-legend-icon"></path></svg><span class="recharts-legend-item-text" style="color:${color}">Series ${i + 1}</span></li>`,
    )
    .join('');
  return `<div class="recharts-wrapper" style="position:relative;width:500px;height:330px"><svg id="${id}" class="recharts-surface" width="500" height="300" viewBox="0 0 500 300"><defs><clipPath id="recharts1-clip"><rect x="65" y="5" height="260" width="430"></rect></clipPath></defs><g class="recharts-layer recharts-cartesian-grid">${grid}</g><g class="recharts-layer recharts-cartesian-axis recharts-xAxis"><line class="recharts-cartesian-axis-line" stroke="#666" fill="none" x1="65" y1="265" x2="495" y2="265"></line>${ticks}</g><g clip-path="url(#recharts1-clip)">${curves}</g></svg><div class="recharts-legend-wrapper" style="position:absolute;width:500px;height:auto;left:5px;bottom:5px"><ul class="recharts-default-legend" style="padding:0;margin:0;text-align:center;list-style:none">${legend}</ul></div></div>`;
}

/** Highcharts conventions: `highcharts-root`, background rects, grid paths, series groups with a tracker line, a legend whose text precedes its swatch. */
export function highchartsLike(id = 'chart'): string {
  const colors = ['#7cb5ec', '#434348', '#90ed7d'];
  const series = colors
    .map((color, i) => {
      const d = Array.from(
        { length: 9 },
        (_, k) =>
          `${k === 0 ? 'M' : 'L'} ${30 + k * 46} ${160 - 55 * Math.sin(k / 2 + i) - i * 10}`,
      ).join(' ');
      return `<g class="highcharts-series highcharts-series-${i} highcharts-line-series" transform="translate(50,20)" clip-path="url(#highcharts-clip-0)"><path fill="none" d="${d}" class="highcharts-graph" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path><path fill="none" d="${d}" class="highcharts-tracker-line" stroke-linecap="round" stroke-linejoin="round" stroke="rgba(192,192,192,0.0001)" stroke-width="22"></path></g>`;
    })
    .join('');
  const grid = [1, 2, 3, 4, 5]
    .map(
      (i) =>
        `<path fill="none" class="highcharts-grid-line" d="M 50 ${20 + i * 45} L 450 ${20 + i * 45}" stroke="#e6e6e6" stroke-width="1"></path>`,
    )
    .join('');
  const ticks = [0, 1, 2, 3, 4, 5, 6, 7, 8]
    .map(
      (k) =>
        `<text x="${80 + k * 46}" y="290" text-anchor="middle" fill="#666666" font-size="11px">${k + 1}</text>`,
    )
    .join('');
  const legend = colors
    .map(
      (color, i) =>
        `<g class="highcharts-legend-item highcharts-line-series highcharts-series-${i}" transform="translate(${8 + i * 90},3)"><text x="21" y="15" fill="#333333" text-anchor="start">Series ${i + 1}</text><path fill="none" d="M 0 11 L 16 11" class="highcharts-graph" stroke="${color}" stroke-width="2"></path></g>`,
    )
    .join('');
  return `<div class="highcharts-container"><svg id="${id}" class="highcharts-root" width="480" height="340" viewBox="0 0 480 340"><defs><clipPath id="highcharts-clip-0"><rect x="0" y="0" width="400" height="230"></rect></clipPath></defs><rect fill="#ffffff" class="highcharts-background" x="0" y="0" width="480" height="340"></rect><rect fill="none" class="highcharts-plot-background" x="50" y="20" width="400" height="250"></rect><g class="highcharts-grid highcharts-yaxis-grid">${grid}</g><path fill="none" class="highcharts-axis-line" stroke="#ccd6eb" stroke-width="1" d="M 50 270.5 L 450 270.5"></path><g class="highcharts-series-group">${series}</g>${ticks}<g class="highcharts-legend" transform="translate(100,300)"><rect fill="none" class="highcharts-legend-box" x="0" y="0" width="280" height="30"></rect><g>${legend}</g></g></svg></div>`;
}

/** Plotly (SVG mode) conventions: layers, inline styles, a trace group, a legend whose text precedes its layers. */
export function plotlyLike(id = 'chart'): string {
  const colors = ['rgb(31, 119, 180)', 'rgb(255, 127, 14)', 'rgb(44, 160, 44)'];
  const traces = colors
    .map((color, i) => {
      const d = Array.from(
        { length: 10 },
        (_, k) => `${k === 0 ? 'M' : 'L'}${k * 40},${180 - 70 * Math.sin(k / 2 + i) - i * 12}`,
      ).join('');
      const points = Array.from(
        { length: 10 },
        (_, k) =>
          `<path class="point" transform="translate(${k * 40},${(180 - 70 * Math.sin(k / 2 + i) - i * 12).toFixed(1)})" d="M3,0A3,3 0 1,1 0,-3A3,3 0 0,1 3,0Z" style="opacity: 1; stroke-width: 0px; fill: ${color}; fill-opacity: 1;"></path>`,
      ).join('');
      return `<g class="trace scatter trace${i}" style="stroke-miterlimit: 2; opacity: 1;"><g class="lines"><path class="js-line" d="${d}" style="vector-effect: non-scaling-stroke; fill: none; stroke: ${color}; stroke-opacity: 1; stroke-width: 2px; opacity: 1;"></path></g><g class="points">${points}</g></g>`;
    })
    .join('');
  const ticks = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    .map(
      (k) =>
        `<g class="xtick"><text text-anchor="middle" x="0" y="278" transform="translate(${80 + k * 40},0)" style="font-family: sans-serif; font-size: 12px; fill: rgb(68, 68, 68); fill-opacity: 1;">${k}</text></g>`,
    )
    .join('');
  const legend = colors
    .map(
      (color, i) =>
        `<g class="traces" transform="translate(14,${14 + i * 19})"><text class="legendtext" text-anchor="start" x="40" y="4" style="font-family: sans-serif; font-size: 12px; fill: rgb(68, 68, 68);">trace ${i}</text><g class="layers"><g class="legendlines"><path class="js-line" d="M5,-2h30" style="fill: none; stroke: ${color}; stroke-opacity: 1; stroke-width: 2px;"></path></g></g><rect class="legendtoggle" x="0" y="-9.5" width="100" height="19" style="fill: rgb(0, 0, 0); fill-opacity: 0;"></rect></g>`,
    )
    .join('');
  return `<div class="js-plotly-plot"><div class="plot-container plotly"><div class="svg-container" style="position:relative;width:520px;height:340px"><svg id="${id}" class="main-svg" width="520" height="340" style="background:white"><g class="cartesianlayer"><g class="subplot xy"><g class="gridlayer"><g class="x"><path class="xgrid crisp" d="M80,20v250" style="stroke: rgb(238, 238, 238); stroke-width: 1px;"></path></g></g><g class="plot" transform="translate(80,20)">${traces}</g><g class="xaxislayer-above">${ticks}</g></g></g><g class="infolayer"><g class="legend" transform="translate(380,20)"><rect class="bg" width="120" height="70" style="fill: rgb(255,255,255); fill-opacity: 0;"></rect><g class="scrollbox"><g class="groups">${legend}</g></g></g></g></svg></div></div></div>`;
}

/** A simple dashboard SVG chart (custom, hand-rolled): a card with a title, a line chart inside, and a legend group of its own. */
export function customDashboard(id = 'chart'): string {
  return `<section class="card"><h3>Weekly revenue</h3>${lineSvg({ id, colors: ['#d62728', '#2ca02c'], names: ['Online', 'Retail'], legend: 'svg', keys: true, klass: 'chart sales-chart' })}</section>`;
}

// ------------------------------------------------------------------------- non-charts

export const NON_CHARTS: ReadonlyArray<readonly [string, string]> = [
  [
    'logo (ring of colored arcs)',
    `<svg id="chart" viewBox="0 0 100 100" width="96" height="96"><path fill="#e63946" d="M50 50 L90 50 A40 40 0 0 1 50 90 Z"/><path fill="#457b9d" d="M50 50 L50 90 A40 40 0 0 1 10 50 Z"/><path fill="#1d3557" d="M50 50 L10 50 A40 40 0 0 1 50 10 Z"/><path fill="#ffb703" d="M50 50 L50 10 A40 40 0 0 1 90 50 Z"/></svg>`,
  ],
  [
    'illustration (shapes, no axes)',
    `<svg id="chart" viewBox="0 0 300 200" width="300" height="200"><rect x="10" y="120" width="280" height="70" fill="#a8dadc"/><circle cx="60" cy="50" r="30" fill="#ffb703"/><path d="M120 120 L170 40 L220 120 Z" fill="#2a9d8f"/><path d="M200 120 L240 70 L280 120 Z" fill="#457b9d"/><rect x="30" y="140" width="40" height="30" fill="#e63946"/><circle cx="150" cy="150" r="10" fill="#f1faee"/></svg>`,
  ],
  [
    'network diagram',
    `<svg id="chart" viewBox="0 0 400 300" width="400" height="300">${[
      [60, 60],
      [160, 40],
      [260, 90],
      [340, 50],
      [90, 170],
      [200, 150],
      [300, 210],
      [140, 250],
      [250, 270],
    ]
      .map(
        ([x, y], i, all) =>
          `${i > 0 ? `<line x1="${all[i - 1]![0]}" y1="${all[i - 1]![1]}" x2="${x}" y2="${y}" stroke="#999"/>` : ''}<circle cx="${x}" cy="${y}" r="10" fill="${['#e63946', '#457b9d', '#2a9d8f', '#e9c46a', '#f4a261', '#264653'][i % 6]}"/><text x="${x! - 4}" y="${y! + 24}" fill="#333">n${i}</text>`,
      )
      .join('')}</svg>`,
  ],
  [
    'org chart',
    `<svg id="chart" viewBox="0 0 400 260" width="400" height="260">${[
      [165, 10, 'CEO'],
      [30, 100, 'CTO'],
      [165, 100, 'CFO'],
      [300, 100, 'COO'],
      [10, 200, 'Dev'],
      [90, 200, 'Ops'],
      [250, 200, 'HR'],
      [330, 200, 'Legal'],
    ]
      .map(
        ([x, y, t], i) =>
          `<rect x="${x}" y="${y}" width="70" height="30" fill="${['#e63946', '#457b9d', '#2a9d8f', '#e9c46a', '#f4a261', '#264653'][i % 6]}"/><text x="${Number(x) + 6}" y="${Number(y) + 20}" fill="#fff">${t}</text>`,
      )
      .join(
        '',
      )}<path fill="none" stroke="#666" d="M200 40 V70 H65 V100 M200 40 V100 M200 40 V70 H335 V100"/></svg>`,
  ],
  [
    'flow diagram',
    `<svg id="chart" viewBox="0 0 400 260" width="400" height="260">${[
      [20, 20, 'Start'],
      [160, 20, 'Validate'],
      [300, 20, 'Store'],
      [160, 120, 'Retry'],
      [300, 120, 'Fail'],
      [160, 220, 'Done'],
    ]
      .map(
        ([x, y, t], i) =>
          `<rect rx="6" x="${x}" y="${y}" width="80" height="34" fill="${['#457b9d', '#2a9d8f', '#e9c46a', '#f4a261', '#e63946', '#264653'][i]}"/><text x="${Number(x) + 8}" y="${Number(y) + 22}" fill="#fff">${t}</text>`,
      )
      .join(
        '',
      )}<path fill="none" stroke="#444" d="M100 37 L160 37 M240 37 L300 37 M200 54 L200 120 M240 137 L300 137 M200 154 L200 220"/></svg>`,
  ],
  [
    'timeline (a row of colored dots)',
    `<svg id="chart" viewBox="0 0 400 260" width="400" height="260"><path d="M20 150 H380" stroke="#888" fill="none"/>${[2014, 2016, 2017, 2019, 2020, 2022, 2023, 2024].map((year, i) => `<circle cx="${30 + i * 46}" cy="150" r="6" fill="${['#e63946', '#457b9d', '#2a9d8f', '#e9c46a', '#f4a261', '#264653'][i % 6]}"/><text x="${18 + i * 46}" y="180" fill="#333">${year}</text>`).join('')}</svg>`,
  ],
  [
    'map-like illustration',
    `<svg id="chart" viewBox="0 0 400 300" width="400" height="300">${Array.from({ length: 36 }, (_, i) => `<path fill="${['#e63946', '#f1faee', '#a8dadc', '#457b9d', '#1d3557', '#ffb703', '#fb8500'][i % 7]}" stroke="#fff" d="M${(i % 6) * 60 + 20} ${Math.floor(i / 6) * 40 + 14} l44 3 l4 30 l-44 4 z"/>`).join('')}<text x="30" y="30">North</text><text x="300" y="250">South</text></svg>`,
  ],
  [
    'calendar grid',
    `<svg id="chart" viewBox="0 0 400 260" width="400" height="260">${Array.from({ length: 35 }, (_, d) => `<rect x="${20 + (d % 7) * 52}" y="${30 + Math.floor(d / 7) * 46}" width="48" height="42" fill="${d % 9 === 0 ? '#ffd6d6' : d % 5 === 0 ? '#d6ffd6' : '#f3f3f3'}" stroke="#ccc"/><text x="${24 + (d % 7) * 52}" y="${44 + Math.floor(d / 7) * 46}" fill="#333">${d + 1}</text>`).join('')}</svg>`,
  ],
  [
    'progress ring',
    `<svg id="chart" viewBox="0 0 100 100" width="100" height="100"><circle cx="50" cy="50" r="40" fill="none" stroke="#e5e5e5" stroke-width="8"/><circle cx="50" cy="50" r="40" fill="none" stroke="#2ca02c" stroke-width="8" stroke-dasharray="180 251"/><text x="38" y="56" fill="#333">72%</text></svg>`,
  ],
  [
    'donut-like decorative icon',
    `<svg id="chart" viewBox="0 0 100 100" width="100" height="100"><path fill="#e63946" d="M50 8 A42 42 0 0 1 92 50 L74 50 A24 24 0 0 0 50 26 Z"/><path fill="#457b9d" d="M92 50 A42 42 0 0 1 50 92 L50 74 A24 24 0 0 0 74 50 Z"/><path fill="#2a9d8f" d="M50 92 A42 42 0 0 1 8 50 L26 50 A24 24 0 0 0 50 74 Z"/></svg>`,
  ],
  [
    'infographic (big shapes, percentages)',
    `<svg id="chart" viewBox="0 0 400 300" width="400" height="300">${[
      [20, 120, '#e63946', '42%'],
      [120, 80, '#457b9d', '28%'],
      [220, 60, '#2a9d8f', '21%'],
    ]
      .map(
        ([x, h, c, l]) =>
          `<rect rx="8" x="${x}" y="${200 - Number(h)}" width="60" height="${h}" fill="${c}"/><text x="${Number(x) + 10}" y="${192 - Number(h)}" fill="#222">${l}</text>`,
      )
      .join(
        '',
      )}<circle cx="350" cy="60" r="30" fill="#e9c46a"/><text x="30" y="280" fill="#555">Share of respondents</text></svg>`,
  ],
  [
    'sparkline decoration',
    `<svg id="chart" viewBox="0 0 100 24" width="100" height="24"><path d="M0 18 L12 12 L24 15 L36 6 L48 10 L60 4 L72 8 L84 3 L100 5" fill="none" stroke="#2ca02c" stroke-width="1.5"/><circle cx="100" cy="5" r="2" fill="#d62728"/></svg>`,
  ],
  [
    'dashboard KPI icon',
    `<svg id="chart" viewBox="0 0 32 32" width="32" height="32"><rect x="4" y="16" width="6" height="12" fill="#2ca02c"/><rect x="13" y="10" width="6" height="18" fill="#d62728"/><rect x="22" y="4" width="6" height="24" fill="#1f77b4"/></svg>`,
  ],
  [
    'gauge',
    `<svg id="chart" viewBox="0 0 200 120" width="200" height="120"><path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="#e5e5e5" stroke-width="14"/><path d="M20 100 A80 80 0 0 1 120 28" fill="none" stroke="#2ca02c" stroke-width="14"/><text x="90" y="95" fill="#333">62</text></svg>`,
  ],
  [
    'spinner',
    `<svg id="chart" viewBox="0 0 100 100" width="100" height="100">${['#bbbbbb', '#999999', '#777777', '#555555'].map((c, i) => `<path fill="${c}" d="${['M50 8 A42 42 0 0 1 92 50 L74 50 A24 24 0 0 0 50 26 Z', 'M92 50 A42 42 0 0 1 50 92 L50 74 A24 24 0 0 0 74 50 Z', 'M50 92 A42 42 0 0 1 8 50 L26 50 A24 24 0 0 0 50 74 Z', 'M8 50 A42 42 0 0 1 50 8 L50 26 A24 24 0 0 0 26 50 Z'][i]}"/>`).join('')}</svg>`,
  ],
  [
    'avatar ring',
    `<svg id="chart" viewBox="0 0 100 100" width="100" height="100"><circle cx="50" cy="50" r="44" fill="none" stroke="#e63946" stroke-width="5"/><circle cx="50" cy="40" r="14" fill="#f4a261"/><path d="M24 84 A26 26 0 0 1 76 84 Z" fill="#457b9d"/></svg>`,
  ],
];
