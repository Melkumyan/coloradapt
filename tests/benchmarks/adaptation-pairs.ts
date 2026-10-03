/**
 * Deterministic benchmark palette for the Adaptation Engine
 * (docs/ADAPTATION_ENGINE.md, "Benchmark methodology").
 *
 * Representative foreground/background pairs, grouped by the kind of color
 * confusion they exercise. Not every pair needs adaptation: accessible pairs
 * (e.g. red on white) are in the set on purpose, to prove they stay untouched.
 * Hand-picked, fixed hex values — no randomness, no network, no screenshots.
 * This is a regression/diagnostic set, not a product KPI and not a claim
 * about what real pages contain.
 */
export type PairCategory =
  | 'red-green'
  | 'green-brown'
  | 'blue-purple'
  | 'cyan-gray'
  | 'yellow-light-green'
  | 'red-black'
  | 'red-white'
  | 'green-white'
  | 'orange-green'
  | 'purple-blue'
  | 'muted-ui'
  | 'pastel'
  | 'dark-mode'
  | 'near-neutral'
  | 'brand-saturated';

export interface BenchmarkPair {
  readonly id: string;
  readonly category: PairCategory;
  /** Text color, `#rrggbb`. */
  readonly foreground: string;
  /** Solid background, `#rrggbb`. */
  readonly background: string;
}

function pairs(category: PairCategory, list: ReadonlyArray<readonly [string, string]>) {
  return list.map(([foreground, background], index): BenchmarkPair => ({
    id: `${category}-${index + 1}`,
    category,
    foreground,
    background,
  }));
}

export const ADAPTATION_PAIRS: readonly BenchmarkPair[] = [
  ...pairs('red-green', [
    ['#c0392b', '#27ae60'],
    ['#e74c3c', '#2ecc71'],
    ['#d32f2f', '#388e3c'],
    ['#b71c1c', '#1b5e20'],
  ]),
  ...pairs('green-brown', [
    ['#2e8b57', '#8b6914'],
    ['#556b2f', '#8b4513'],
    ['#6b8e23', '#a0522d'],
  ]),
  ...pairs('blue-purple', [
    ['#3366cc', '#8844aa'],
    ['#1565c0', '#6a1b9a'],
    ['#5c6bc0', '#7e57c2'],
  ]),
  ...pairs('cyan-gray', [
    ['#20a0a0', '#808080'],
    ['#00acc1', '#9e9e9e'],
    ['#26c6da', '#757575'],
  ]),
  ...pairs('yellow-light-green', [
    ['#d4c400', '#8fd14f'],
    ['#f9a825', '#aed581'],
    ['#fdd835', '#c5e1a5'],
  ]),
  ...pairs('red-black', [
    ['#cc0000', '#000000'],
    ['#e53935', '#121212'],
    ['#8b0000', '#000000'],
  ]),
  ...pairs('red-white', [
    ['#ff0000', '#ffffff'],
    ['#d32f2f', '#ffffff'],
    ['#ef9a9a', '#ffffff'],
  ]),
  ...pairs('green-white', [
    ['#00aa00', '#ffffff'],
    ['#2e7d32', '#ffffff'],
    ['#a5d6a7', '#ffffff'],
  ]),
  ...pairs('orange-green', [
    ['#ef6c00', '#2e7d32'],
    ['#ff9800', '#4caf50'],
    ['#e65100', '#1b5e20'],
  ]),
  ...pairs('purple-blue', [
    ['#7b1fa2', '#1976d2'],
    ['#9c27b0', '#2196f3'],
    ['#6a1b9a', '#0d47a1'],
  ]),
  ...pairs('muted-ui', [
    ['#7a8b8b', '#8b7a7a'],
    ['#8a9a5b', '#9a8a5b'],
    ['#5f7f7f', '#7f5f5f'],
  ]),
  ...pairs('pastel', [
    ['#ffb3ba', '#baffc9'],
    ['#bae1ff', '#ffffba'],
    ['#e6ccff', '#ccffe6'],
  ]),
  ...pairs('dark-mode', [
    ['#ff6b6b', '#1e1e1e'],
    ['#69db7c', '#212529'],
    ['#4dabf7', '#1a1b1e'],
    ['#ffa94d', '#2b2b2b'],
  ]),
  ...pairs('near-neutral', [
    ['#8a8a8a', '#858585'],
    ['#777b7a', '#7a7677'],
    ['#9a9a9c', '#9c9a9a'],
  ]),
  ...pairs('brand-saturated', [
    ['#e60012', '#00a651'],
    ['#1da1f2', '#e1306c'],
    ['#ff4500', '#0079d3'],
    ['#25d366', '#128c7e'],
    ['#ea4335', '#34a853'],
  ]),
];
