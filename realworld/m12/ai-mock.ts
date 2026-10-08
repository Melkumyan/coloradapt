/**
 * A loopback "runtime" that plays a local model for the M12 suites: one scripted behavior at a time, and it
 * counts what reached it (requests, aborts, the most requests it held open at once).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Mode = 'ok' | 'hold' | 'garbage' | 'empty' | 'schema' | 'huge' | 'hang-forever';

export interface Mock {
  readonly endpoint: string;
  mode: Mode;
  readonly seen: string[];
  readonly aborted: () => number;
  readonly maxInFlight: () => number;
  release(): void;
  close(): Promise<void>;
}

/** A loopback "runtime". One mode at a time; `maxInFlight` is the most requests it ever held open at once. */
export async function startMock(initial: Mode = 'ok'): Promise<Mock> {
  const seen: string[] = [];
  const held: Array<() => void> = [];
  let aborted = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const mock: { mode: Mode } = { mode: initial };
  const http: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      res.on('close', () => {
        inFlight -= 1;
        if (!res.writableEnded) aborted += 1;
      });
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push(body);
      const answer = (): void => {
        const parsed = JSON.parse(body || '{}') as { payload?: string };
        const query = JSON.parse(parsed.payload ?? '{}') as {
          allowedLabels?: string[];
          deterministicEvidence?: Array<{ id: string; supports: string[] }>;
        };
        const label = query.allowedLabels?.find((l) =>
          query.deterministicEvidence?.some((e) => e.supports.includes(l)),
        );
        const refs = (query.deterministicEvidence ?? [])
          .filter((e) => label && e.supports.includes(label))
          .map((e) => e.id);
        res.writeHead(200, { 'content-type': 'application/json' });
        switch (mock.mode) {
          case 'garbage':
            res.end('this is not json {{{ <script>alert(1)</script>');
            return;
          case 'empty':
            res.end('');
            return;
          case 'schema':
            res.end(
              JSON.stringify({
                model: 'rw-mock',
                hypothesis: {
                  schemaVersion: 1,
                  outcome: 'SUPPORTED_HYPOTHESIS',
                  label: 'not-in-the-taxonomy',
                  confidence: 7,
                  evidenceRefs: ['nope'],
                },
              }),
            );
            return;
          case 'huge':
            res.end(
              JSON.stringify({
                model: 'rw-mock',
                hypothesis: {
                  schemaVersion: 1,
                  outcome: 'SUPPORTED_HYPOTHESIS',
                  label: label ?? 'x',
                  confidence: 0.9,
                  evidenceRefs: refs,
                  pad: 'x'.repeat(2_000_000),
                },
              }),
            );
            return;
          default:
            res.end(
              JSON.stringify({
                model: 'rw-mock',
                hypothesis: label
                  ? {
                      schemaVersion: 1,
                      outcome: 'SUPPORTED_HYPOTHESIS',
                      label,
                      confidence: 0.9,
                      evidenceRefs: refs,
                    }
                  : {
                      schemaVersion: 1,
                      outcome: 'INSUFFICIENT_CONTEXT',
                      label: 'unknown',
                      confidence: 0.2,
                      evidenceRefs: [],
                    },
              }),
            );
        }
      };
      if (mock.mode === 'hold') held.push(answer);
      else if (mock.mode === 'hang-forever') return;
      else answer();
    });
  });
  await new Promise<void>((ok) => http.listen(0, '127.0.0.1', ok));
  const port = (http.address() as AddressInfo).port;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    get mode() {
      return mock.mode;
    },
    set mode(m: Mode) {
      mock.mode = m;
    },
    seen,
    aborted: () => aborted,
    maxInFlight: () => maxInFlight,
    release: () => held.splice(0).forEach((run) => run()),
    close: () =>
      new Promise<void>((done) => {
        http.closeAllConnections();
        http.close(() => done());
      }),
  };
}
