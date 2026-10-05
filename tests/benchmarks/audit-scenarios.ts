import type { UserSettings, VisionProfile } from '@domain/models';
import {
  areaChartSvg,
  barChartSvg,
  heatmapSvg,
  lineChartSvg,
  pieChartSvg,
  scatterChartSvg,
  stackedBarSvg,
} from '../features/charts/engine';
import { donutChartSvg } from '../features/charts/fixtures-r1';

/**
 * Developer-audit benchmark scenarios (docs/DEVELOPER_AUDIT.md, "Benchmark"). Each scenario is a
 * page plus what a careful reviewer would say about it: the issues a deterministic rule must report,
 * the things that need a human (manual review), the analysis limitations, and nothing else.
 *
 * Expectations are written from first principles wherever an independent oracle exists (the WCAG
 * contrast formula is re-implemented below, not imported); the color-vision pairs are
 * regression-locked against the M2 simulation (whose own scientific status is PARTIAL and is
 * reviewed separately: the audit consumes it, it does not validate it).
 */

export type AuditGroup = 'M1' | 'M2' | 'M5' | 'M6' | 'M7' | 'M8' | 'false-positive' | 'R1';

/** `rule@#id` for an element with that id. */
export type Expected = string;

export interface ImageSpec {
  readonly id: string;
  readonly src: string;
  readonly attrs?: Record<string, string>;
  readonly width?: number;
  readonly height?: number;
  /** Wrap the image in this element (a link or a button), with its id as `<id>-wrap`. */
  readonly wrapper?: 'a' | 'button';
}

export interface AuditScenario {
  readonly id: string;
  readonly group: AuditGroup;
  readonly label: string;
  readonly markup: string;
  readonly css?: string;
  readonly kind?: 'html' | 'svg' | 'chart' | 'image';
  readonly profile?: VisionProfile;
  readonly scope?: 'auto' | 'active' | 'major';
  readonly settings?: Partial<UserSettings>;
  readonly images?: readonly ImageSpec[];
  /** Deterministic rules must report exactly these (assessment `issue`). */
  readonly issues: readonly Expected[];
  /** A human has to look (assessment `manual-review`). */
  readonly reviews?: readonly Expected[];
  /** ColorAdapt could not analyze this (assessment `analysis-limitation`). */
  readonly limits?: readonly Expected[];
  /** Profiles the CVD finding(s) of this scenario are expected under (when it has any). */
  readonly profiles?: readonly VisionProfile[];
}

// ------------------------------------------------------------------------------ oracle

/** WCAG 2.x contrast ratio, written out here so the benchmark does not trust the code it checks. */
export function wcagRatio(a: string, b: string): number {
  const lum = (hex: string): number => {
    const n = Number.parseInt(hex.slice(1), 16);
    const lin = (c: number) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const gray = (level: number): string => `#${level.toString(16).padStart(2, '0').repeat(3)}`;
const text = (id: string, fg: string, bg: string, extra = ''): string =>
  `<p id="${id}" style="color: ${fg}; background-color: ${bg}; ${extra}">Sample text for ${id}</p>`;

// ------------------------------------------------------------------------------ M1

function m1(): AuditScenario[] {
  const out: AuditScenario[] = [];
  // Gray text on white and on black, normal and large: the line is 4.5:1 (3:1 for large text).
  const levels = [0x00, 0x33, 0x59, 0x66, 0x76, 0x77, 0x80, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd];
  for (const level of levels) {
    for (const [bgName, bg] of [
      ['white', '#ffffff'],
      ['black', '#000000'],
    ] as const) {
      const fg = gray(level);
      for (const large of [false, true]) {
        const ratio = wcagRatio(fg, bg);
        const target = large ? 3 : 4.5;
        if (Math.abs(ratio - target) < 0.005 || ratio < 1.001) continue; // identical colors / the exact boundary
        out.push({
          id: `m1-${fg.slice(1)}-on-${bgName}${large ? '-large' : ''}`,
          group: 'M1',
          label: `${fg} on ${bgName}${large ? ', 24px' : ''}: ${ratio.toFixed(2)}:1`,
          markup: text('t', fg, bg, large ? 'font-size: 24px;' : ''),
          scope: 'active',
          profile: 'normal',
          issues: ratio < target ? ['CA-COLOR-001@#t'] : [],
        });
      }
    }
  }
  // Text without a solid background: no conclusion, never a failure.
  out.push(
    {
      id: 'm1-gradient-background',
      group: 'M1',
      label: 'pale text over a gradient: analysis limitation, not an issue',
      markup:
        '<p id="t" style="color: #cccccc; background-image: linear-gradient(#ffffff, #eeeeee);">over a gradient</p>',
      profile: 'normal',
      issues: [],
      limits: ['CA-COLOR-003@#t'],
    },
    {
      id: 'm1-image-background',
      group: 'M1',
      label: 'text over a background image: analysis limitation',
      markup: '<p id="t" style="color: #999999; background-image: url(/bg.png);">over an image</p>',
      profile: 'normal',
      issues: [],
      limits: ['CA-COLOR-003@#t'],
    },
    {
      id: 'm1-disabled',
      group: 'M1',
      label: 'a disabled control is exempt from contrast',
      markup:
        '<button id="t" disabled style="color: #cccccc; background-color: #ffffff;">Disabled</button>',
      profile: 'normal',
      issues: [],
    },
    {
      id: 'm1-hidden',
      group: 'M1',
      label: 'hidden text is not audited',
      markup: '<p id="t" style="display:none; color:#eeeeee; background-color:#ffffff;">gone</p>',
      profile: 'normal',
      issues: [],
    },
    {
      id: 'm1-interactive-link',
      group: 'M1',
      label: 'a pale link is reported',
      markup:
        '<a id="t" href="#x" style="color: #bbbbbb; background-color: #ffffff;">pale link</a>',
      profile: 'normal',
      issues: ['CA-COLOR-001@#t'],
    },
    {
      id: 'm1-inherited-background',
      group: 'M1',
      label: 'text inherits an ancestor’s solid background',
      markup:
        '<div style="background-color: #333333;"><p id="t" style="color: #444444;">dark on dark</p></div>',
      profile: 'normal',
      issues: ['CA-COLOR-001@#t'],
    },
    {
      id: 'm1-translucent-composite',
      group: 'M1',
      label: 'a translucent white over black composites to a readable gray',
      markup:
        '<div style="background-color: #000000;"><p id="t" style="color: rgba(255,255,255,0.9);">readable</p></div>',
      profile: 'normal',
      issues: [],
    },
  );
  return out;
}

// ------------------------------------------------------------------------------ M2

/** [foreground, background, profiles under which the pair merges] regression-locked to the M2 simulation. */
const CVD_PAIRS: ReadonlyArray<readonly [string, string, readonly VisionProfile[]]> = [
  ['#d62728', '#2ca02c', ['deuteranopia']],
  ['#ff0000', '#00aa00', ['deuteranopia']],
  ['#e08080', '#80c080', ['deuteranopia']],
  ['#cc4400', '#558800', ['deuteranopia']],
  ['#ff7f50', '#9acd32', ['deuteranopia']],
  ['#b5651d', '#6b8e23', ['protanopia', 'deuteranopia']],
  ['#9c5a3c', '#6a7d2a', ['protanopia', 'deuteranopia']],
  ['#8b4513', '#556b2f', ['protanopia', 'deuteranopia']],
  ['#c2185b', '#7b1fa2', []],
  ['#c0392b', '#27ae60', []],
  ['#d55e00', '#009e73', []],
  ['#0072b2', '#f0e442', []],
  ['#000000', '#ffffff', []],
];

function m2(): AuditScenario[] {
  return CVD_PAIRS.map(([fg, bg, profiles], index) => {
    const issues: string[] = [];
    if (wcagRatio(fg, bg) < 4.5) issues.push('CA-COLOR-001@#t');
    if (profiles.length > 0) issues.push('CA-COLOR-002@#t');
    return {
      id: `m2-pair-${index + 1}`,
      group: 'M2' as const,
      label: `${fg} on ${bg}: merges under ${profiles.join(' + ') || 'no profile'}`,
      markup: text('t', fg, bg),
      scope: 'major' as const,
      profile: 'normal' as const,
      issues,
      profiles,
    };
  });
}

// ------------------------------------------------------------------------------ M5

const ICON = (color: string, extra = '') =>
  `<svg id="i" style="color: ${color}" ${extra} width="24" height="24" viewBox="0 0 24 24"><path d="M2 2 L22 2 L12 22 Z" fill="currentColor"/></svg>`;

function m5(): AuditScenario[] {
  const svg = (
    id: string,
    label: string,
    markup: string,
    issues: string[],
    extra: Partial<AuditScenario> = {},
  ): AuditScenario => ({
    id: `m5-${id}`,
    group: 'M5',
    label,
    markup,
    kind: 'svg',
    profile: 'normal',
    scope: 'active',
    issues,
    ...extra,
  });
  return [
    svg(
      'pale-icon',
      'a pale functional icon is reported',
      `<button type="button">${ICON('#dddddd')}</button>`,
      ['CA-SVG-001@#i'],
    ),
    svg('pale-icon-bare', 'a pale icon outside a control is reported too', ICON('#e0e0e0'), [
      'CA-SVG-001@#i',
    ]),
    svg('dark-icon', 'a dark icon is fine', ICON('#222222'), []),
    svg('mid-icon', 'a 3.6:1 icon passes the graphics target', ICON('#8a8a8a'), []),
    svg(
      'decorative-pale',
      'a decorative (aria-hidden) pale icon is not reported',
      ICON('#dddddd', 'aria-hidden="true"'),
      [],
    ),
    svg(
      'presentation-pale',
      'role=presentation pale icon is not reported',
      ICON('#dddddd', 'role="presentation"'),
      [],
    ),
    svg(
      'decorative-inside-button',
      'an aria-hidden icon inside a control is treated as its label’s decoration',
      `<button type="button">Save ${ICON('#dddddd', 'aria-hidden="true"')}</button>`,
      [],
    ),
    svg(
      'multi-paint',
      'two paints: ColorAdapt does not model it, so a human looks',
      '<svg id="i" width="24" height="24" viewBox="0 0 24 24"><path d="M2 2 L12 2 L12 22 Z" fill="#cc0000"/><path d="M12 2 L22 2 L12 22 Z" fill="#00aa00"/></svg>',
      [],
      { reviews: ['CA-SVG-002@#i'] },
    ),
    svg(
      'gradient',
      'a gradient paint is a manual review',
      '<svg id="i" width="24" height="24" viewBox="0 0 24 24"><defs><linearGradient id="g"><stop offset="0" stop-color="#cc0000"/><stop offset="1" stop-color="#0000cc"/></linearGradient></defs><path d="M2 2 L22 2 L12 22 Z" fill="url(#g)"/></svg>',
      [],
      { reviews: ['CA-SVG-002@#i'] },
    ),
    svg(
      'chart-like-svg-left-to-charts',
      'an SVG icon with high contrast and a CVD pair is not flagged under normal vision',
      ICON('#aa0000'),
      [],
    ),
  ];
}

// ------------------------------------------------------------------------------ M6

const SEM_CSS = `
  .f { border-top-style: solid; border-top-width: 1px; border-top-color: #888888; }
  .f[aria-invalid="true"] { border-top-color: #c0392b; }
  .f.thick[aria-invalid="true"] { border-top-width: 3px; }
  .tab { color: #555555; background-color: #ffffff; }
  .tab[aria-selected="true"] { color: #0645ad; }
  .tab.bold[aria-selected="true"] { font-weight: bold; }
  .nav-link { color: #555555; background-color: #ffffff; }
  .nav-link[aria-current="page"] { color: #0645ad; }
  .toggle { color: #555555; background-color: #ffffff; }
  .toggle[aria-pressed="true"] { color: #0645ad; }
  .badge { display: inline-block; padding: 2px 6px; color: #ffffff; }
  .badge.success { background-color: #1a7f37; }
  .badge.error { background-color: #b42318; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
  .dot.online { background-color: #1a7f37; }
  .dot.offline { background-color: #b42318; }
`;

function m6(): AuditScenario[] {
  const sem = (
    id: string,
    label: string,
    markup: string,
    expected: Pick<AuditScenario, 'issues' | 'reviews'>,
  ): AuditScenario => ({
    id: `m6-${id}`,
    group: 'M6',
    label,
    markup,
    css: SEM_CSS,
    profile: 'normal',
    scope: 'active',
    ...expected,
  });
  const fields = (a: string, ...rest: string[]) =>
    `<input id="t" class="f ${a}" aria-invalid="true" aria-label="Field"><input class="f" aria-label="B"><input class="f" aria-label="C">${rest.join('')}`;
  return [
    sem(
      'invalid-color-only',
      'aria-invalid control that differs from its peers only by border color',
      fields(''),
      { issues: ['CA-SEM-001@#t'] },
    ),
    sem(
      'invalid-thicker-border',
      'the invalid control also has a thicker border: not color-only',
      fields('thick'),
      { issues: [] },
    ),
    sem(
      'invalid-alone',
      'a lone invalid control has nothing to be compared with: no claim',
      '<input id="t" class="f" aria-invalid="true" aria-label="Field">',
      { issues: [] },
    ),
    sem(
      'valid-peers-only',
      'nothing is invalid: nothing to report',
      '<input id="t" class="f" aria-label="A"><input class="f" aria-label="B">',
      { issues: [] },
    ),
    sem(
      'selected-tab-color-only',
      'aria-selected tab that differs only by color',
      '<div role="tablist"><button id="t" role="tab" aria-selected="true" class="tab">One</button><button role="tab" aria-selected="false" class="tab">Two</button><button role="tab" aria-selected="false" class="tab">Three</button></div>',
      { issues: ['CA-SEM-001@#t'] },
    ),
    sem(
      'selected-tab-bold',
      'the selected tab is also bold: not color-only',
      '<div role="tablist"><button id="t" role="tab" aria-selected="true" class="tab bold">One</button><button role="tab" aria-selected="false" class="tab">Two</button><button role="tab" aria-selected="false" class="tab">Three</button></div>',
      { issues: [] },
    ),
    sem(
      'current-nav-color-only',
      'aria-current link that differs only by color',
      '<nav><a id="t" class="nav-link" aria-current="page" href="#a">Home</a><a class="nav-link" href="#b">Docs</a><a class="nav-link" href="#c">Blog</a></nav>',
      { issues: ['CA-SEM-001@#t'] },
    ),
    sem(
      'pressed-toggle-color-only',
      'aria-pressed toggle that differs only by color',
      '<div><button id="t" class="toggle" aria-pressed="true">Bold</button><button class="toggle" aria-pressed="false">Italic</button><button class="toggle" aria-pressed="false">Underline</button></div>',
      { issues: ['CA-SEM-001@#t'] },
    ),
    sem(
      'badge-with-icon-text',
      'success and error badges with a symbol in the text: already accessible',
      '<span id="t" class="badge success">✓ Passed</span> <span class="badge error">✗ Failed</span>',
      { issues: [] },
    ),
    sem(
      'badge-with-state-word',
      'badges whose text names the state',
      '<span id="t" class="badge success">Success</span> <span class="badge error">Error</span>',
      { issues: [] },
    ),
    sem(
      'badge-class-only',
      'a state guessed from class names is an inference: reviewed, never a confirmed defect',
      '<span id="t" class="badge error">Overdue</span> <span id="u" class="badge success">Paid</span> <span id="v" class="badge success">Sent</span>',
      { issues: [], reviews: ['CA-SEM-002@#t', 'CA-SEM-002@#u', 'CA-SEM-002@#v'] },
    ),
    sem(
      'dot-class-only',
      'online/offline dots told apart by class and color only: reviewed, not condemned',
      '<span id="t" class="dot offline"></span><span id="u" class="dot online"></span><span id="v" class="dot online"></span>',
      { issues: [], reviews: ['CA-SEM-002@#t', 'CA-SEM-002@#u', 'CA-SEM-002@#v'] },
    ),
    sem(
      'plain-paragraph',
      'a plain paragraph is not a state',
      '<p id="t" class="plain">Just text</p><p class="plain">More text</p>',
      { issues: [] },
    ),
    sem(
      'brand-colors',
      'brand red and green blocks are decoration',
      '<div id="t" style="background:#d62728;color:#fff;padding:4px">Acme</div><div style="background:#2ca02c;color:#fff;padding:4px">Acme</div>',
      { issues: [] },
    ),
  ];
}

// ------------------------------------------------------------------------------ M7

const CONFUSABLE = ['#d62728', '#2ca02c', '#ff7f0e'];
const DISTINCT = ['#0072b2', '#d55e00', '#f0e442'];
const BLUES = ['#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#3182bd', '#08519c'];

function m7(): AuditScenario[] {
  const chart = (
    id: string,
    label: string,
    markup: string,
    expected: Pick<AuditScenario, 'issues' | 'reviews' | 'limits'>,
    extra: Partial<AuditScenario> = {},
  ): AuditScenario => ({
    id: `m7-${id}`,
    group: 'M7',
    label,
    markup,
    kind: 'chart',
    profile: 'deuteranopia',
    scope: 'active',
    ...expected,
    ...extra,
  });
  const bad = { issues: ['CA-CHART-001@#chart'] };
  const good = { issues: [] };
  return [
    chart('line-confusable', 'a line chart with confusable colors', lineChartSvg(CONFUSABLE), bad, {
      profiles: ['deuteranopia'],
    }),
    chart('line-distinct', 'a line chart with distinct colors', lineChartSvg(DISTINCT), good),
    chart('bar-confusable', 'a bar chart with confusable colors', barChartSvg(CONFUSABLE), bad, {
      profiles: ['deuteranopia'],
    }),
    chart('bar-distinct', 'a bar chart with distinct colors', barChartSvg(DISTINCT), good),
    chart(
      'scatter-confusable',
      'a scatter plot with confusable colors',
      scatterChartSvg(CONFUSABLE),
      bad,
      { profiles: ['deuteranopia'] },
    ),
    chart(
      'scatter-distinct',
      'a scatter plot with distinct colors',
      scatterChartSvg(DISTINCT),
      good,
    ),
    chart(
      'pie-confusable',
      'a pie chart with confusable colors and a legend',
      pieChartSvg(CONFUSABLE),
      bad,
      { profiles: ['deuteranopia'] },
    ),
    chart('pie-distinct', 'a pie chart with distinct colors', pieChartSvg(DISTINCT), good),
    chart('donut-confusable', 'a donut with confusable colors', donutChartSvg(CONFUSABLE), bad, {
      profiles: ['deuteranopia'],
    }),
    chart('donut-distinct', 'a donut with distinct colors', donutChartSvg(DISTINCT), good),
    chart(
      'line-normal-vision',
      'normal vision: no simulation, no verdict',
      lineChartSvg(CONFUSABLE),
      good,
      { profile: 'normal', scope: 'active' },
    ),
    chart(
      'line-major-profiles',
      'all major profiles: the finding names the profiles that merge',
      lineChartSvg(CONFUSABLE),
      bad,
      { profile: 'normal', scope: 'major', profiles: ['deuteranopia', 'protanopia'] },
    ),
    chart(
      'bar-sequential',
      'a single-hue ramp is magnitude, not identity: reviewed, not condemned',
      barChartSvg(BLUES),
      { issues: [], reviews: ['CA-CHART-003@#chart'] },
    ),
    chart('heatmap', 'a heatmap is reviewed, never condemned', heatmapSvg(), {
      issues: [],
      reviews: ['CA-CHART-003@#chart'],
    }),
    chart(
      'area-confusable',
      'an area chart is not audited automatically',
      areaChartSvg(CONFUSABLE),
      { issues: [], reviews: ['CA-CHART-003@#chart'] },
    ),
    chart(
      'stacked-confusable',
      'a stacked bar chart is not audited automatically',
      stackedBarSvg(CONFUSABLE),
      { issues: [], reviews: ['CA-CHART-003@#chart'] },
    ),
    chart(
      'canvas-chart',
      'a canvas chart is reported as manual review, never as inaccessible',
      '<canvas id="c" class="sales-chart" width="300" height="150"></canvas>',
      { issues: [], reviews: ['CA-CHART-004@#c'] },
    ),
    chart(
      'canvas-game',
      'a game canvas is not a chart',
      '<canvas id="c" class="game-canvas" width="300" height="150"></canvas>',
      good,
    ),
    chart(
      'canvas-signature',
      'a signature pad is not a chart',
      '<div class="signature-pad"><canvas id="c" width="300" height="100"></canvas></div>',
      good,
    ),
    chart(
      'dashed-lines',
      'the page already dashes the lines: color is not the only cue',
      lineChartSvg(CONFUSABLE).replace(
        /<path class="series/g,
        '<path stroke-dasharray="6 3" class="series',
      ),
      { issues: ['CA-CHART-001@#chart'] },
      { profiles: ['deuteranopia'] },
    ),
  ];
}

// ------------------------------------------------------------------------------ M8

function m8(): AuditScenario[] {
  const image = (
    id: string,
    label: string,
    spec: ImageSpec,
    expected: Pick<AuditScenario, 'issues' | 'reviews'>,
  ): AuditScenario => ({
    id: `m8-${id}`,
    group: 'M8',
    label,
    markup: '<div id="host"></div>',
    kind: 'image',
    profile: 'deuteranopia',
    scope: 'active',
    images: [spec],
    ...expected,
  });
  const photo = (id: string, src: string, alt: string): ImageSpec => ({
    id,
    src,
    attrs: { alt },
    width: 300,
    height: 200,
  });
  return [
    image(
      'photo',
      'an ordinary photograph is never a finding',
      photo('i', '/img/team.jpg', 'The team at the offsite'),
      { issues: [] },
    ),
    image('portrait', 'a portrait', photo('i', '/img/portrait.jpg', 'Jane, CTO'), { issues: [] }),
    image(
      'logo-alt',
      'a logo (by alt text)',
      { id: 'i', src: '/img/brand.png', attrs: { alt: 'Acme logo' }, width: 80, height: 32 },
      { issues: [] },
    ),
    image(
      'logo-home-link',
      'a logo that links home',
      {
        id: 'i',
        src: '/img/mark.png',
        attrs: { alt: 'Acme' },
        width: 80,
        height: 32,
        wrapper: 'a',
      },
      { issues: [] },
    ),
    image(
      'decorative',
      'an image marked decorative',
      { id: 'i', src: '/img/swoosh.png', attrs: { alt: '' }, width: 100, height: 50 },
      { issues: [] },
    ),
    image(
      'aria-hidden',
      'an aria-hidden image',
      {
        id: 'i',
        src: '/img/swoosh.png',
        attrs: { alt: 'x', 'aria-hidden': 'true' },
        width: 100,
        height: 50,
      },
      { issues: [] },
    ),
    image(
      'illustration',
      'an illustration',
      photo('i', '/img/hero.png', 'Illustration of a city'),
      { issues: [] },
    ),
    image(
      'screenshot',
      'a screenshot',
      photo('i', '/img/screenshot-settings.png', 'Settings screenshot'),
      { issues: [] },
    ),
    image(
      'raster-chart',
      'a raster chart is reported for manual review',
      photo('i', '/img/quarterly-chart.png', 'Quarterly revenue chart'),
      { issues: [], reviews: ['CA-IMG-002@#i'] },
    ),
    image(
      'raster-graph',
      'a raster graph (by file name)',
      photo('i', '/img/sales-graph.png', 'Sales'),
      { issues: [], reviews: ['CA-IMG-002@#i'] },
    ),
    image(
      'raster-chart-class',
      'a raster chart named by class',
      {
        id: 'i',
        src: '/img/q3.png',
        attrs: { alt: 'Q3', class: 'revenue-chart' },
        width: 300,
        height: 200,
      },
      { issues: [], reviews: ['CA-IMG-002@#i'] },
    ),
    image(
      'cross-origin-icon-button',
      'a small cross-origin image inside a button cannot be read: manual review',
      {
        id: 'i',
        src: 'https://cdn.other.test/icons/alert.png',
        attrs: { alt: 'Alert', class: 'icon' },
        width: 24,
        height: 24,
        wrapper: 'button',
      },
      { issues: [], reviews: ['CA-IMG-003@#i'] },
    ),
    image(
      'cross-origin-icon-cors',
      'the same image requested with CORS can be read',
      {
        id: 'i',
        src: 'https://cdn.other.test/icons/alert.png',
        attrs: { alt: 'Alert', class: 'icon', crossorigin: 'anonymous' },
        width: 24,
        height: 24,
        wrapper: 'button',
      },
      { issues: [] },
    ),
    image(
      'cross-origin-photo',
      'a cross-origin photo outside a control is not a finding',
      photo('i', 'https://cdn.other.test/p.jpg', 'Scenery'),
      { issues: [] },
    ),
    image(
      'same-origin-icon-button',
      'a same-origin icon is not "unreadable"',
      {
        id: 'i',
        src: '/icons/alert.png',
        attrs: { alt: 'Alert', class: 'icon' },
        width: 24,
        height: 24,
        wrapper: 'button',
      },
      { issues: [] },
    ),
    image(
      'data-uri',
      'a data: image is never reported as unreadable',
      {
        id: 'i',
        src: 'data:image/png;base64,AAAA',
        attrs: { alt: 'Alert' },
        width: 24,
        height: 24,
        wrapper: 'button',
      },
      { issues: [] },
    ),
  ];
}

// ------------------------------------------------------------------------------ false positives

/** Things that look suspicious and are not: the audit must stay quiet about every one. */
function falsePositives(): AuditScenario[] {
  const quiet = (
    id: string,
    label: string,
    markup: string,
    extra: Partial<AuditScenario> = {},
  ): AuditScenario => ({
    id: `fp-${id}`,
    group: 'false-positive',
    label,
    markup,
    css: SEM_CSS,
    profile: 'deuteranopia',
    scope: 'major',
    issues: [],
    ...extra,
  });
  return [
    quiet(
      'brand-banner',
      'brand red banner with white text (5:1)',
      '<p id="t" style="background:#d62728;color:#fff">Brand</p>',
    ),
    quiet(
      'decorative-red-green',
      'a red and a green box with no text',
      '<span style="display:inline-block;width:20px;height:20px;background:#d62728"></span><span style="display:inline-block;width:20px;height:20px;background:#2ca02c"></span>',
    ),
    quiet(
      'black-on-white',
      'black on white',
      '<p id="t" style="color:#000;background:#fff">Hello</p>',
    ),
    quiet(
      'white-on-black',
      'white on black',
      '<p id="t" style="color:#fff;background:#000">Hello</p>',
    ),
    quiet(
      'blue-on-orange',
      'a blue/orange pair is safe for everyone',
      '<p id="t" style="color:#0072b2;background:#ffffff">Hello</p>',
    ),
    quiet(
      'status-with-icon-text',
      'a status with icon and text',
      '<span id="t" class="badge success">✓ OK</span> <span class="badge error">✗ Error</span>',
    ),
    quiet('accessible-chart', 'an accessible chart (distinct palette)', lineChartSvg(DISTINCT), {
      kind: 'chart',
    }),
    quiet('photo', 'a photograph', '<div id="host"></div>', {
      kind: 'image',
      images: [{ id: 'i', src: '/p.jpg', attrs: { alt: 'Cat' }, width: 400, height: 300 }],
    }),
    quiet('logo', 'a logo', '<div id="host"></div>', {
      kind: 'image',
      images: [{ id: 'i', src: '/logo.png', attrs: { alt: 'Acme logo' }, width: 120, height: 40 }],
    }),
    quiet('empty-page', 'an empty page', ''),
    quiet(
      'only-images-no-alt',
      'images without alt are not an audit finding',
      '<img id="i" src="/a.png" width="40" height="40">',
    ),
    quiet(
      'form-without-state',
      'a normal form with nothing invalid',
      '<input class="f" aria-label="A"><input class="f" aria-label="B"><input class="f" aria-label="C">',
    ),
    quiet(
      'tabs-nothing-selected',
      'tabs where nothing is selected',
      '<div role="tablist"><button role="tab" aria-selected="false" class="tab">A</button><button role="tab" aria-selected="false" class="tab">B</button></div>',
    ),
    quiet('gray-border-focus', 'a gray bordered input', '<input class="f" aria-label="x">'),
    quiet(
      'text-in-svg-icon',
      'dark icon in a button',
      `<button type="button">${ICON('#202020')}</button>`,
      { kind: 'svg' },
    ),
  ];
}

// ------------------------------------------------------------------------------ M9.R1

/**
 * M9.R1 expansion: the same hard gate over a wider and more adversarial set (text contrast across
 * hues and in Russian, color vision pairs under three profiles, more semantic and chart shapes,
 * canvas, icons, images and things that merely look suspicious). Contrast expectations come from
 * the independent oracle; the color-vision pairs were measured once against the M2 simulation and
 * are regression-locked (M2's own scientific status stays PARTIAL; the audit does not validate it).
 */
const R1_HUE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['#ff6600', '#ffffff'],
  ['#ff8800', '#ffffff'],
  ['#00aa00', '#ffffff'],
  ['#0000ff', '#ffffff'],
  ['#008000', '#ffffff'],
  ['#ff0000', '#ffffff'],
  ['#ffff00', '#ffffff'],
  ['#00ffff', '#000000'],
  ['#ff00ff', '#000000'],
  ['#800080', '#ffffff'],
  ['#ffd700', '#ffffff'],
  ['#1e90ff', '#ffffff'],
  ['#228b22', '#ffffff'],
  ['#dc143c', '#ffffff'],
  ['#708090', '#ffffff'],
  ['#b8860b', '#ffffff'],
  ['#20b2aa', '#ffffff'],
  ['#4682b4', '#ffffff'],
  ['#ff69b4', '#ffffff'],
  ['#8b0000', '#ffe4e1'],
  ['#006400', '#e6ffe6'],
  ['#000080', '#ccddff'],
  ['#663399', '#e6ccff'],
  ['#ffffff', '#ff6600'],
  ['#ffffff', '#0066cc'],
  ['#ffffff', '#00aa00'],
  ['#ffffff', '#cc0000'],
  ['#ffffff', '#999999'],
  ['#000000', '#ffcc00'],
  ['#000000', '#00cc66'],
  ['#000000', '#3366ff'],
  ['#1a1a1a', '#2a2a2a'],
  ['#f5f5f5', '#ffffff'],
  ['#555555', '#cccccc'],
  ['#222222', '#bbbbbb'],
  ['#7a7a7a', '#ffffff'],
];

/** [profile, foreground, background, merges under that profile], measured against the M2 simulation. */
const R1_CVD: ReadonlyArray<readonly [VisionProfile, string, string, boolean]> = [
  ['protanopia', '#d62728', '#8c564b', true],
  ['protanopia', '#ff7f0e', '#2ca02c', true],
  ['protanopia', '#1f77b4', '#9467bd', true],
  ['protanopia', '#9467bd', '#e377c2', true],
  ['protanopia', '#e377c2', '#1f77b4', true],
  ['protanopia', '#7f7f7f', '#e377c2', true],
  ['protanopia', '#bcbd22', '#00aa00', true],
  ['protanopia', '#00aa00', '#e69f00', true],
  ['protanopia', '#808000', '#2ca02c', true],
  ['protanopia', '#d62728', '#2ca02c', false],
  ['protanopia', '#1f77b4', '#ffff00', false],
  ['protanopia', '#7f7f7f', '#1f77b4', false],
  ['protanopia', '#0000ff', '#ff0000', false],
  ['protanopia', '#00ffff', '#009e73', false],
  ['protanopia', '#808000', '#1f77b4', false],
  ['protanopia', '#009e73', '#00aa00', false],
  ['deuteranopia', '#d62728', '#2ca02c', true],
  ['deuteranopia', '#2ca02c', '#ff0000', true],
  ['deuteranopia', '#9467bd', '#008080', true],
  ['deuteranopia', '#e377c2', '#17becf', true],
  ['deuteranopia', '#bcbd22', '#ff7f0e', true],
  ['deuteranopia', '#00aa00', '#808000', true],
  ['deuteranopia', '#008080', '#8c564b', true],
  ['deuteranopia', '#808000', '#8c564b', true],
  ['deuteranopia', '#0072b2', '#008080', true],
  ['deuteranopia', '#d62728', '#ff7f0e', false],
  ['deuteranopia', '#1f77b4', '#00ffff', false],
  ['deuteranopia', '#e377c2', '#cc79a7', false],
  ['deuteranopia', '#0000ff', '#bcbd22', false],
  ['deuteranopia', '#00ffff', '#808000', false],
  ['deuteranopia', '#008080', '#56b4e9', false],
  ['deuteranopia', '#009e73', '#00aa00', false],
  ['tritanopia', '#2ca02c', '#1f77b4', true],
  ['tritanopia', '#ff7f0e', '#ff00ff', true],
  ['tritanopia', '#9467bd', '#8c564b', true],
  ['tritanopia', '#e377c2', '#ff00ff', true],
  ['tritanopia', '#7f7f7f', '#009e73', true],
  ['tritanopia', '#00aa00', '#17becf', true],
  ['tritanopia', '#008080', '#0072b2', true],
  ['tritanopia', '#ff00ff', '#e377c2', true],
  ['tritanopia', '#0072b2', '#008080', true],
  ['tritanopia', '#d62728', '#2ca02c', false],
  ['tritanopia', '#1f77b4', '#ff0000', false],
  ['tritanopia', '#e377c2', '#56b4e9', false],
  ['tritanopia', '#0000ff', '#7f7f7f', false],
  ['tritanopia', '#00ffff', '#008080', false],
  ['tritanopia', '#008080', '#e69f00', false],
  ['tritanopia', '#009e73', '#00ffff', false],
];

function r1(): AuditScenario[] {
  const out: AuditScenario[] = [];
  const base = { group: 'R1' as const, profile: 'normal' as const, scope: 'active' as const };

  // Text contrast across hues (English): oracle only; the exact 4.5:1 boundary is skipped.
  R1_HUE_PAIRS.forEach(([fg, bg], index) => {
    const ratio = wcagRatio(fg, bg);
    if (Math.abs(ratio - 4.5) < 0.03) return;
    out.push({
      ...base,
      id: `r1-hue-${index + 1}`,
      label: `${fg} on ${bg}: ${ratio.toFixed(2)}:1`,
      markup: text('t', fg, bg),
      issues: ratio < 4.5 ? ['CA-COLOR-001@#t'] : [],
    });
  });

  // The same in Russian: the audit must not care about the script.
  R1_HUE_PAIRS.filter((_, i) => i % 3 === 0).forEach(([fg, bg], index) => {
    const ratio = wcagRatio(fg, bg);
    if (Math.abs(ratio - 4.5) < 0.03) return;
    out.push({
      ...base,
      id: `r1-ru-${index + 1}`,
      label: `Russian text, ${fg} on ${bg}: ${ratio.toFixed(2)}:1`,
      markup: `<p id="t" style="color: ${fg}; background-color: ${bg};">Образец текста для проверки контраста</p>`,
      issues: ratio < 4.5 ? ['CA-COLOR-001@#t'] : [],
    });
  });

  // Large text: the line moves to 3:1. Bold 19px counts as large; bold 17px does not.
  for (const [name, style, target] of [
    ['24px', 'font-size: 24px;', 3],
    ['19px-bold', 'font-size: 19px; font-weight: 700;', 3],
    ['17px-bold', 'font-size: 17px; font-weight: 700;', 4.5],
    ['19px-regular', 'font-size: 19px;', 4.5],
  ] as const) {
    for (const fg of ['#767676', '#888888', '#999999', '#aaaaaa']) {
      const ratio = wcagRatio(fg, '#ffffff');
      if (Math.abs(ratio - target) < 0.03) continue;
      out.push({
        ...base,
        id: `r1-size-${name}-${fg.slice(1)}`,
        label: `${fg} on white, ${name}: ${ratio.toFixed(2)}:1 against ${target}:1`,
        markup: text('t', fg, '#ffffff', style),
        issues: ratio < target ? ['CA-COLOR-001@#t'] : [],
      });
    }
  }

  // Color vision pairs under three profiles (contrast from the oracle, merging from the lock).
  R1_CVD.forEach(([profile, fg, bg, merges], index) => {
    const issues: string[] = [];
    if (wcagRatio(fg, bg) < 4.5) issues.push('CA-COLOR-001@#t');
    if (merges) issues.push('CA-COLOR-002@#t');
    out.push({
      id: `r1-cvd-${profile}-${index + 1}`,
      group: 'R1',
      label: `${fg} on ${bg} under ${profile}: ${merges ? 'merges' : 'stays apart'}`,
      markup: text('t', fg, bg),
      profile,
      scope: 'active',
      issues,
      ...(merges ? { profiles: [profile] } : {}),
    });
  });

  // Semantic state: more control types, Russian labels, redundancy, several invalid controls.
  const semBase = { ...base, css: SEM_CSS };
  for (const type of ['email', 'tel', 'search', 'url', 'password', 'number']) {
    const peers = `<input type="${type}" class="f" aria-label="B"><input type="${type}" class="f" aria-label="C">`;
    out.push(
      {
        ...semBase,
        id: `r1-sem-invalid-${type}`,
        label: `an invalid ${type} field that differs only by border color`,
        markup: `<input id="t" type="${type}" class="f" aria-invalid="true" aria-label="Field">${peers}`,
        issues: ['CA-SEM-001@#t'],
      },
      {
        ...semBase,
        id: `r1-sem-invalid-${type}-thick`,
        label: `an invalid ${type} field that also has a thicker border`,
        markup: `<input id="t" type="${type}" class="f thick" aria-invalid="true" aria-label="Field">${peers}`,
        issues: [],
      },
    );
  }
  out.push(
    {
      ...semBase,
      id: 'r1-sem-invalid-textarea',
      label: 'an invalid textarea that differs only by border color',
      markup:
        '<textarea id="t" class="f" aria-invalid="true" aria-label="Msg"></textarea><textarea class="f" aria-label="B"></textarea><textarea class="f" aria-label="C"></textarea>',
      issues: ['CA-SEM-001@#t'],
    },
    {
      ...semBase,
      id: 'r1-sem-invalid-ru',
      label: 'Russian labels: an invalid field that differs only by border color',
      markup:
        '<input id="t" class="f" aria-invalid="true" aria-label="Электронная почта"><input class="f" aria-label="Телефон"><input class="f" aria-label="Имя">',
      issues: ['CA-SEM-001@#t'],
    },
    {
      ...semBase,
      id: 'r1-sem-two-invalid',
      label: 'two invalid fields among peers: both reported',
      markup:
        '<input id="t" class="f" aria-invalid="true" aria-label="A"><input id="u" class="f" aria-invalid="true" aria-label="B"><input class="f" aria-label="C"><input class="f" aria-label="D">',
      issues: ['CA-SEM-001@#t', 'CA-SEM-001@#u'],
    },
    {
      ...semBase,
      id: 'r1-sem-one-of-twenty',
      label: 'one invalid field among twenty',
      markup: `<input id="t" class="f" aria-invalid="true" aria-label="A">${Array.from({ length: 19 }, (_, i) => `<input class="f" aria-label="P${i}">`).join('')}`,
      issues: ['CA-SEM-001@#t'],
    },
    {
      ...semBase,
      id: 'r1-sem-selected-tab-underline',
      label: 'the selected tab is also underlined: not color-only',
      // Longhand: jsdom does not expand the `text-decoration` shorthand.
      css: `${SEM_CSS} .tab.ul[aria-selected="true"] { text-decoration-line: underline; }`,
      markup:
        '<div role="tablist"><button id="t" role="tab" aria-selected="true" class="tab ul">One</button><button role="tab" aria-selected="false" class="tab ul">Two</button><button role="tab" aria-selected="false" class="tab ul">Three</button></div>',
      issues: [],
    },
    {
      ...semBase,
      id: 'r1-sem-selected-tab-ru',
      label: 'Russian tab labels, selected by color only',
      markup:
        '<div role="tablist"><button id="t" role="tab" aria-selected="true" class="tab">Главная</button><button role="tab" aria-selected="false" class="tab">Каталог</button><button role="tab" aria-selected="false" class="tab">Контакты</button></div>',
      issues: ['CA-SEM-001@#t'],
    },
    {
      ...semBase,
      id: 'r1-sem-badge-ru-text',
      label: 'Russian badges that name the state in words',
      markup:
        '<span id="t" class="badge success">✓ Успешно</span> <span class="badge error">✗ Ошибка</span>',
      issues: [],
    },
    {
      ...semBase,
      id: 'r1-sem-ambiguous-class',
      label: 'a state implied only by an ambiguous class name is never a confirmed issue',
      markup:
        '<span id="t" class="badge error">Overdue</span> <span id="u" class="badge success">Paid</span> <span id="v" class="badge success">Sent</span>',
      issues: [],
      reviews: ['CA-SEM-002@#t', 'CA-SEM-002@#u', 'CA-SEM-002@#v'],
    },
  );

  // Charts: more orders and palettes; every deterministic verdict follows the same evidence.
  const chartBase = { ...base, kind: 'chart' as const, profile: 'deuteranopia' as const };
  const reversed = [...CONFUSABLE].reverse();
  const rotated = [CONFUSABLE[1] as string, CONFUSABLE[2] as string, CONFUSABLE[0] as string];
  const OKABE = ['#0072b2', '#e69f00', '#009e73'];
  for (const [shape, make] of [
    ['line', lineChartSvg],
    ['bar', barChartSvg],
    ['scatter', scatterChartSvg],
    ['pie', pieChartSvg],
  ] as const) {
    out.push(
      {
        ...chartBase,
        id: `r1-chart-${shape}-reversed`,
        label: `a ${shape} chart with the confusable palette reversed`,
        markup: make(reversed),
        issues: ['CA-CHART-001@#chart'],
        profiles: ['deuteranopia'],
      },
      {
        ...chartBase,
        id: `r1-chart-${shape}-rotated`,
        label: `a ${shape} chart with the confusable palette rotated`,
        markup: make(rotated),
        issues: ['CA-CHART-001@#chart'],
        profiles: ['deuteranopia'],
      },
      {
        ...chartBase,
        id: `r1-chart-${shape}-okabe`,
        label: `a ${shape} chart with a colorblind-safe palette`,
        markup: make(OKABE),
        issues: [],
      },
      {
        ...chartBase,
        id: `r1-chart-${shape}-protanopia`,
        label: `a ${shape} chart with confusable colors under protanopia`,
        markup: make(CONFUSABLE),
        profile: 'protanopia',
        issues: ['CA-CHART-001@#chart'],
        profiles: ['protanopia'],
      },
    );
  }

  // Canvas: charts by name need a human; games, pads and codes are not charts.
  for (const [id, markup] of [
    ['canvas-revenue', '<canvas id="c" class="revenue-chart" width="300" height="150"></canvas>'],
    ['canvas-graph-id', '<canvas id="traffic-graph" width="300" height="150"></canvas>'],
    [
      'canvas-aria',
      '<canvas id="c" aria-label="Sales chart for 2024" width="300" height="150"></canvas>',
    ],
    [
      'canvas-bar',
      '<div class="widget"><canvas id="c" class="bar-chart" width="300" height="150"></canvas></div>',
    ],
  ] as const) {
    const cid = markup.includes('traffic-graph') ? 'traffic-graph' : 'c';
    out.push({
      ...chartBase,
      id: `r1-${id}`,
      label: `a canvas chart (${id}) is manual review, never an issue`,
      markup,
      issues: [],
      reviews: [`CA-CHART-004@#${cid}`],
    });
  }
  for (const [id, markup] of [
    ['avatar', '<canvas id="c" class="avatar" width="64" height="64"></canvas>'],
    ['qr', '<canvas id="c" class="qr-code" width="128" height="128"></canvas>'],
    ['confetti', '<canvas id="c" class="confetti-layer" width="300" height="150"></canvas>'],
    ['video-frame', '<canvas id="c" class="video-frame" width="320" height="180"></canvas>'],
    ['sketch', '<canvas id="c" class="sketch-board" width="300" height="200"></canvas>'],
    ['webgl-scene', '<canvas id="c" class="webgl-scene" width="300" height="200"></canvas>'],
  ] as const) {
    out.push({
      ...chartBase,
      id: `r1-canvas-not-chart-${id}`,
      label: `a ${id} canvas is not a chart`,
      markup,
      issues: [],
    });
  }

  // Inline SVG icons on white: oracle (3:1 for graphics).
  const svgBase = { ...base, kind: 'svg' as const };
  for (const level of [
    0x33, 0x55, 0x77, 0x80, 0x88, 0x90, 0x99, 0xa0, 0xaa, 0xb0, 0xbb, 0xcc, 0xee,
  ]) {
    const fg = gray(level);
    const ratio = wcagRatio(fg, '#ffffff');
    if (Math.abs(ratio - 3) < 0.03) continue;
    out.push({
      ...svgBase,
      id: `r1-svg-gray-${fg.slice(1, 3)}`,
      label: `${fg} icon on white: ${ratio.toFixed(2)}:1`,
      markup: `<button type="button">${ICON(fg)}</button>`,
      issues: ratio < 3 ? ['CA-SVG-001@#i'] : [],
    });
  }
  // Icons on dark backgrounds need a real browser: the SVG test engine does not model backgrounds,
  // so those cases live in e2e/audit-review.spec.ts.
  for (const [name, pair] of [
    ['red-green', ['#cc0000', '#00aa00']],
    ['blue-orange', ['#0066cc', '#ff8800']],
    ['black-white', ['#000000', '#ffffff']],
  ] as const) {
    out.push({
      ...svgBase,
      id: `r1-svg-multi-${name}`,
      label: `two paints (${name}) are not modeled: manual review`,
      markup: `<svg id="i" width="24" height="24" viewBox="0 0 24 24"><path d="M2 2 L12 2 L12 22 Z" fill="${pair[0]}"/><path d="M12 2 L22 2 L12 22 Z" fill="${pair[1]}"/></svg>`,
      issues: [],
      reviews: ['CA-SVG-002@#i'],
    });
  }
  for (const color of ['#dddddd', '#eeeeee', '#cccccc']) {
    out.push({
      ...svgBase,
      id: `r1-svg-hidden-${color.slice(1, 3)}`,
      label: `a pale ${color} icon hidden from assistive technology is decoration`,
      markup: ICON(color, 'aria-hidden="true"'),
      issues: [],
    });
  }

  // Images: photos, logos and illustrations stay quiet; charts and unreadable controls need a human.
  const imageBase = {
    ...base,
    kind: 'image' as const,
    profile: 'deuteranopia' as const,
    markup: '<div id="host"></div>',
  };
  const photoSpec = (id: string, src: string, alt: string): ImageSpec => ({
    id,
    src,
    attrs: { alt },
    width: 320,
    height: 200,
  });
  for (const [name, src, alt] of [
    ['team', '/img/team-photo.jpg', 'The whole team'],
    ['banner', '/img/banner.webp', 'Autumn sale'],
    ['product', '/img/product-12.jpg', 'Blue running shoe'],
    ['ru-photo', '/img/foto.jpg', 'Фотография команды'],
    ['ru-banner', '/img/promo.png', 'Осенняя распродажа'],
    ['map', '/img/office-map.png', 'How to find our office'],
    ['logo-wide', '/img/logo-wide.png', 'Acme'],
  ] as const) {
    out.push({
      ...imageBase,
      id: `r1-img-${name}`,
      label: `${name}: an ordinary image is never a finding`,
      images: [photoSpec('i', src, alt)],
      issues: [],
    });
  }
  for (const [name, src, alt] of [
    ['pie', '/img/pie-chart.png', 'Market share'],
    ['bars', '/img/bar-chart-2024.png', 'Revenue'],
    ['graph', '/img/growth-graph.png', 'Growth'],
    ['alt-chart', '/img/q4.png', 'Quarterly sales chart'],
  ] as const) {
    out.push({
      ...imageBase,
      id: `r1-img-raster-${name}`,
      label: `${name}: a raster chart is manual review`,
      images: [photoSpec('i', src, alt)],
      issues: [],
      reviews: ['CA-IMG-002@#i'],
    });
  }
  out.push(
    {
      ...imageBase,
      id: 'r1-img-cross-origin-link-icon',
      label: 'a small cross-origin icon inside a link cannot be read: manual review',
      images: [
        {
          id: 'i',
          src: 'https://cdn.other.test/i/warn.png',
          attrs: { alt: 'Warning', class: 'icon' },
          width: 20,
          height: 20,
          wrapper: 'a',
        },
      ],
      issues: [],
      reviews: ['CA-IMG-003@#i'],
    },
    {
      ...imageBase,
      id: 'r1-img-cross-origin-large-in-button',
      label: 'a large cross-origin image in a button is a picture, not an icon',
      images: [
        {
          id: 'i',
          src: 'https://cdn.other.test/i/hero.png',
          attrs: { alt: 'Hero' },
          width: 400,
          height: 300,
          wrapper: 'button',
        },
      ],
      issues: [],
    },
  );

  // Things that look suspicious and are not.
  const quiet = (id: string, label: string, markup: string): AuditScenario => ({
    ...base,
    id: `r1-fp-${id}`,
    label,
    markup,
    css: SEM_CSS,
    profile: 'deuteranopia',
    scope: 'major',
    issues: [],
  });
  out.push(
    quiet(
      'disabled-button',
      'a disabled button is exempt',
      '<button disabled style="color:#cccccc;background:#ffffff">Save</button>',
    ),
    quiet(
      'disabled-input',
      'a disabled field is exempt',
      '<input disabled value="x" style="color:#cccccc;background:#ffffff">',
    ),
    quiet(
      'hidden-attribute',
      'text with the hidden attribute is not shown',
      '<p hidden style="color:#eeeeee;background:#ffffff">gone</p>',
    ),
    quiet(
      'visibility-hidden',
      'text with visibility:hidden is not shown',
      '<p style="visibility:hidden;color:#eeeeee;background:#ffffff">gone</p>',
    ),
    quiet(
      'empty-paragraph',
      'an empty paragraph has no text to judge',
      '<p style="color:#eeeeee;background:#ffffff"></p>',
    ),
    quiet(
      'decor-red-green-russian',
      'red and green decoration next to Russian text that is readable',
      '<div style="display:flex"><span style="width:20px;height:20px;background:#d62728"></span><span style="width:20px;height:20px;background:#2ca02c"></span><p style="color:#000;background:#fff">Красный и зелёный</p></div>',
    ),
    quiet(
      'template-content',
      'markup inside a template is not part of the page',
      '<template><p style="color:#eeeeee;background:#ffffff">x</p></template>',
    ),
    quiet(
      'script-and-style-text',
      'script and style text is not page text',
      '<style>.x{color:#eee}</style><script>var a = "pale";</script>',
    ),
    quiet(
      'hostile-text',
      'hostile page text is just text: no finding and no execution',
      '<p style="color:#000;background:#fff">&lt;script&gt;alert(1)&lt;/script&gt; <img src=x onerror=alert(1)></p>',
    ),
    quiet(
      'long-text',
      'a very long readable text is not a finding',
      `<p style="color:#000;background:#fff">${'lorem ipsum '.repeat(2000)}</p>`,
    ),
  );
  return out;
}

export function buildScenarios(): AuditScenario[] {
  return [...m1(), ...m2(), ...m5(), ...m6(), ...m7(), ...m8(), ...falsePositives(), ...r1()];
}
