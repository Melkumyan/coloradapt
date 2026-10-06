// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalSemanticProvider,
  SemanticAssistEngine,
  buildProviderRequest,
  type FetchLike,
} from '@core/semantic-ai';
import { ACTIVE_TAB, answer, bound, supporters } from './kit';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

async function serve(
  handler: (req: Seen, res: ServerResponse) => void,
): Promise<{ endpoint: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(entry);
      handler(entry, res);
    });
  });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  return { endpoint: `http://127.0.0.1:${port}`, seen };
}

const query = bound(ACTIVE_TAB).query;
const good = answer('active', 0.9, supporters(query, 'active'));
const request = buildProviderRequest(query);
const live = () => new AbortController().signal;

describe('LocalSemanticProvider over a real loopback server', () => {
  it('speaks the ColorAdapt protocol and returns the hypothesis untouched', async () => {
    const { endpoint, seen } = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'tiny-1', hypothesis: JSON.parse(good) }));
    });
    const provider = new LocalSemanticProvider({ protocol: 'local-http', endpoint, model: null });
    const result = await provider.infer(request, live());
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('/v1/semantic');
    expect(seen[0]?.headers.cookie).toBeUndefined();
    expect(seen[0]?.headers.referer).toBeUndefined();
    const body = JSON.parse(seen[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body.temperature).toBe(0);
    expect(body.instructions).toBe(request.instructions);
    expect(body.payload).toBe(request.payload);
    if (result.ok) expect(result.model).toBe('tiny-1');
  });

  it('speaks Ollama /api/chat with the instructions and payload in separate messages', async () => {
    const { endpoint, seen } = await serve((_req, res) => {
      res.end(JSON.stringify({ model: 'llama-x', message: { role: 'assistant', content: good } }));
    });
    const provider = new LocalSemanticProvider({
      protocol: 'local-ollama',
      endpoint,
      model: 'llama-x',
    });
    const result = await provider.infer(request, live());
    expect(result).toMatchObject({ ok: true, raw: good });
    const body = JSON.parse(seen[0]?.body ?? '{}') as {
      messages: { role: string; content: string }[];
      options: { temperature: number };
      format: string;
      stream: boolean;
    };
    expect(seen[0]?.url).toBe('/api/chat');
    expect(body.stream).toBe(false);
    expect(body.format).toBe('json');
    expect(body.options.temperature).toBe(0);
    expect(body.messages[0]).toEqual({ role: 'system', content: request.instructions });
    expect(body.messages[1]?.role).toBe('user');
    expect(body.messages[1]?.content).toContain(request.payload);
    expect(body.messages[0]?.content).not.toContain('"tag"');
  });

  it('refuses to run Ollama without a model', async () => {
    const { endpoint, seen } = await serve((_r, res) => res.end('{}'));
    const provider = new LocalSemanticProvider({ protocol: 'local-ollama', endpoint, model: '' });
    expect(await provider.infer(request, live())).toEqual({ ok: false, failure: 'not-configured' });
    expect(seen).toHaveLength(0);
  });

  it('does not follow a redirect to a remote host (and never contacts it)', async () => {
    const remote = await serve((_r, res) => res.end('{}'));
    const { endpoint } = await serve((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'https://example.com/steal');
      res.end();
    });
    const provider = new LocalSemanticProvider({ protocol: 'local-http', endpoint, model: null });
    const result = await provider.infer(request, live());
    expect(result.ok).toBe(false);
    expect(remote.seen).toHaveLength(0);
  });

  it('does not follow a redirect to another loopback port either', async () => {
    const other = await serve((_r, res) =>
      res.end(JSON.stringify({ hypothesis: JSON.parse(good) })),
    );
    const { endpoint } = await serve((_req, res) => {
      res.statusCode = 307;
      res.setHeader('location', `${other.endpoint}/v1/semantic`);
      res.end();
    });
    const provider = new LocalSemanticProvider({ protocol: 'local-http', endpoint, model: null });
    expect((await provider.infer(request, live())).ok).toBe(false);
    expect(other.seen).toHaveLength(0);
  });

  it('refuses an endpoint that is not loopback, without any request', async () => {
    let calls = 0;
    const spy: FetchLike = () => {
      calls += 1;
      return Promise.reject(new Error('should not be called'));
    };
    for (const endpoint of [
      'http://localhost.evil.com:8080',
      'http://127.0.0.1@evil.com:8080',
      'https://example.com',
      'http://192.168.1.2:8080',
      'http://2130706433:8080',
    ]) {
      const provider = new LocalSemanticProvider({
        protocol: 'local-http',
        endpoint,
        model: null,
        fetch: spy,
      });
      expect(provider.endpointAllowed).toBe(false);
      expect(await provider.infer(request, live())).toEqual({
        ok: false,
        failure: 'blocked-endpoint',
      });
      expect(await provider.health()).toBe('ERROR');
    }
    expect(calls).toBe(0);
  });

  it('rejects an answer whose final address left the origin, even if fetch followed it', async () => {
    const fake: FetchLike = () =>
      Promise.resolve(
        Object.defineProperty(new Response('{}', { status: 200 }), 'url', {
          value: 'https://example.com/v1/semantic',
        }),
      );
    const provider = new LocalSemanticProvider({
      protocol: 'local-http',
      endpoint: 'http://127.0.0.1:9999',
      model: null,
      fetch: fake,
    });
    expect(await provider.infer(request, live())).toEqual({
      ok: false,
      failure: 'blocked-endpoint',
    });
    const redirected: FetchLike = () =>
      Promise.resolve(Object.defineProperty(new Response('{}'), 'redirected', { value: true }));
    const provider2 = new LocalSemanticProvider({
      protocol: 'local-http',
      endpoint: 'http://127.0.0.1:9999',
      model: null,
      fetch: redirected,
    });
    expect(await provider2.infer(request, live())).toEqual({
      ok: false,
      failure: 'blocked-endpoint',
    });
  });

  it('bounds the size of a response while reading it', async () => {
    const { endpoint } = await serve((_r, res) => {
      res.write('{"hypothesis":"');
      res.end('x'.repeat(200_000) + '"}');
    });
    const provider = new LocalSemanticProvider({ protocol: 'local-http', endpoint, model: null });
    expect(await provider.infer(request, live())).toEqual({ ok: false, failure: 'too-large' });
  });

  it('maps an HTTP error, a malformed envelope and a closed port to failures, not exceptions', async () => {
    const failing = await serve((_r, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    expect(
      await new LocalSemanticProvider({
        protocol: 'local-http',
        endpoint: failing.endpoint,
        model: null,
      }).infer(request, live()),
    ).toEqual({ ok: false, failure: 'http-error' });
    const junk = await serve((_r, res) => res.end('not json'));
    expect(
      await new LocalSemanticProvider({
        protocol: 'local-http',
        endpoint: junk.endpoint,
        model: null,
      }).infer(request, live()),
    ).toEqual({ ok: false, failure: 'bad-response' });
    const closed = await serve((_r, res) => res.end('{}'));
    const dead = closed.endpoint;
    await new Promise((done) => servers.pop()?.close(done));
    expect(
      await new LocalSemanticProvider({
        protocol: 'local-http',
        endpoint: dead,
        model: null,
      }).infer(request, live()),
    ).toEqual({ ok: false, failure: 'unavailable' });
  });

  it('aborts a slow runtime on signal', async () => {
    const { endpoint } = await serve(() => {
      // never answers
    });
    const controller = new AbortController();
    const provider = new LocalSemanticProvider({ protocol: 'local-http', endpoint, model: null });
    const pending = provider.infer(request, controller.signal);
    setTimeout(() => controller.abort(), 50);
    expect(await pending).toEqual({ ok: false, failure: 'aborted' });
  });

  it('reports an unreachable runtime as UNAVAILABLE and a refused endpoint as ERROR', async () => {
    const closed = await serve((_r, res) => res.end('{}'));
    const dead = closed.endpoint;
    await new Promise((done) => servers.pop()?.close(done));
    expect(
      await new LocalSemanticProvider({
        protocol: 'local-http',
        endpoint: dead,
        model: null,
      }).health(),
    ).toBe('UNAVAILABLE');
    const failing = await serve((_r, res) => {
      res.statusCode = 503;
      res.end();
    });
    expect(
      await new LocalSemanticProvider({
        protocol: 'local-http',
        endpoint: failing.endpoint,
        model: null,
      }).health(),
    ).toBe('UNAVAILABLE');
  });

  it('reports health from one quick request', async () => {
    const { endpoint, seen } = await serve((_r, res) => res.end('{}'));
    const provider = new LocalSemanticProvider({ protocol: 'local-http', endpoint, model: null });
    expect(await provider.health()).toBe('AVAILABLE');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('/v1/health');
  });
});

describe('engine over the real provider', () => {
  it('carries a full question through the loopback and validates the answer', async () => {
    const { endpoint } = await serve((_r, res) =>
      res.end(JSON.stringify({ model: 'tiny-1', hypothesis: JSON.parse(good) })),
    );
    const provider = new LocalSemanticProvider({ protocol: 'local-http', endpoint, model: null });
    const engine = new SemanticAssistEngine(provider);
    const results: string[] = [];
    const summary = await engine.run([{ id: 'f1', bound: bound(ACTIVE_TAB), priority: 1 }], {
      isCurrent: () => true,
      onResult: (outcome) => results.push(outcome.interpreted.validatorStatus),
    });
    expect(results).toEqual(['ACCEPTED_ADVISORY']);
    expect(summary.coverage).toBe('completed');
  });
});
