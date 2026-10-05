/**
 * The local fixture server of the M10 scenario suites: pages a test generates, served over real HTTP so the
 * extension's content script runs on them exactly as on the web. One server answers on two hostnames
 * (`127.0.0.1` and `localhost`), which are two different origins: that is how cross-origin iframes are tested.
 */
import { createServer, type Server } from 'node:http';
import { deflateSync } from 'node:zlib';

export interface Served {
  readonly body: Buffer | string;
  readonly type: string;
  readonly headers: Record<string, string>;
  readonly status: number;
}

export interface FixtureServer {
  /** `http://127.0.0.1:<port>` */
  readonly origin: string;
  /** `http://localhost:<port>`: another origin, same server. */
  readonly altOrigin: string;
  serve(name: string, html: string, headers?: Record<string, string>, status?: number): void;
  serveRaw(
    name: string,
    body: Buffer | string,
    type: string,
    headers?: Record<string, string>,
  ): void;
  /** Requests received for `/<name>`. */
  hits(name: string): number;
  /** Bodies of the POST requests received for `/<name>` (CSP reports). */
  bodies(name: string): string[];
  /** Every request path received, in order (to prove the extension caused no network traffic). */
  requests(): string[];
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const pages = new Map<string, Served>();
  const counts = new Map<string, number>();
  const log: string[] = [];
  const posted = new Map<string, string[]>();
  const server: Server = createServer((req, res) => {
    const raw = (req.url ?? '/').split('?')[0]!;
    const name = raw.replace(/^\/+/, '') || 'index.html';
    counts.set(name, (counts.get(name) ?? 0) + 1);
    log.push(`${req.method} ${req.url}`);
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => posted.set(name, [...(posted.get(name) ?? []), body]));
    }
    const page = pages.get(name) ?? pages.get(`${name}.html`);
    if (!page) {
      // SPA fixtures answer every `/spa/*` path with the same document (history-API routes).
      const spa = pages.get(`${name.split('/')[0]}/*`);
      if (spa) {
        res.writeHead(spa.status, { 'content-type': spa.type, ...spa.headers });
        res.end(spa.body);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(page.status, { 'content-type': page.type, ...page.headers });
    res.end(page.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no server address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    altOrigin: `http://localhost:${address.port}`,
    serve: (name, html, headers = {}, status = 200) => {
      pages.set(name, { body: html, type: 'text/html; charset=utf-8', headers, status });
    },
    serveRaw: (name, body, type, headers = {}) => {
      pages.set(name, { body, type, headers, status: 200 });
    },
    hits: (name) => counts.get(name) ?? 0,
    bodies: (name) => posted.get(name) ?? [],
    requests: () => [...log],
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// A tiny PNG encoder for raster fixtures (solid shapes and a 3x5 pixel font for text embedded in an image).
// ---------------------------------------------------------------------------------------------------------

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export type Pixel = readonly [number, number, number, number];

/** RGBA PNG from a pixel function. */
export function png(width: number, height: number, pixel: (x: number, y: number) => Pixel): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], y * (width * 4 + 1) + 1 + x * 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const solidPng = (w: number, h: number, c: readonly [number, number, number]): Buffer =>
  png(w, h, () => [c[0], c[1], c[2], 255]);

/** A transparent PNG with a filled disc (an icon), colored `c`. */
export const discPng = (size: number, c: readonly [number, number, number]): Buffer =>
  png(size, size, (x, y) => {
    const d = Math.hypot(x - size / 2, y - size / 2);
    return d < size / 2 - 1 ? [c[0], c[1], c[2], 255] : [0, 0, 0, 0];
  });

/** Pixel-font glyphs (3x5) for the digits and a few letters: "text embedded in an image". */
const GLYPHS: Record<string, string> = {
  A: '010101111101101',
  B: '110101110101110',
  C: '011100100100011',
  E: '111100110100111',
  L: '100100100100111',
  O: '010101101101010',
  S: '011100010001110',
  T: '111010010010010',
  '0': '111101101101111',
  '1': '010110010010111',
  '2': '110001010100111',
  '5': '111100110001110',
  '%': '101001010100101',
  ' ': '000000000000000',
};

/** `text` drawn at scale `s` in `fg` on `bg`: a banner image whose words only exist as pixels. */
export function textPng(
  text: string,
  scale: number,
  fg: readonly [number, number, number],
  bg: readonly [number, number, number],
): Buffer {
  const width = (text.length * 4 + 1) * scale;
  const height = 7 * scale;
  return png(width, height, (x, y) => {
    const gx = Math.floor(x / scale);
    const gy = Math.floor(y / scale) - 1;
    const index = Math.floor(gx / 4);
    const glyph = GLYPHS[text[index] ?? ' '] ?? GLYPHS[' ']!;
    const inGlyph = gx % 4 < 3 && gy >= 0 && gy < 5 && glyph[gy * 3 + (gx % 4)] === '1';
    const c = inGlyph ? fg : bg;
    return [c[0], c[1], c[2], 255];
  });
}
