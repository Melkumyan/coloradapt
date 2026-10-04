import type { VisionProfile } from '@domain/models';
import type { PixelBuffer } from '@core/images';
import {
  blank,
  disc,
  hex,
  mulberry32,
  monoIcon,
  photograph,
  rasterBarChart,
  rect,
  screenshot,
  type Rgba,
} from '../core/images/pixels';
import type { ImageScenario } from './image-scenarios';

/**
 * M8.R1 scenarios: the brand/icon boundary (the riskiest classification), harder photographs,
 * duotone artwork, small screenshots, and the exact structural thresholds. Same rules as the
 * M8 file: synthetic pixels, no network; the group says what is expected of the image.
 */
const ORIGIN = 'http://localhost:3000';
const url = (name: string): string => `${ORIGIN}/bench/${name}`;
const D: VisionProfile = 'deuteranopia';
const P: VisionProfile = 'protanopia';
const T: VisionProfile = 'tritanopia';
const GREEN = '#2ca02c';

const RED_MARK = monoIcon(32, hex('#d62728'), false);

function logoTrap(
  id: string,
  attrs: Record<string, string>,
  extra: Partial<ImageScenario> = {},
  resource: PixelBuffer = RED_MARK,
  profile: VisionProfile = D,
): ImageScenario {
  return {
    id: `logo-trap-${id}`,
    category: 'brand-ambiguity',
    group: 'false-positive',
    profile,
    background: GREEN,
    src: url(`trap-${id}.png`),
    resource,
    attrs,
    expect: { action: 'unchanged' },
    ...extra,
  };
}

function logoTraps(): ImageScenario[] {
  return [
    logoTrap('small-mono-brand', { alt: 'Acme' }),
    logoTrap(
      'favicon-like',
      {},
      { src: url('favicon.png'), keepName: true },
      monoIcon(16, hex('#d62728'), false),
    ),
    logoTrap('company-mark-in-button', { alt: 'Acme' }, { wrapper: { tag: 'button' } }),
    logoTrap('brand-icon-in-nav', { class: 'icon', alt: 'Acme' }, { wrapper: { tag: 'nav' } }),
    logoTrap('sponsor-mark', { class: 'sponsor', alt: 'Sponsor' }),
    logoTrap(
      'sponsor-in-list',
      { alt: 'Acme' },
      { wrapper: { tag: 'div', className: 'sponsors' } },
    ),
    logoTrap('brand-avatar', { class: 'avatar', alt: 'Acme avatar' }),
    logoTrap('avatar-with-icon-class', { class: 'icon avatar', alt: 'Delete' }),
    logoTrap('app-logo', { alt: 'App logo' }),
    logoTrap(
      'site-logo-non-empty-alt',
      { alt: 'Acme Corporation' },
      { wrapper: { tag: 'header' } },
    ),
    logoTrap('logo-in-home-link', { alt: 'Acme' }, { wrapper: { tag: 'a', href: '/' } }),
    logoTrap(
      'logo-in-absolute-home-link',
      { class: 'icon', alt: 'Acme' },
      { wrapper: { tag: 'a', href: `${ORIGIN}/index.html` } },
    ),
    logoTrap(
      'logo-in-non-home-link',
      { class: 'icon', alt: 'Acme' },
      { wrapper: { tag: 'a', href: '/about' } },
    ),
    logoTrap('logo-with-icon-class', { class: 'icon', alt: 'Acme' }),
    logoTrap('logo-with-role-img', { role: 'img', class: 'icon', alt: 'Acme' }),
    logoTrap(
      'brand-named-button',
      { class: 'icon' },
      { wrapper: { tag: 'button', attrs: { 'aria-label': 'Acme' } } },
    ),
    logoTrap('brand-directory', {}, { src: url('brand/mark.png'), keepName: true }),
    logoTrap(
      'partner-strip',
      { class: 'icon', alt: 'Partner' },
      { wrapper: { tag: 'div', className: 'partners' } },
    ),
    logoTrap(
      'tritan-brand',
      { alt: 'Acme' },
      { background: '#2aa198' },
      monoIcon(32, hex('#3b6fb6'), false),
      T,
    ),
    logoTrap('protan-brand', { alt: 'Acme' }, {}, monoIcon(32, hex('#e03131'), false), P),
  ];
}

/** Name, colors and pairing for functional icons that DO get adapted. */
const FUNCTIONAL: Array<[string, VisionProfile, string, string, number, string?]> = [
  ['search', D, '#d62728', GREEN, 20, 'button'],
  ['close', D, '#d62728', '#6b8e23', 16, 'button'],
  ['download', P, '#e03131', '#5c7c2b', 24, 'a'],
  ['menu', D, '#e8590c', '#5c940d', 32, 'button'],
  ['settings', T, '#3b6fb6', '#2aa198', 24, 'button'],
  ['notifications', T, '#1864ab', '#0b7285', 20, 'a'],
  ['arrow', D, '#c92a2a', '#2b8a3e', 24],
  ['info', P, '#e03131', '#5c7c2b', 16, 'button'],
  ['delete item', D, '#d9480f', '#74b816', 28, 'button'],
  ['help', T, '#e64980', '#f08c00', 24, 'a'],
];

function functionalIcons(): ImageScenario[] {
  const supported = FUNCTIONAL.map(([name, profile, fg, bg, size, tag], index): ImageScenario => ({
    id: `functional-${name.replace(' ', '-')}-${profile}`,
    category: 'functional-icon',
    group: 'supported',
    profile,
    background: bg,
    src: url(`fn-${index}.png`),
    resource: monoIcon(size, hex(fg), index % 2 === 0),
    attrs: { alt: name[0]!.toUpperCase() + name.slice(1) },
    ...(tag === 'button' ? { wrapper: { tag: 'button' as const } } : {}),
    ...(tag === 'a' ? { wrapper: { tag: 'a' as const, href: '#more' } } : {}),
    expect: { action: 'pixel-adapted', reason: 'adapted', kind: 'monochrome-icon' },
  }));
  // An unnamed icon: the class says it is one.
  supported.push({
    id: 'functional-unnamed-icon-class',
    category: 'functional-icon',
    group: 'supported',
    profile: D,
    background: GREEN,
    src: url('fn-unnamed.png'),
    resource: monoIcon(24, hex('#d62728'), false),
    attrs: { class: 'btn-icon' },
    wrapper: { tag: 'button' },
    expect: { action: 'pixel-adapted', reason: 'adapted', kind: 'monochrome-icon' },
  });
  // Conservative misses: real icons whose names carry no functional word. Not failures.
  const misses: ImageScenario[] = ['Account', 'Wishlist', 'Dark mode'].map(
    (alt, index): ImageScenario => ({
      id: `functional-miss-${alt.toLowerCase().replace(' ', '-')}`,
      category: 'functional-icon',
      group: 'miss',
      profile: D,
      background: GREEN,
      src: url(`fn-miss-${index}.png`),
      resource: monoIcon(24, hex('#d62728'), false),
      attrs: { class: 'icon', alt },
      wrapper: { tag: 'button' },
      expect: { action: 'unchanged', reason: 'low-confidence' },
    }),
  );
  // Status graphics are M6's, not recolored, whatever they are called.
  const status: ImageScenario = {
    id: 'functional-status-icon',
    category: 'status-graphic',
    group: 'false-positive',
    profile: D,
    background: '#ffffff',
    src: url('fn-status.png'),
    resource: disc(blank(20, 20), 10, 10, 9, hex('#d62728')),
    attrs: { class: 'status icon', alt: 'Error' },
    expect: { action: 'unchanged', reason: 'status-defers-to-semantics' },
  };
  return [...supported, ...misses, status];
}

/** Opaque low-entropy photograph: one smooth hue ramp with grain (few dominant colors). */
function lowColorPhoto(width: number, height: number, seed: number): PixelBuffer {
  const random = mulberry32(seed);
  const buffer = blank(width, height, [0, 0, 0, 255]);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = (x + y) / (width + height);
      const grain = (random() - 0.5) * 10;
      buffer.data.set(
        [clamp(190 - 60 * t + grain), clamp(60 + 30 * t + grain), clamp(50 + 20 * t + grain), 255],
        (y * width + x) * 4,
      );
    }
  }
  return buffer;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** A photograph darkened to night levels. */
function nightPhoto(width: number, height: number, seed: number): PixelBuffer {
  const buffer = photograph(width, height, seed);
  for (let i = 0; i < buffer.data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) buffer.data[i + c] = Math.round(buffer.data[i + c]! * 0.22);
  }
  return buffer;
}

/** A photograph pushed to saturated primaries. */
function saturatedPhoto(width: number, height: number, seed: number): PixelBuffer {
  const buffer = photograph(width, height, seed);
  for (let i = 0; i < buffer.data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      buffer.data[i + c] = buffer.data[i + c]! > 128 ? 255 : 20;
    }
  }
  // Grain keeps it photographic after the push.
  const random = mulberry32(seed + 77);
  for (let i = 0; i < buffer.data.length; i += 4) {
    const g = Math.round((random() - 0.5) * 60);
    for (let c = 0; c < 3; c += 1) buffer.data[i + c] = clamp(buffer.data[i + c]! + g);
  }
  return buffer;
}

/** Two tones blended through a diagonal with grain: a duotone photograph. */
function duotonePhoto(width: number, height: number, seed: number, a: Rgba, b: Rgba): PixelBuffer {
  const random = mulberry32(seed);
  const buffer = blank(width, height, [0, 0, 0, 255]);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = Math.min(1, Math.max(0, (x / width + y / height) / 2 + (random() - 0.5) * 0.25));
      buffer.data.set(
        [
          clamp(a[0] + (b[0] - a[0]) * t),
          clamp(a[1] + (b[1] - a[1]) * t),
          clamp(a[2] + (b[2] - a[2]) * t),
          255,
        ],
        (y * width + x) * 4,
      );
    }
  }
  return buffer;
}

/** A product cut-out: a photograph on a transparent ground. */
function cutout(width: number, height: number, seed: number): PixelBuffer {
  const buffer = photograph(width, height, seed);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const d = Math.hypot(x - width / 2, y - height / 2);
      if (d > Math.min(width, height) * 0.38) buffer.data[(y * width + x) * 4 + 3] = 0;
    }
  }
  return buffer;
}

/** Flat two-color artwork on an opaque ground (poster, album cover). */
function duotoneArt(width: number, height: number, a: Rgba, b: Rgba): PixelBuffer {
  const buffer = blank(width, height, a);
  disc(buffer, width / 2, height / 2, Math.min(width, height) / 3, b);
  return buffer;
}

/** Pixel art: a single-color glyph on transparent, hard edges. */
function pixelArt(color: Rgba): PixelBuffer {
  const buffer = blank(16, 16);
  const rows = ['..##..##..', '.########.', '.########.', '..######..', '...####...', '....##....'];
  rows.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      if (cell === '#') rect(buffer, 3 + x, 4 + y, 1, 1, color);
    });
  });
  return buffer;
}

function photoMake(
  id: string,
  resource: PixelBuffer,
  attrs: Record<string, string>,
  profile: VisionProfile,
  background = GREEN,
): ImageScenario {
  return {
    id: `photo-r1-${id}`,
    category: 'photograph',
    group: 'false-positive',
    profile,
    background,
    src: url(`photo-r1-${id}.jpg`),
    resource,
    attrs,
    expect: { action: 'unchanged' },
  };
}

function photosR1(): ImageScenario[] {
  return [
    photoMake('night', nightPhoto(160, 100, 21), { alt: 'City at night' }, D),
    photoMake('saturated', saturatedPhoto(128, 128, 22), { alt: 'Parrot' }, P),
    photoMake('low-color', lowColorPhoto(120, 90, 23), { alt: 'Sunset gradient' }, D),
    photoMake('low-color-small', lowColorPhoto(48, 48, 24), { alt: 'Sunset' }, T),
    photoMake(
      'duotone-photo',
      duotonePhoto(140, 100, 25, hex('#c92a2a'), hex('#2b8a3e')),
      { alt: 'Duotone portrait' },
      D,
    ),
    photoMake(
      'duotone-photo-tritan',
      duotonePhoto(140, 100, 26, hex('#3b6fb6'), hex('#2aa198')),
      { alt: 'Sea' },
      T,
    ),
    photoMake('cutout', cutout(96, 96, 27), { alt: 'Sneaker' }, D),
    photoMake('cutout-icon-class', cutout(64, 64, 28), { alt: 'Sneaker', class: 'icon' }, D),
    photoMake('minimal', lowColorPhoto(100, 100, 29), { alt: 'Minimal' }, P),
    photoMake('portrait-tall', photograph(80, 140, 30), { alt: 'Portrait' }, T),
    photoMake('landscape-wide', photograph(200, 80, 31), { alt: 'Landscape' }, P),
    photoMake('food', photograph(120, 120, 32), { alt: 'Pasta' }, P),
    photoMake('product', photograph(100, 100, 33), { alt: 'Red lamp' }, T),
    photoMake('architecture', photograph(130, 90, 34), { alt: 'Bridge' }, D),
  ];
}

function artwork(): ImageScenario[] {
  const make = (
    id: string,
    resource: PixelBuffer,
    attrs: Record<string, string>,
    profile: VisionProfile = D,
  ): ImageScenario => ({
    id: `artwork-${id}`,
    category: 'artwork',
    group: 'false-positive',
    profile,
    background: GREEN,
    src: url(`art-${id}.png`),
    resource,
    attrs,
    expect: { action: 'unchanged' },
  });
  return [
    make('poster', duotoneArt(180, 240, hex('#d62728'), hex('#f1f3f5')), { alt: 'Event poster' }),
    make(
      'album-cover',
      duotoneArt(128, 128, hex('#1971c2'), hex('#f08c00')),
      { alt: 'Album cover' },
      T,
    ),
    make(
      'illustration',
      duotoneArt(160, 100, hex('#e8590c'), hex('#5c940d')),
      { alt: 'Illustration' },
      P,
    ),
    make('pixel-art', pixelArt(hex('#d62728')), { alt: 'Pixel heart' }),
    make('pixel-art-icon-class', pixelArt(hex('#d62728')), { alt: 'Pixel heart', class: 'icon' }),
    make(
      'sticker-duotone',
      (() => {
        const b = blank(64, 64);
        disc(b, 32, 32, 28, hex('#e8590c'));
        disc(b, 32, 32, 12, hex('#2b8a3e'));
        return b;
      })(),
      { alt: 'Sticker' },
    ),
    make('ad-creative', duotoneArt(300, 250, hex('#c92a2a'), hex('#2b8a3e')), {
      alt: 'Sale',
      class: 'ad',
    }),
  ];
}

function screenshotsR1(): ImageScenario[] {
  const make = (
    id: string,
    resource: PixelBuffer,
    attrs: Record<string, string>,
    profile: VisionProfile = D,
  ): ImageScenario => ({
    id: `screenshot-${id}`,
    category: 'screenshot',
    group: 'false-positive',
    profile,
    background: '#ffffff',
    src: url(`shot-${id}.png`),
    resource,
    attrs,
    expect: { action: 'unchanged' },
  });
  return [
    make('small-settings', screenshot(120, 90, 41), { alt: 'Settings screen' }),
    make('small-status-panel', screenshot(96, 64, 42), { alt: 'Status panel' }, P),
    make('cropped-ui', screenshot(128, 128, 43), { alt: 'Cropped toolbar' }, T),
    make('token', screenshot(200, 150, 44), { alt: 'Screenshot of the dashboard' }),
  ];
}

// -- thresholds ---------------------------------------------------------------------------------

/** `rows` fully transparent rows on top of a 25x20 opaque colored block (transparency = rows * 5%). */
function transparencyBlock(rows: number): PixelBuffer {
  const buffer = blank(25, 20);
  rect(buffer, 0, rows, 25, 20 - rows, hex('#d62728'));
  return buffer;
}

function boundaries(): ImageScenario[] {
  const icon = (
    id: string,
    resource: PixelBuffer,
    expectation: ImageScenario['expect'],
    group: ImageScenario['group'],
    natural?: { width: number; height: number },
  ): ImageScenario => ({
    id: `boundary-${id}`,
    category: 'boundary',
    group,
    profile: D,
    background: GREEN,
    src: url(`bound-${id}.png`),
    resource,
    ...(natural ? { natural } : {}),
    attrs: { class: 'icon', alt: 'Alert' },
    expect: expectation,
  });
  const adapted: ImageScenario['expect'] = { action: 'pixel-adapted', reason: 'adapted' };
  const kept: ImageScenario['expect'] = { action: 'unchanged' };

  const twoColors = blank(32, 32);
  disc(twoColors, 16, 16, 15, hex('#d62728'));
  rect(twoColors, 4, 4, 12, 24, hex('#1971c2'));
  const noiseSecond = monoIcon(32, hex('#d62728'), false);
  // Four stray pixels of another hue (below the noise share): a fringe, not a color.
  for (let i = 0; i < 4; i += 1) rect(noiseSecond, 14 + i, 16, 1, 1, hex('#1971c2'));
  const antiAlias = monoIcon(32, hex('#d62728'), false);
  // A soft inner ring of nearby shades: antialiasing, not a second color.
  disc(antiAlias, 16, 16, 9, hex('#c92a2a'));

  return [
    icon('size-127', monoIcon(127, hex('#d62728'), false), adapted, 'supported'),
    icon('size-128', monoIcon(128, hex('#d62728'), false), adapted, 'supported'),
    icon('size-129', monoIcon(129, hex('#d62728'), false), kept, 'false-positive'),
    icon('transparency-10pct', transparencyBlock(2), kept, 'false-positive'),
    icon('transparency-15pct', transparencyBlock(3), adapted, 'supported'),
    icon('transparency-20pct', transparencyBlock(4), adapted, 'supported'),
    icon('two-meaningful-colors', twoColors, kept, 'false-positive'),
    icon('noise-second-cluster', noiseSecond, adapted, 'supported'),
    icon('anti-alias-shades', antiAlias, adapted, 'supported'),
  ];
}

function responsiveR1(): ImageScenario[] {
  const make = (
    id: string,
    attrs: Record<string, string>,
    wrapper?: ImageScenario['wrapper'],
  ): ImageScenario => ({
    id: `responsive-${id}`,
    category: 'responsive',
    group: 'other',
    profile: D,
    background: GREEN,
    src: url(`resp-${id}.png`),
    resource: monoIcon(24, hex('#d62728'), false),
    attrs,
    ...(wrapper ? { wrapper } : {}),
    expect: { action: 'unsupported', reason: 'responsive-source' },
  });
  return [
    make('picture', { class: 'icon', alt: 'Alert' }, { tag: 'picture' }),
    make('srcset-density', {
      class: 'icon',
      alt: 'Alert',
      srcset: `${url('resp-a.png')} 1x, ${url('resp-b.png')} 2x`,
    }),
    make('srcset-width', {
      class: 'icon',
      alt: 'Alert',
      srcset: `${url('resp-a.png')} 100w, ${url('resp-b.png')} 200w`,
      sizes: '24px',
    }),
    make('picture-in-button', { class: 'icon', alt: 'Close' }, { tag: 'picture' }),
  ];
}

function raster(): ImageScenario[] {
  const make = (
    id: string,
    resource: PixelBuffer,
    attrs: Record<string, string>,
    profile: VisionProfile,
  ): ImageScenario => ({
    id: `chart-r1-${id}`,
    category: 'raster-chart',
    group: 'false-positive',
    profile,
    background: '#ffffff',
    src: url(`chartr1-${id}.png`),
    resource,
    attrs,
    expect: { action: 'unsupported', reason: 'chart-raster' },
  });
  const rg = [hex('#d62728'), hex('#2ca02c')];
  return [
    make('small-bar', rasterBarChart(130, 90, rg), { alt: 'Bar chart' }, D),
    make(
      'wide-bar',
      rasterBarChart(300, 140, [...rg, hex('#1f77b4')]),
      { alt: 'Revenue graph' },
      P,
    ),
    make(
      'tritan-bar',
      rasterBarChart(220, 140, [hex('#3b6fb6'), hex('#2aa198')]),
      { alt: 'chart' },
      T,
    ),
  ];
}

export function r1Scenarios(): ImageScenario[] {
  return [
    ...logoTraps(),
    ...functionalIcons(),
    ...photosR1(),
    ...artwork(),
    ...screenshotsR1(),
    ...boundaries(),
    ...responsiveR1(),
    ...raster(),
  ];
}
