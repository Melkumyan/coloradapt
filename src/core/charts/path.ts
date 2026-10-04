/** Longest path text read; a longer one is not parsed (its stats say "huge, curved"). */
const MAX_PATH_LENGTH = 200_000;

export interface PathStats {
  /** End points of the segments (the first `M` counts): what a marker would be drawn at. */
  readonly vertices: number;
  readonly arcCount: number;
  readonly closed: boolean;
  /** Only horizontal and vertical movement. */
  readonly rectilinear: boolean;
}

const COMMAND = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;

const PARAMS: Readonly<Record<string, number>> = {
  m: 2,
  l: 2,
  h: 1,
  v: 1,
  c: 6,
  s: 4,
  q: 4,
  t: 2,
  a: 7,
  z: 0,
};

function numbersIn(text: string): number[] {
  const found = text.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi);
  return found ? found.map(Number) : [];
}

/**
 * Counts what the path's `d` draws, without drawing it: vertices (where a `marker-mid` would
 * be), arcs (pie slices have them), whether it closes, and whether every segment is horizontal
 * or vertical (axes, steps, gridlines). Lenient: unreadable text gives zero vertices.
 */
export function pathStats(d: string): PathStats {
  if (d.length > MAX_PATH_LENGTH) {
    return { vertices: MAX_PATH_LENGTH, arcCount: 0, closed: false, rectilinear: false };
  }
  let vertices = 0;
  let arcCount = 0;
  let rectilinear = true;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  const closed = /[zZ]\s*$/.test(d);

  for (const match of d.matchAll(COMMAND)) {
    const command = match[1] as string;
    const lower = command.toLowerCase();
    const relative = command === lower;
    const values = numbersIn(match[2] ?? '');
    const size = PARAMS[lower] ?? 0;
    if (lower === 'z') {
      x = startX;
      y = startY;
      continue;
    }
    if (size === 0) continue;
    const count = Math.floor(values.length / size);
    for (let i = 0; i < count; i += 1) {
      const chunk = values.slice(i * size, (i + 1) * size);
      vertices += 1;
      const toX = (value: number) => (relative ? x + value : value);
      const toY = (value: number) => (relative ? y + value : value);
      let nextX = x;
      let nextY = y;
      switch (lower) {
        case 'm':
        case 'l':
          nextX = toX(chunk[0] ?? 0);
          nextY = toY(chunk[1] ?? 0);
          // A move starts a subpath and a line after it must be axis-aligned to count as rectilinear.
          if (lower === 'l' || i > 0) {
            if (Math.abs(nextX - x) > 0.01 && Math.abs(nextY - y) > 0.01) rectilinear = false;
          }
          if (lower === 'm' && i === 0) {
            startX = nextX;
            startY = nextY;
          }
          break;
        case 'h':
          nextX = toX(chunk[0] ?? 0);
          break;
        case 'v':
          nextY = toY(chunk[0] ?? 0);
          break;
        default:
          rectilinear = false;
          nextX = toX(chunk[size - 2] ?? 0);
          nextY = toY(chunk[size - 1] ?? 0);
          if (lower === 'a') arcCount += 1;
      }
      x = nextX;
      y = nextY;
    }
  }
  return { vertices, arcCount, closed, rectilinear };
}

/** Number of points in a `points` attribute (polyline/polygon). */
export function pointsCount(points: string): number {
  return Math.floor(numbersIn(points).length / 2);
}
