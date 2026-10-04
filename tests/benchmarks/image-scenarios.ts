import type { ImageAction, ImageKind, ImageReason, VisionProfile } from '@domain/models';
import type { PixelBuffer } from '@core/images';
import type { Resource } from '../features/images/fake-env';
import { GIF_TWO_FRAMES } from '../features/images/fake-env';
import { r1Scenarios } from './image-scenarios-r1';
import {
  blank,
  disc,
  flatLogo,
  hex,
  mulberry32,
  monoIcon,
  photograph,
  rasterBarChart,
  rect,
  screenshot,
  type Rgba,
} from '../core/images/pixels';

/**
 * Image benchmark scenarios (docs/IMAGE_ADAPTATION.md, "Benchmark"). Every image is synthetic and
 * generated here: no file, no network. They reproduce the statistics and the DOM context of the
 * real-world kinds named in each id, not their looks. Three groups:
 *
 * - `false-positive`: images that must never be recolored (photographs, logos, artwork, screenshots,
 *   decorative, ...). The gate is zero transformations.
 * - `supported`: the narrow safe case: functional monochrome icons whose color the profile confuses
 *   with the ground. Each must be adapted, with better distinguishability and the same geometry.
 * - `other`: images that are unsupported or not needed for a stated reason.
 */
export type Group = 'false-positive' | 'supported' | 'miss' | 'other';

export type Category =
  | 'photograph'
  | 'logo'
  | 'decorative'
  | 'monochrome-icon'
  | 'status-graphic'
  | 'diagram'
  | 'raster-chart'
  | 'screenshot'
  | 'cross-origin-unreadable'
  | 'same-origin-readable'
  | 'animated'
  | 'large-image'
  | 'transparent-png'
  | 'presentation'
  | 'brand-ambiguity'
  | 'functional-icon'
  | 'artwork'
  | 'boundary'
  | 'responsive';

export interface ImageScenario {
  readonly id: string;
  readonly category: Category;
  readonly group: Group;
  readonly profile: VisionProfile;
  /** CSS color of the ground the image sits on. */
  readonly background: string;
  readonly src: string;
  readonly resource: Resource;
  /** Natural size when it differs from the pixels' (a large image, stood in for by a small buffer). */
  readonly natural?: { readonly width: number; readonly height: number };
  readonly attrs?: Readonly<Record<string, string>>;
  /** Wrapper element of the image: a link or button makes it interactive; a class gives it context. */
  readonly wrapper?: {
    readonly tag: 'div' | 'a' | 'button' | 'nav' | 'header' | 'picture';
    readonly className?: string;
    readonly href?: string;
    readonly attrs?: Readonly<Record<string, string>>;
  };
  /** Keep the file name of `src` as written (a scenario about the name itself). */
  readonly keepName?: boolean;
  readonly bytes?: Uint8Array;
  readonly expect: {
    readonly action: ImageAction;
    readonly reason?: ImageReason;
    readonly kind?: ImageKind;
  };
}

const ORIGIN = 'http://localhost:3000';
const url = (name: string): string => `${ORIGIN}/bench/${name}`;

function jpegLike(width: number, height: number, seed: number): PixelBuffer {
  return photograph(width, height, seed);
}

/** A game texture: a repeating noisy tile. */
function texture(width: number, height: number, seed: number): PixelBuffer {
  const random = mulberry32(seed);
  const buffer = blank(width, height, [0, 0, 0, 255]);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const base = ((x >> 3) + (y >> 3)) % 2 === 0 ? 120 : 90;
      const n = Math.floor(random() * 60);
      buffer.data.set([base + n, base - 20 + n, 60 + (n >> 1), 255], (y * width + x) * 4);
    }
  }
  return buffer;
}

/** A meme: a photograph with bars of text-like strokes on top and bottom. */
function meme(seed: number): PixelBuffer {
  const buffer = photograph(160, 120, seed);
  rect(buffer, 8, 6, 144, 12, hex('#ffffff'));
  rect(buffer, 8, 100, 144, 12, hex('#ffffff'));
  return buffer;
}

/** A pie-like chart: wedges approximated with discs of flat color on white. */
function rasterPie(colors: readonly Rgba[]): PixelBuffer {
  const buffer = blank(180, 180, [255, 255, 255, 255]);
  disc(buffer, 90, 90, 70, colors[0]!);
  colors.slice(1).forEach((color, index) => {
    rect(buffer, 90, 20 + index * 20, 70 - index * 12, 18, color);
  });
  return buffer;
}

/** A line chart: axes, grid and thick colored polylines. */
function rasterLineChart(colors: readonly Rgba[]): PixelBuffer {
  const buffer = blank(240, 140, [255, 255, 255, 255]);
  rect(buffer, 20, 8, 1, 110, hex('#3c3c3c'));
  rect(buffer, 20, 118, 200, 1, hex('#3c3c3c'));
  colors.forEach((color, line) => {
    for (let x = 24; x < 220; x += 1) {
      const y = 100 - line * 22 - Math.floor(14 * Math.sin((x + line * 30) / 18));
      rect(buffer, x, y, 1, 3, color);
    }
  });
  return buffer;
}

/** A two-region diagram: two flat regions differing only by hue. */
function twoRegion(a: Rgba, b: Rgba): PixelBuffer {
  const buffer = blank(140, 90, [255, 255, 255, 255]);
  rect(buffer, 10, 10, 55, 70, a);
  rect(buffer, 75, 10, 55, 70, b);
  return buffer;
}

/** A transparent sticker with several paints. */
function sticker(): PixelBuffer {
  const buffer = blank(64, 64);
  disc(buffer, 32, 32, 28, hex('#e8590c'));
  disc(buffer, 24, 26, 8, hex('#ffffff'));
  disc(buffer, 42, 38, 9, hex('#1971c2'));
  return buffer;
}

const D: VisionProfile = 'deuteranopia';
const P: VisionProfile = 'protanopia';
const T: VisionProfile = 'tritanopia';

function photos(): ImageScenario[] {
  const kinds: Array<[string, number, number, number, Record<string, string>]> = [
    ['portrait', 96, 128, 1, { alt: 'Portrait of a woman in a red coat' }],
    ['landscape', 160, 96, 2, { alt: 'Mountain lake at sunrise' }],
    ['product', 128, 128, 3, { alt: 'Red sneaker on a green mat' }],
    ['food', 120, 120, 4, { alt: 'Salad with tomatoes' }],
    ['animal', 140, 100, 5, { alt: 'A fox in the grass' }],
    ['architecture', 110, 150, 6, { alt: 'Cathedral facade' }],
    ['album-cover', 128, 128, 7, { alt: 'Album cover' }],
    ['hero-banner', 192, 80, 8, { alt: '', class: 'hero' }],
    ['ad-photo', 150, 100, 9, { alt: 'Sale: red shoes, green grass' }],
    ['avatar', 64, 64, 10, { alt: 'avatar', class: 'avatar' }],
    ['alt-says-chart', 96, 96, 11, { alt: 'chart', class: 'chart' }],
    ['alt-says-icon', 64, 64, 12, { alt: 'icon', class: 'icon' }],
    ['thumbnail-status', 64, 64, 13, { alt: 'status', class: 'status-thumb' }],
    ['jpeg-large', 400, 300, 14, { alt: 'Wedding' }],
  ];
  const profiles = [D, P, T];
  const list = kinds.map(([name, w, h, seed, attrs], index): ImageScenario => {
    const attributes = attrs.alt === '' ? { ...attrs, alt: 'decorative hero' } : attrs;
    return {
      id: `photo-${name}`,
      category: 'photograph',
      group: 'false-positive',
      profile: profiles[index % 3]!,
      background: '#2ca02c',
      src: url(`photo-${name}.jpg`),
      resource: jpegLike(w, h, seed),
      attrs: attributes,
      expect: { action: 'unchanged', reason: 'photograph', kind: 'photograph' },
    };
  });
  list.push({
    id: 'photo-meme',
    category: 'photograph',
    group: 'false-positive',
    profile: D,
    background: '#2ca02c',
    src: url('meme.jpg'),
    resource: meme(15),
    attrs: { alt: 'meme' },
    expect: { action: 'unchanged' },
  });
  list.push({
    id: 'photo-game-texture',
    category: 'photograph',
    group: 'false-positive',
    profile: D,
    background: '#2ca02c',
    src: url('texture.png'),
    resource: texture(96, 96, 16),
    attrs: { alt: 'Ground texture', class: 'texture' },
    expect: { action: 'unchanged' },
  });
  return list;
}

function logos(): ImageScenario[] {
  const make = (
    id: string,
    resource: PixelBuffer,
    attrs: Record<string, string>,
    extra: Partial<ImageScenario> = {},
    profile: VisionProfile = D,
  ): ImageScenario => ({
    id: `logo-${id}`,
    category: 'logo',
    group: 'false-positive',
    profile,
    background: '#2ca02c',
    src: url(`${id}.png`),
    resource,
    attrs,
    expect: { action: 'unchanged', reason: 'logo', kind: 'logo' },
    ...extra,
  });
  const redMark = monoIcon(32, hex('#d62728'), false);
  return [
    make('token-class', redMark, { class: 'site-logo', alt: 'Acme' }),
    make('token-alt', redMark, { alt: 'Acme logo' }),
    make('token-file-name', redMark, { alt: 'Acme' }, { src: url('acme-logo.png') }),
    make(
      'brand-context',
      redMark,
      { alt: 'Acme' },
      { wrapper: { tag: 'div', className: 'navbar-brand' } },
    ),
    make('home-link', redMark, { alt: 'Acme home' }, { wrapper: { tag: 'a', href: '/' } }),
    make('red-green-flag', flatLogo(120, 60, [hex('#d62728'), hex('#2ca02c')]), {
      alt: 'Acme logo',
    }),
    make('wordmark', flatLogo(160, 40, [hex('#1971c2'), hex('#f08c00'), hex('#d62728')]), {
      alt: 'Acme wordmark',
    }),
    make('brand-token-russian', redMark, { alt: 'Лого Acme' }),
    make('protan', redMark, { alt: 'Acme logo' }, {}, P),
    make(
      'tritan',
      monoIcon(32, hex('#3b6fb6'), false),
      { alt: 'Acme logo' },
      { background: '#2aa198' },
      T,
    ),
    make(
      'artwork-flat',
      flatLogo(200, 80, [hex('#e8590c'), hex('#5c940d'), hex('#364fc7')]),
      { alt: 'Cover artwork' },
      {
        expect: { action: 'unchanged' },
      },
    ),
    make(
      'brand-header-icon',
      monoIcon(24, hex('#d62728'), false),
      { class: 'icon', alt: 'Acme' },
      {
        wrapper: { tag: 'div', className: 'brand header' },
      },
    ),
  ];
}

function decoratives(): ImageScenario[] {
  const red = monoIcon(24, hex('#d62728'), false);
  const make = (
    id: string,
    attrs: Record<string, string>,
    profile: VisionProfile = D,
  ): ImageScenario => ({
    id: `decorative-${id}`,
    category: 'decorative',
    group: 'false-positive',
    profile,
    background: '#2ca02c',
    src: url(`${id}.png`),
    resource: red,
    attrs,
    expect: { action: 'unchanged', reason: 'decorative', kind: 'decorative' },
  });
  return [
    make('alt-empty', { alt: '', class: 'icon' }),
    make('role-presentation', { role: 'presentation', class: 'icon' }),
    make('role-none', { role: 'none', alt: 'x' }),
    make('aria-hidden', { 'aria-hidden': 'true', class: 'icon', alt: 'Alert' }),
    make('alt-empty-protan', { alt: '' }, P),
    make('alt-empty-tritan', { alt: '' }, T),
    make('empty-alt-in-button', { alt: '', class: 'icon' }),
    make('presentation-icon-class', { role: 'presentation', class: 'icon alert' }),
  ];
}

const ICON_PAIRS: Array<[VisionProfile, string, string, number]> = [
  [D, '#d62728', '#2ca02c', 16],
  [D, '#d62728', '#6b8e23', 24],
  [D, '#e8590c', '#5c940d', 32],
  [D, '#c92a2a', '#2b8a3e', 20],
  [D, '#d9480f', '#74b816', 48],
  [P, '#e03131', '#5c7c2b', 24],
  [P, '#e03131', '#5c7c2b', 16],
  [T, '#3b6fb6', '#2aa198', 24],
  [T, '#1864ab', '#0b7285', 32],
  [T, '#e64980', '#f08c00', 24],
  [T, '#fab005', '#ffa8a8', 16],
  [T, '#2f9e44', '#1098ad', 24],
  [T, '#7048e8', '#0b7285', 20],
  [D, '#d62728', '#2ca02c', 64],
  [D, '#d62728', '#2ca02c', 96],
  [D, '#c92a2a', '#2b8a3e', 128],
];

function supported(): ImageScenario[] {
  return ICON_PAIRS.map(([profile, fg, bg, size], index): ImageScenario => {
    const wrappers: Array<ImageScenario['wrapper']> = [
      undefined,
      { tag: 'button' },
      { tag: 'a', href: '#more' },
    ];
    const attrs: Array<Record<string, string>> = [
      { class: 'icon', alt: 'Alert' },
      { alt: 'Delete item' },
      { class: 'btn-icon' },
    ];
    return {
      id: `icon-${profile}-${fg.slice(1)}-on-${bg.slice(1)}-${size}`,
      category: 'monochrome-icon',
      group: 'supported',
      profile,
      background: bg,
      src: url(`icon-${index}.png`),
      resource: monoIcon(size, hex(fg), index % 2 === 0),
      attrs: attrs[index % 3]!,
      ...(wrappers[index % 3] ? { wrapper: wrappers[index % 3]! } : {}),
      expect: { action: 'pixel-adapted', reason: 'adapted', kind: 'monochrome-icon' },
    };
  });
}

function notNeeded(): ImageScenario[] {
  const make = (
    id: string,
    fg: string,
    bg: string,
    profile: VisionProfile,
    expectation: ImageScenario['expect'] = { action: 'not-needed', kind: 'monochrome-icon' },
  ): ImageScenario => ({
    id: `icon-not-needed-${id}`,
    category: 'monochrome-icon',
    group: 'other',
    profile,
    background: bg,
    src: url(`nn-${id}.png`),
    resource: monoIcon(24, hex(fg), false),
    attrs: { class: 'icon', alt: 'Alert' },
    expect: expectation,
  });
  return [
    // Only neutrals: nothing in it depends on hue, so nothing to adapt (and it is not a "monochrome icon").
    make('black-on-white', '#000000', '#ffffff', D, { action: 'unchanged', reason: 'ui-raster' }),
    make('blue-on-white', '#1f4aa8', '#ffffff', P),
    make('red-on-white', '#d62728', '#ffffff', T),
    make('purple-on-blue-protan', '#862e9c', '#1971c2', P),
  ];
}

function statuses(): ImageScenario[] {
  const make = (
    id: string,
    color: string,
    attrs: Record<string, string>,
    profile: VisionProfile,
  ): ImageScenario => ({
    id: `status-${id}`,
    category: 'status-graphic',
    group: 'false-positive',
    profile,
    background: '#ffffff',
    src: url(`status-${id}.png`),
    resource: disc(blank(20, 20), 10, 10, 9, hex(color)),
    attrs,
    expect: { action: 'unchanged', reason: 'status-defers-to-semantics', kind: 'status-graphic' },
  });
  return [
    make('red', '#d62728', { class: 'status error', alt: 'Offline' }, D),
    make('green', '#2ca02c', { class: 'status ok', alt: 'Online' }, D),
    make('traffic-red', '#c92a2a', { class: 'traffic-status', alt: 'x' }, P),
    make('traffic-green', '#2f9e44', { class: 'traffic-status', alt: 'x' }, P),
    make('warning-amber', '#f08c00', { class: 'warning-badge', alt: 'Warning' }, T),
    make('error-russian', '#d62728', { alt: 'Ошибка сети' }, D),
    make('success', '#2ca02c', { alt: 'success' }, D),
    make('status-context', '#d62728', { alt: 'x' }, D),
  ].map((scenario, index) =>
    index === 7
      ? {
          ...scenario,
          wrapper: { tag: 'div' as const, className: 'status-cell' },
          expect: { action: 'unchanged' as const },
        }
      : scenario,
  );
}

function diagrams(): ImageScenario[] {
  const make = (
    id: string,
    resource: PixelBuffer,
    attrs: Record<string, string>,
    profile: VisionProfile,
    expectation: ImageScenario['expect'],
  ): ImageScenario => ({
    id: `diagram-${id}`,
    category: 'diagram',
    group: 'other',
    profile,
    background: '#ffffff',
    src: url(`diagram-${id}.png`),
    resource,
    attrs,
    expect: expectation,
  });
  const unsupported: ImageScenario['expect'] = { action: 'unsupported' };
  return [
    make(
      'two-region-token',
      twoRegion(hex('#d62728'), hex('#2ca02c')),
      { alt: 'Process diagram' },
      D,
      {
        action: 'unsupported',
        reason: 'diagram',
      },
    ),
    make(
      'two-region-flowchart',
      twoRegion(hex('#c92a2a'), hex('#2f9e44')),
      { alt: 'Flowchart' },
      P,
      unsupported,
    ),
    make(
      'two-region-no-tokens',
      twoRegion(hex('#d62728'), hex('#2ca02c')),
      { alt: 'Legend of regions' },
      D,
      unsupported,
    ),
    make(
      'two-region-russian',
      twoRegion(hex('#d62728'), hex('#2ca02c')),
      { alt: 'Схема процесса' },
      D,
      unsupported,
    ),
    make('plain-two-region', twoRegion(hex('#e64980'), hex('#f08c00')), { alt: 'Regions' }, T, {
      action: 'unchanged',
    }),
    make(
      'legend-swatches',
      twoRegion(hex('#1971c2'), hex('#f08c00')),
      { alt: 'Legend' },
      D,
      unsupported,
    ),
  ];
}

function charts(): ImageScenario[] {
  const make = (
    id: string,
    resource: PixelBuffer,
    attrs: Record<string, string>,
    profile: VisionProfile,
    natural?: { width: number; height: number },
    expectation: ImageScenario['expect'] = {
      action: 'unsupported',
      reason: 'chart-raster',
      kind: 'chart-raster',
    },
  ): ImageScenario => ({
    id: `chart-${id}`,
    category: 'raster-chart',
    group: 'false-positive',
    profile,
    background: '#ffffff',
    src: url(`chart-${id}.png`),
    resource,
    ...(natural ? { natural } : {}),
    attrs,
    expect: expectation,
  });
  const rg = [hex('#d62728'), hex('#2ca02c'), hex('#1f77b4')];
  return [
    make('bar-token', rasterBarChart(240, 140, rg), { alt: 'Quarterly sales chart' }, D),
    make('bar-class', rasterBarChart(240, 140, rg), { class: 'chart', alt: 'Sales' }, D),
    make('bar-structure-only', rasterBarChart(260, 150, rg), { alt: 'Sales by region' }, D),
    make(
      'bar-protan',
      rasterBarChart(240, 140, [hex('#e03131'), hex('#5c7c2b'), hex('#862e9c')]),
      { alt: 'graph' },
      P,
    ),
    make(
      'bar-tritan',
      rasterBarChart(240, 140, [hex('#3b6fb6'), hex('#2aa198'), hex('#fab005')]),
      { alt: 'chart' },
      T,
    ),
    make(
      'line-token',
      rasterLineChart([hex('#d62728'), hex('#2ca02c')]),
      { alt: 'Visitors graph' },
      D,
    ),
    make(
      'line-structure-only',
      rasterLineChart([hex('#d62728'), hex('#2ca02c'), hex('#1f77b4')]),
      { alt: 'Visitors' },
      D,
      undefined,
      // Thin lines are too little of the image for structure alone to name it a chart: not detected, but untouched all the same.
      { action: 'unchanged', reason: 'illustration' },
    ),
    make(
      'line-russian',
      rasterLineChart([hex('#d62728'), hex('#2ca02c')]),
      { alt: 'График посещений' },
      D,
    ),
    make(
      'pie-token',
      rasterPie([hex('#d62728'), hex('#2ca02c'), hex('#1f77b4')]),
      { alt: 'Share chart' },
      D,
    ),
    make(
      'pie-structure-only',
      rasterPie([hex('#e8590c'), hex('#5c940d'), hex('#364fc7')]),
      { alt: 'Share' },
      D,
    ),
    make('bar-large', rasterBarChart(240, 140, rg), { alt: 'Annual chart' }, D, {
      width: 1200,
      height: 700,
    }),
    make('bar-small-legend-only', rasterBarChart(160, 100, rg), { alt: 'chart legend' }, P),
  ];
}

function screenshots(): ImageScenario[] {
  const make = (
    id: string,
    seed: number,
    w: number,
    h: number,
    attrs: Record<string, string>,
    profile: VisionProfile,
  ): ImageScenario => ({
    id: `screenshot-${id}`,
    category: 'screenshot',
    group: 'false-positive',
    profile,
    background: '#ffffff',
    src: url(`screenshot-${id}.png`),
    resource: screenshot(w, h, seed),
    attrs,
    expect: { action: 'unchanged' },
  });
  return [
    make('app-token', 1, 640, 360, { alt: 'Screenshot of the dashboard' }, D),
    make('app-class', 2, 480, 300, { alt: 'Dashboard', class: 'screenshot' }, D),
    make('app-plain', 3, 640, 360, { alt: 'The settings page' }, P),
    make('mobile', 4, 320, 560, { alt: 'Mobile view' }, T),
    make('wide', 5, 800, 300, { alt: 'Editor' }, D),
    make('russian', 6, 640, 360, { alt: 'Скриншот приложения' }, D),
    make('mixed-photo', 7, 520, 340, { alt: 'Gallery screenshot' }, P),
    make('terminal', 8, 560, 320, { alt: 'Terminal' }, D),
  ];
}

function crossOrigin(): ImageScenario[] {
  const icon = monoIcon(24, hex('#d62728'), false);
  const make = (
    id: string,
    resource: Resource,
    attrs: Record<string, string>,
    expectation: ImageScenario['expect'],
    group: Group = 'other',
  ): ImageScenario => ({
    id: `cross-origin-${id}`,
    category: resource === 'tainted' ? 'cross-origin-unreadable' : 'same-origin-readable',
    group,
    profile: D,
    background: '#2ca02c',
    src: `http://cdn.example/${id}.png`,
    resource,
    attrs,
    expect: expectation,
  });
  const tainted: ImageScenario['expect'] = { action: 'unsupported', reason: 'unreadable' };
  return [
    make('icon-no-cors', 'tainted', { class: 'icon', alt: 'Alert' }, tainted),
    make('photo-no-cors', 'tainted', { alt: 'Photo' }, tainted, 'false-positive'),
    make('chart-no-cors', 'tainted', { alt: 'Sales chart' }, tainted),
    make('logo-no-cors', 'tainted', { alt: 'Acme logo' }, tainted, 'false-positive'),
    make('status-no-cors', 'tainted', { class: 'status error', alt: 'x' }, tainted),
    make(
      'broken-cdn',
      'unavailable',
      { class: 'icon', alt: 'Alert' },
      { action: 'unsupported', reason: 'unavailable' },
    ),
    make(
      'icon-with-cors',
      icon,
      { class: 'icon', alt: 'Alert', crossorigin: 'anonymous' },
      { action: 'pixel-adapted', reason: 'adapted' },
      'supported',
    ),
    make(
      'icon-cors-use-credentials',
      icon,
      { class: 'icon', alt: 'Alert', crossorigin: 'use-credentials' },
      { action: 'pixel-adapted', reason: 'adapted' },
      'supported',
    ),
  ];
}

function animated(): ImageScenario[] {
  const icon = monoIcon(24, hex('#d62728'), false);
  const base = (
    id: string,
    src: string,
    attrs: Record<string, string>,
    expectation: ImageScenario['expect'],
    bytes?: Uint8Array,
  ): ImageScenario => ({
    id: `animated-${id}`,
    category: 'animated',
    group: 'other',
    profile: D,
    background: '#2ca02c',
    src,
    resource: icon,
    attrs,
    ...(bytes ? { bytes } : {}),
    expect: expectation,
  });
  return [
    base(
      'gif-extension',
      url('spinner.gif'),
      { class: 'icon', alt: 'Loading' },
      { action: 'unsupported', reason: 'animated' },
    ),
    base(
      'png-bytes-gif',
      url('looks-like-png.png'),
      { class: 'icon', alt: 'Loading' },
      { action: 'unsupported', reason: 'animated' },
      GIF_TWO_FRAMES,
    ),
    base(
      'svg-through-img',
      url('icon.svg'),
      { class: 'icon', alt: 'Alert' },
      { action: 'unsupported', reason: 'svg-source' },
    ),
    base(
      'svg-data-url',
      'data:image/svg+xml;utf8,%3Csvg%2F%3E',
      { class: 'icon', alt: 'Alert' },
      { action: 'unsupported', reason: 'svg-source' },
    ),
  ];
}

function large(): ImageScenario[] {
  const make = (
    id: string,
    natural: { width: number; height: number },
    resource: PixelBuffer,
    attrs: Record<string, string>,
    expectation: ImageScenario['expect'],
  ): ImageScenario => ({
    id: `large-${id}`,
    category: 'large-image',
    group: 'false-positive',
    profile: D,
    background: '#2ca02c',
    src: url(`large-${id}.jpg`),
    resource,
    natural,
    attrs,
    expect: expectation,
  });
  return [
    make(
      'photo-4k',
      { width: 3840, height: 2160 },
      photograph(160, 90, 31),
      { alt: 'City' },
      { action: 'unchanged', reason: 'photograph' },
    ),
    make(
      'photo-12mp',
      { width: 4000, height: 3000 },
      photograph(160, 120, 32),
      { alt: 'Beach' },
      { action: 'unchanged', reason: 'photograph' },
    ),
    make(
      'absurd',
      { width: 9000, height: 9000 },
      photograph(90, 90, 33),
      { alt: 'Panorama' },
      { action: 'unsupported', reason: 'too-large' },
    ),
    make(
      'flat-large-icon-like',
      { width: 600, height: 600 },
      monoIcon(60, hex('#d62728'), false),
      { class: 'icon', alt: 'Big icon' },
      { action: 'unchanged', reason: 'illustration' },
    ),
  ];
}

function transparent(): ImageScenario[] {
  const make = (
    id: string,
    resource: PixelBuffer,
    attrs: Record<string, string>,
    profile: VisionProfile,
    expectation: ImageScenario['expect'],
    group: Group = 'other',
    background = '#2ca02c',
  ): ImageScenario => ({
    id: `transparent-${id}`,
    category: 'transparent-png',
    group,
    profile,
    background,
    src: url(`transparent-${id}.png`),
    resource,
    attrs,
    expect: expectation,
  });
  const faint = blank(24, 24);
  disc(faint, 12, 12, 10, [214, 39, 40, 200]);
  return [
    make(
      'sticker-multicolor',
      sticker(),
      { alt: 'Sticker', class: 'icon' },
      D,
      { action: 'unchanged', reason: 'ui-raster' },
      'false-positive',
    ),
    make('semi-transparent', faint, { class: 'icon', alt: 'Alert' }, D, {
      action: 'unsupported',
      reason: 'insufficient-context',
    }),
    make(
      'on-dark',
      monoIcon(24, hex('#d62728'), false),
      { class: 'icon', alt: 'Alert' },
      D,
      { action: 'not-needed' },
      'other',
      '#202020',
    ),
    make(
      'on-light',
      monoIcon(24, hex('#d62728'), false),
      { class: 'icon', alt: 'Alert' },
      D,
      { action: 'not-needed' },
      'other',
      '#ffffff',
    ),
    make(
      'on-olive',
      monoIcon(24, hex('#d62728'), false),
      { class: 'icon', alt: 'Alert' },
      D,
      { action: 'pixel-adapted' },
      'supported',
      '#6b8e23',
    ),
    make(
      'no-functional-context',
      monoIcon(24, hex('#d62728'), false),
      {},
      D,
      { action: 'unchanged', reason: 'low-confidence' },
      'false-positive',
    ),
  ];
}

function presentation(): ImageScenario[] {
  const icon = monoIcon(24, hex('#d62728'), false);
  const make = (
    id: string,
    attrs: Record<string, string>,
    expectation: ImageScenario['expect'],
  ): ImageScenario => ({
    id: `presentation-${id}`,
    category: 'presentation',
    group: 'other',
    profile: D,
    background: '#2ca02c',
    src: url(`p-${id}.png`),
    resource: icon,
    attrs,
    expect: expectation,
  });
  return [
    make(
      'srcset',
      {
        class: 'icon',
        alt: 'Alert',
        srcset: `${url('p-srcset.png')} 1x, ${url('p-srcset.png')} 2x`,
      },
      { action: 'unsupported', reason: 'responsive-source' },
    ),
    make(
      'sizes',
      { class: 'icon', alt: 'Alert', sizes: '24px' },
      { action: 'unsupported', reason: 'responsive-source' },
    ),
    make(
      'usemap',
      { class: 'icon', alt: 'Alert', usemap: '#m' },
      { action: 'unsupported', reason: 'image-map' },
    ),
    make(
      'css-filter',
      { class: 'icon', alt: 'Alert', style: 'filter: grayscale(1)' },
      { action: 'unsupported', reason: 'css-effects' },
    ),
    make(
      'css-opacity',
      { class: 'icon', alt: 'Alert', style: 'opacity: 0.5' },
      { action: 'unsupported', reason: 'css-effects' },
    ),
    make(
      'css-mask',
      { class: 'icon', alt: 'Alert', style: 'mask-image: linear-gradient(black, transparent)' },
      { action: 'unsupported', reason: 'css-effects' },
    ),
    make(
      'mix-blend',
      { class: 'icon', alt: 'Alert', style: 'mix-blend-mode: multiply' },
      { action: 'unsupported', reason: 'css-effects' },
    ),
  ];
}

const ALL: readonly ImageScenario[] = [
  ...photos(),
  ...logos(),
  ...decoratives(),
  ...supported(),
  ...notNeeded(),
  ...statuses(),
  ...diagrams(),
  ...charts(),
  ...screenshots(),
  ...crossOrigin(),
  ...animated(),
  ...large(),
  ...transparent(),
  ...presentation(),
  ...r1Scenarios(),
];

/**
 * The scenarios' file names carry no tokens (a name like `diagram-x.png` would itself be evidence),
 * except where a scenario is about the file name: `acme-logo.png` keeps its own. Extensions are kept,
 * they are evidence too.
 */
export const IMAGE_SCENARIOS: readonly ImageScenario[] = ALL.map((scenario, index) => {
  if (
    !scenario.src.startsWith(`${ORIGIN}/bench/`) ||
    scenario.src.endsWith('acme-logo.png') ||
    scenario.keepName
  ) {
    return scenario;
  }
  const extension = scenario.src.split('.').pop();
  return { ...scenario, src: url(`i${index}.${extension}`) };
});
