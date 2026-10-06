// @vitest-environment node
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalSemanticProvider,
  buildProviderRequest,
  parseLoopbackEndpoint,
  type FetchLike,
} from '@core/semantic-ai';
import { ACTIVE_TAB, answer, bound, supporters } from './kit';

/**
 * M11.R1: the network boundary, hostile corpus first (docs/AI_PRIVACY.md, "Network"). The only thing a
 * page-independent configuration may reach is the machine's own loopback, on the exact spellings
 * `127.0.0.1`, `localhost` and `[::1]`; nothing the URL parser would normalize is accepted, a redirect
 * is never followed, and a response never gets to be larger than the budget.
 */

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

async function serve(
  handler: (url: string, res: ServerResponse) => void,
  host = '127.0.0.1',
): Promise<{ endpoint: string; port: number; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`);
      handler(req.url ?? '', res);
    });
  });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, host, ok));
  const port = (server.address() as AddressInfo).port;
  return { endpoint: `http://127.0.0.1:${port}`, port, seen };
}

const query = bound(ACTIVE_TAB).query;
const good = answer('active', 0.9, supporters(query, 'active'));
const request = buildProviderRequest(query);
const live = () => new AbortController().signal;

describe('endpoint corpus (SSRF and parser confusion)', () => {
  const corpus = [
    // authority confusion
    'http://localhost.evil.com:8080',
    'http://127.0.0.1.evil.com:8080',
    'http://127.0.0.1@evil.com:8080',
    'http://evil.com@127.0.0.1:8080',
    'http://127.0.0.1:8080@evil.com',
    'http://127.0.0.1%40evil.com:8080',
    'http://[::1].evil.com:8080',
    'http://[::1]@evil.com:8080',
    'http://evil.com#@127.0.0.1:8080',
    'http://evil.com?@127.0.0.1:8080',
    'http://evil.com\\@127.0.0.1:8080',
    // numeric spellings the URL parser would normalize
    'http://2130706433:8080',
    'http://0x7f000001:8080',
    'http://0177.0.0.1:8080',
    'http://0177.0000.0000.0001:8080',
    'http://127.1:8080',
    'http://127.0.1:8080',
    'http://127.000.000.001:8080',
    'http://127.0.0.01:8080',
    'http://0x7f.0x0.0x0.0x1:8080',
    'http://[::ffff:127.0.0.1]:8080',
    'http://[::ffff:7f00:1]:8080',
    'http://[0:0:0:0:0:0:0:1]:8080',
    'http://[0000:0000:0000:0000:0000:0000:0000:0001]:8080',
    'http://[::0001]:8080',
    // encoding tricks
    'http://127%2E0%2E0%2E1:8080',
    'http://127.0.0.1%2F@evil.com:8080',
    'http://%6c%6f%63%61%6c%68%6f%73%74:8080',
    'http://%6Cocalhost:8080',
    'http://localhost%00.evil.com:8080',
    'http://localhost%2eevil.com:8080',
    'http://127。0。0。1:8080',
    'http://１２７.０.０.１:8080',
    'http://ⓛocalhost:8080',
    // case, dot, whitespace, control characters
    'http://LOCALHOST:8080',
    'http://LocalHost:8080',
    'http://localhost.:8080',
    'http://127.0.0.1.:8080',
    'http://localhost:8080 ',
    'http://localhost:8080\t',
    'http://localhost:8080\r\nHost: evil.com',
    'http://local​host:8080',
    'http://localhost。evil.com:8080',
    // path, query, fragment, userinfo
    'http://localhost:8080/api',
    'http://localhost:8080/../',
    'http://localhost:8080/%2e%2e/',
    'http://localhost:8080?x',
    'http://localhost:8080#frag',
    'http://user@localhost:8080',
    'http://:pw@localhost:8080',
    'http://localhost:8080:9090',
    'http://localhost::8080',
    // other schemes and shapes
    'https://localhost:8080',
    'ws://localhost:8080',
    'wss://localhost:8080',
    'data:text/plain,http://localhost:8080',
    'blob:http://localhost:8080/x',
    'chrome-extension://abc/x',
    'about:blank',
    'localhost',
    'http:localhost:8080',
    'http:/localhost:8080',
    'http:///localhost:8080',
    'HTTP://localhost:8080',
    // other private / special addresses
    'http://169.254.169.254:8080',
    'http://100.64.0.1:8080',
    'http://[fd00::1]:8080',
    'http://[fc00::1]:8080',
    'http://[::ffff:192.168.0.1]:8080',
    'http://metadata.google.internal:8080',
    'http://host.docker.internal:8080',
    'http://0.0.0.0:8080',
    'http://[::]:8080',
  ];
  it.each(corpus)('rejects %j', (input) => {
    expect(parseLoopbackEndpoint(input).ok).toBe(false);
  });

  it('accepts only the three canonical spellings, with an unprivileged port', () => {
    const accepted: string[] = [];
    for (const host of [
      '127.0.0.1',
      'localhost',
      '[::1]',
      '127.0.0.2',
      'LOCALHOST',
      '[::1]x',
      'example.com',
    ]) {
      for (const port of ['1023', '1024', '11434', '65535', '65536', '01024', '']) {
        const text = `http://${host}${port === '' ? '' : `:${port}`}`;
        if (parseLoopbackEndpoint(text).ok) accepted.push(text);
      }
    }
    expect(accepted.sort()).toEqual(
      [
        'http://127.0.0.1:1024',
        'http://127.0.0.1:11434',
        'http://127.0.0.1:65535',
        'http://localhost:1024',
        'http://localhost:11434',
        'http://localhost:65535',
        'http://[::1]:1024',
        'http://[::1]:11434',
        'http://[::1]:65535',
      ].sort(),
    );
  });

  it('is structurally immune to DNS rebinding: only three literal hosts exist, no name is ever resolved', () => {
    // Any other hostname, however it is built, is refused; there is nothing for a resolver to rebind.
    const names = [
      'rebind.example',
      'a.localtest.me',
      'localhost6',
      'ip6-localhost',
      'localhost.localdomain',
      '127-0-0-1.nip.io',
      '1.1.1.1.nip.io',
      'x'.repeat(63),
      'xn--localhost-9ya',
    ];
    for (const name of names) {
      for (const port of ['8080', '11434']) {
        expect(parseLoopbackEndpoint(`http://${name}:${port}`).ok, name).toBe(false);
      }
    }
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789.-[]:%@\\/?#';
    for (let i = 0; i < 4000; i += 1) {
      let host = '';
      for (let n = 1 + Math.floor(random() * 14); n > 0; n -= 1)
        host += alphabet[Math.floor(random() * alphabet.length)];
      const parsed = parseLoopbackEndpoint(`http://${host}:8080`);
      if (parsed.ok) expect(['127.0.0.1', 'localhost', '[::1]']).toContain(host);
    }
  });

  it('makes no request at all for any refused endpoint', async () => {
    let calls = 0;
    const spy: FetchLike = () => {
      calls += 1;
      return Promise.reject(new Error('no'));
    };
    for (const endpoint of corpus.slice(0, 20)) {
      const provider = new LocalSemanticProvider({
        protocol: 'local-http',
        endpoint,
        model: null,
        fetch: spy,
      });
      expect(await provider.infer(request, live())).toEqual({
        ok: false,
        failure: 'blocked-endpoint',
      });
      expect(await provider.health()).toBe('ERROR');
    }
    expect(calls).toBe(0);
  });
});

describe('every request carries no ambient authority', () => {
  it('omits credentials, referrer, cache and authorization on every request kind', async () => {
    const calls: { input: string; init: Parameters<FetchLike>[1] }[] = [];
    const fake: FetchLike = (input, init) => {
      calls.push({ input, init });
      return Promise.resolve(
        new Response(
          JSON.stringify({ model: 'm', hypothesis: JSON.parse(good), message: { content: good } }),
        ),
      );
    };
    for (const protocol of ['local-http', 'local-ollama'] as const) {
      const provider = new LocalSemanticProvider({
        protocol,
        endpoint: 'http://localhost:11434',
        model: 'tiny:1b',
        fetch: fake,
      });
      await provider.health();
      await provider.infer(request, live());
    }
    expect(calls).toHaveLength(4);
    for (const { input, init } of calls) {
      expect(input.startsWith('http://localhost:11434/')).toBe(true);
      expect(init.credentials).toBe('omit');
      expect(init.redirect).toBe('error');
      expect(init.cache).toBe('no-store');
      expect(init.referrerPolicy).toBe('no-referrer');
      expect(
        Object.keys(init.headers ?? {})
          .map((k) => k.toLowerCase())
          .sort(),
      ).toEqual(init.body === undefined ? ['accept'] : ['accept', 'content-type']);
      // No page URL can be in a body: the packet type has no field for one.
      expect(init.body ?? '').not.toMatch(/https?:\/\//);
    }
  });

  it('sends no cookie, referer, origin or authorization to a real server', async () => {
    const headers: Record<string, string | string[] | undefined>[] = [];
    const server = createServer((req, res) => {
      headers.push(req.headers);
      req.resume();
      req.on('end', () => res.end(JSON.stringify({ hypothesis: JSON.parse(good) })));
    });
    servers.push(server);
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const port = (server.address() as AddressInfo).port;
    const provider = new LocalSemanticProvider({
      protocol: 'local-http',
      endpoint: `http://127.0.0.1:${port}`,
      model: null,
    });
    await provider.infer(request, live());
    const sent = headers[0] ?? {};
    for (const name of ['cookie', 'referer', 'authorization', 'proxy-authorization', 'origin'])
      expect(sent[name], name).toBeUndefined();
  });
});

describe('a redirect is never followed, wherever it points', () => {
  const targets: [string, (other: { endpoint: string; port: number }) => string][] = [
    ['a public URL', () => 'https://example.com/v1/semantic'],
    ['a LAN address', () => 'http://192.168.1.1:11434/v1/semantic'],
    ['another loopback address', (o) => `http://127.0.0.2:${o.port}/v1/semantic`],
    ['the localhost alias', (o) => `http://localhost:${o.port}/v1/semantic`],
    ['the IPv6 loopback', (o) => `http://[::1]:${o.port}/v1/semantic`],
    ['another port', (o) => `${o.endpoint}/v1/semantic`],
    ['a protocol-relative URL', (o) => `//127.0.0.1:${o.port}/v1/semantic`],
  ];
  for (const status of [301, 302, 303, 307, 308]) {
    for (const [name, location] of targets) {
      it(`${status} to ${name}: no request follows it`, async () => {
        const other = await serve((_u, res) =>
          res.end(JSON.stringify({ hypothesis: JSON.parse(good) })),
        );
        const first = await serve((_u, res) => {
          res.statusCode = status;
          res.setHeader('location', location(other));
          res.end();
        });
        for (const protocol of ['local-http', 'local-ollama'] as const) {
          const provider = new LocalSemanticProvider({
            protocol,
            endpoint: first.endpoint,
            model: 'm',
          });
          expect((await provider.infer(request, live())).ok).toBe(false);
          expect(await provider.health()).not.toBe('AVAILABLE');
        }
        expect(other.seen).toEqual([]);
        // Only the configured origin was ever contacted: two inferences and two health checks.
        expect(first.seen).toHaveLength(4);
      });
    }
  }
});

describe('response size limit (64 KiB)', () => {
  const LIMIT = 65_536;
  /** A valid envelope padded with trailing whitespace to exactly `bytes` bytes. */
  const padded = (bytes: number): string => {
    const core = JSON.stringify({ model: 'm', hypothesis: JSON.parse(good) });
    return core + ' '.repeat(bytes - Buffer.byteLength(core));
  };
  for (const [name, bytes, ok] of [
    ['64 KiB - 1', LIMIT - 1, true],
    ['64 KiB', LIMIT, true],
    ['64 KiB + 1', LIMIT + 1, false],
    ['1 MiB', 1_048_576, false],
  ] as const) {
    it(`${name} with a content-length`, async () => {
      const { endpoint } = await serve((_u, res) => res.end(padded(bytes)));
      const provider = new LocalSemanticProvider({ protocol: 'local-http', endpoint, model: null });
      const result = await provider.infer(request, live());
      expect(result.ok).toBe(ok);
      if (!result.ok) expect(result.failure).toBe('too-large');
    });
    it(`${name} streamed with no content-length`, async () => {
      const { endpoint } = await serve((_u, res) => {
        const text = padded(bytes);
        res.write(text.slice(0, 1000));
        res.end(text.slice(1000));
      });
      const provider = new LocalSemanticProvider({ protocol: 'local-http', endpoint, model: null });
      const result = await provider.infer(request, live());
      expect(result.ok).toBe(ok);
      if (!result.ok) expect(result.failure).toBe('too-large');
    });
  }

  it('stops reading an endless stream', async () => {
    let written = 0;
    const { endpoint } = await serve((_u, res) => {
      const timer = setInterval(() => {
        written += 8192;
        if (!res.write(' '.repeat(8192)) || written > 8_000_000) {
          clearInterval(timer);
          res.end();
        }
      }, 0);
      res.on('close', () => clearInterval(timer));
    });
    const provider = new LocalSemanticProvider({ protocol: 'local-http', endpoint, model: null });
    const result = await provider.infer(request, live());
    expect(result).toEqual({ ok: false, failure: 'too-large' });
  });
});

describe('what a hostile runtime may return', () => {
  it('turns an HTML or script error body into a status, never into text the product shows', async () => {
    const { endpoint } = await serve((_u, res) => {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/html');
      res.end('<script>alert(1)</script><img src=x onerror=alert(2)>');
    });
    const provider = new LocalSemanticProvider({ protocol: 'local-http', endpoint, model: null });
    const result = await provider.infer(request, live());
    expect(result).toEqual({ ok: false, failure: 'http-error' });
    expect(JSON.stringify(result)).not.toContain('script');
  });

  it('keeps a malicious model identifier to a bounded plain name', async () => {
    const { endpoint } = await serve((_u, res) =>
      res.end(
        JSON.stringify({
          model: '<img src=x onerror=alert(1)>"\'`‮' + 'x'.repeat(200),
          hypothesis: JSON.parse(good),
        }),
      ),
    );
    const provider = new LocalSemanticProvider({ protocol: 'local-http', endpoint, model: null });
    const result = await provider.infer(request, live());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model === null || /^[A-Za-z0-9._:/@+-]{1,60}$/.test(result.model)).toBe(true);
    }
  });
});
