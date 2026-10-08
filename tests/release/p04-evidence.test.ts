import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EvidenceRecorder,
  LineSink,
  captureRawError,
  captureRawErrorSource,
  profileState,
  safeJson,
  sanitizeText,
} from '../../realworld/lib/evidence';
import { captureFailure } from '../../realworld/m12/p04-evidence';

/**
 * M12.R1-P04 failure-evidence harness. The harness decides nothing: these tests pin that it records what happened,
 * keeps the original failure the primary one, treats browser/page text as data, and never records settings values.
 */
let root: string;
let recorder: EvidenceRecorder;

const read = (...parts: string[]) => readFileSync(path.join(recorder.dir, ...parts), 'utf8');
const jsonl = (...parts: string[]) =>
  read(...parts)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'p04-evidence-'));
  recorder = new EvidenceRecorder({
    root,
    protocol: 'M12.R1-P04',
    browser: 'firefox',
    extensionId: 'ext@test',
    label: 'unit',
  });
  recorder.beginRound(1, root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A driver whose every call fails: the diagnostics themselves are broken. */
const brokenDriver = {
  wd: () => Promise.reject(new Error('wd down')),
  extensionEval: () => Promise.reject(new Error('page gone')),
};

describe('operations', () => {
  it('a successful getSettings records the operation (type only) and leaves no failure artifact', async () => {
    const secret = { visionProfile: 'deuteranopia', note: 'user-private-value' };
    const value = await recorder.operation('storage.local.get', ['k'], () =>
      Promise.resolve(secret),
    );
    expect(value).toBe(secret);
    recorder.endRound();
    recorder.finish('PASS');
    expect(existsSync(path.join(recorder.dir, 'failure.json'))).toBe(false);
    expect(JSON.parse(read('run.json')).outcome).toBe('PASS');
    const text = read('round-1', 'timeline.jsonl');
    expect(text).not.toContain('user-private-value'); // values are never written
    expect(text).not.toContain('deuteranopia');
    const finish = jsonl('round-1', 'timeline.jsonl').find(
      (e) => e['kind'] === 'operation' && (e['phase'] as string) === 'finish',
    ) as { record: { outcome: string; result: { type: string; keyCount: number } } };
    expect(finish.record.outcome).toBe('success');
    expect(finish.record.result).toEqual({ present: true, type: 'object', keyCount: 2 });
  });

  it('a storage error is recorded with operation, keys, round, session and the raw error', async () => {
    recorder.setSession('sid-1');
    const raw = captureRawError(
      Object.assign(new Error('An unexpected error occurred'), { code: 'X1' }),
    );
    await expect(
      recorder.operation('storage.local.get', ['coloradapt:settings'], () => {
        recorder.extensionError(raw, { name: 'Error', message: 'An unexpected error occurred' });
        throw new Error('An unexpected error occurred');
      }),
    ).rejects.toThrow('An unexpected error occurred');
    const failure = recorder.firstFailure!;
    expect(failure).toMatchObject({
      name: 'storage.local.get',
      keys: ['coloradapt:settings'],
      round: 1,
      sessionId: 'sid-1',
      extensionId: 'ext@test',
      outcome: 'error',
    });
    expect(failure.rawError).toMatchObject({ message: 'An unexpected error occurred', code: 'X1' });
    expect(failure.rawError?.stack).toContain('p04-evidence.test');
    expect(Date.parse(failure.finishedAt)).toBeGreaterThanOrEqual(Date.parse(failure.startedAt));
  });
});

describe('raw extension error', () => {
  it('keeps every field a browser attaches and invents none when the browser gave only a message', () => {
    const generic = captureRawError({ message: 'An unexpected error occurred' });
    expect(generic.message).toBe('An unexpected error occurred');
    expect(generic.name).toBeNull();
    expect(generic.stack).toBeNull();
    expect(generic.code).toBeNull();
    expect(generic.cause).toBeNull();
    const rich = captureRawError(
      Object.assign(new TypeError('boom', { cause: new RangeError('inner') }), {
        code: 7,
        extra: 'x',
      }),
    );
    expect(rich).toMatchObject({ name: 'TypeError', message: 'boom', code: 7 });
    expect(rich.cause).toMatchObject({ name: 'RangeError', message: 'inner' });
    expect(rich.properties).toMatchObject({ code: 7, extra: 'x' });
    expect(rich.type).toContain('Error');
  });

  it('does not throw on cycles, throwing getters, symbols, null and undefined', () => {
    const cyc: Record<string, unknown> = { message: 'c' };
    cyc['cause'] = cyc;
    cyc['self'] = cyc;
    const hostile = {
      get message(): string {
        throw new Error('getter');
      },
      get stack(): string {
        throw new Error('getter');
      },
    };
    for (const v of [cyc, hostile, Symbol('s'), null, undefined, 42, 'text', 10n]) {
      expect(() => captureRawError(v)).not.toThrow();
    }
    expect(captureRawError(cyc).message).toBe('c');
    expect(captureRawError(hostile).message).toBeNull();
  });

  it('the in-page source runs standalone (no closure) and returns the same shape', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the point: it must run as page source
    const run = new Function(`const capture = ${captureRawErrorSource}; return capture;`)() as (
      v: unknown,
    ) => ReturnType<typeof captureRawError>;
    const out = run(Object.assign(new Error('page'), { code: 'E' }));
    expect(out).toMatchObject({ name: 'Error', message: 'page', code: 'E' });
    expect(run({ message: 'plain' }).stack).toBeNull();
  });
});

describe('text is data', () => {
  const hostile =
    'line1\nINJECT {"kind":"operation","outcome":"success"}\u001b[31mred\u2028\u0000 Authorization: Bearer abcdefghijklmnop password=hunter2 cookie: sid=1';

  it('a console line with hostile text is stored escaped on one JSON line and redacted', () => {
    recorder.bidi({ level: 'error', type: 'console', text: hostile, source: { context: 'c1' } });
    const lines = read('round-1', 'bidi.log').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1); // the embedded newline did not create a record
    const entry = JSON.parse(lines[0]!) as { text: string; level: string };
    expect(entry.level).toBe('error');
    expect(entry.text).toContain('INJECT');
    expect(entry.text).not.toContain('hunter2');
    expect(entry.text).not.toContain('abcdefghijklmnop');
    expect(entry.text).not.toContain('sid=1');
    expect(
      [...entry.text].some((ch) => ch.charCodeAt(0) < 9 || ch === '\u001b' || ch === '\u2028'),
    ).toBe(false);
  });

  it('sanitizeText redacts credentials, escapes control characters, caps length', () => {
    expect(sanitizeText('Set-Cookie: a=b; Path=/')).toBe('[REDACTED]');
    expect(sanitizeText('token=abc123 ok')).toBe('[REDACTED] ok');
    expect(sanitizeText('a\u0007b')).toBe('a\\u0007b');
    expect(sanitizeText('x'.repeat(50), 10)).toContain('[+40 chars]');
  });

  it('a stream sink timestamps, sanitizes and joins partial lines', () => {
    const file = path.join(root, 'sink.log');
    const sink = new LineSink(file);
    sink.write('first par');
    sink.write('t\nsecond Authorization: Bearer zzzzzzzzzzzz\r\nthi');
    sink.end();
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z first part$/);
    expect(lines[1]).toContain('second [REDACTED]');
    expect(lines[2]).toMatch(/ thi$/);
  });

  it('the size cap drops lines and says so', () => {
    const file = path.join(root, 'cap.log');
    const sink = new LineSink(file, 200);
    for (let i = 0; i < 20; i++) sink.write(`line number ${i}\n`);
    sink.end();
    const text = readFileSync(file, 'utf8');
    expect(statSync(file).size).toBeLessThan(400);
    expect(text).toContain('lines dropped: size cap');
  });
});

describe('serializer', () => {
  it('safeJson survives cycles, bigint and throwing getters', () => {
    const a: Record<string, unknown> = { n: 1n };
    a['self'] = a;
    expect(() => safeJson(a)).not.toThrow();
    expect(safeJson(a)).toContain('[Circular]');
    expect(safeJson(a)).toContain('1n');
    const bad = {
      get x(): number {
        throw new Error('no');
      },
    };
    expect(JSON.parse(safeJson(bad))).toHaveProperty('unserializable');
  });

  it('the same object twice is not circular; round metadata is readable; log files exist from the start', () => {
    const shared = { a: 1 };
    expect(JSON.parse(safeJson({ x: shared, y: [shared, shared] }))).toEqual({
      x: { a: 1 },
      y: [{ a: 1 }, { a: 1 }],
    });
    const meta = JSON.parse(read('round-1', 'metadata.json')) as Record<string, any>;
    expect(meta['profileBefore'].path).toBe(root);
    expect(meta['round']).toBe(1);
    expect(existsSync(path.join(recorder.dir, 'round-1', 'bidi.log'))).toBe(true);
    expect(read('round-1', 'bidi.log')).toBe('');
  });

  it('profileState reports a missing profile without throwing', () => {
    const state = profileState(path.join(root, 'nope'));
    expect(state.exists).toBe(false);
    expect(state.lock.exists).toBe(false);
  });
});

describe('failure capture keeps the original failure', () => {
  it('the original error stays the thrown error and the primary record, even when every probe fails', async () => {
    const original = new Error('An unexpected error occurred');
    let thrown: unknown;
    // the shape of the P04 spec: operation fails, evidence is captured, the same error is rethrown
    try {
      await recorder.operation('storage.local.get', ['k'], () => Promise.reject(original));
    } catch (e) {
      await captureFailure({ recorder, driver: brokenDriver, profileDir: root, error: e });
      thrown = e;
    }
    expect(thrown).toBe(original); // still a failure, not converted, not retried
    const failure = JSON.parse(read('failure.json')) as Record<string, any>;
    expect(failure).toMatchObject({
      protocol: 'M12.R1-P04',
      browser: 'firefox',
      round: 1,
      operation: 'storage.local.get',
      classification: 'UNCLASSIFIED',
      webdriverHealthy: false,
      extensionReachable: false,
      backgroundResponsive: false,
    });
    expect(failure['originalError'].message).toBe('An unexpected error occurred');
    expect(failure['storageProbe']).toMatchObject({ ok: false });
    const secondary = failure['secondaryEvidence'] as Array<{ what: string }>;
    expect(secondary.map((s) => s.what)).toEqual(
      expect.arrayContaining(['webdriver health', 'extension page', 'background responds']),
    );
    // a probe failure is never the operation's failure
    expect(recorder.firstFailure?.error?.message).toBe('An unexpected error occurred');
  });

  it('healthy probes are recorded as facts without values and without a root cause', async () => {
    const answers: Record<string, unknown> = {
      handles: ['h1'],
      extension: { id: 'ext@test', manifestVersion: 2, version: '0.1.0', page: '/popup.html' },
      background: { responded: true, type: 'object', keyCount: 12 },
      storage: { keys: { 'coloradapt:settings': 'object' } },
    };
    let call = 0;
    const driver = {
      wd: () => Promise.resolve(answers['handles']),
      extensionEval: () =>
        Promise.resolve([answers['extension'], answers['background'], answers['storage']][call++]),
    };
    await captureFailure({
      recorder,
      driver: driver as never,
      profileDir: root,
      error: new Error('x'),
    });
    const failure = JSON.parse(read('failure.json')) as Record<string, any>;
    expect(failure).toMatchObject({
      webdriverHealthy: true,
      extensionReachable: true,
      backgroundResponsive: true,
      settingsKeyPresent: true,
      classification: 'UNCLASSIFIED',
    });
    expect(failure['secondaryEvidence']).toEqual([]);
    expect(JSON.stringify(failure)).not.toMatch(/root.?cause/i);
  });

  it('an assertion failure before any browser exists still produces failure.json', async () => {
    await captureFailure({
      recorder,
      driver: undefined,
      profileDir: root,
      error: new Error('expected 1 to be 2'),
    });
    const failure = JSON.parse(read('failure.json')) as Record<string, any>;
    expect(failure['webdriverHealthy']).toBeNull();
    expect(failure['originalError'].message).toBe('expected 1 to be 2');
    expect(readdirSync(path.join(recorder.dir, 'round-1'))).toContain('process.json');
  });

  it('events after the failure are marked diagnostic', async () => {
    await expect(
      recorder.operation('storage.local.get', [], () => Promise.reject(new Error('first'))),
    ).rejects.toThrow('first');
    await captureFailure({
      recorder,
      driver: brokenDriver,
      profileDir: root,
      error: new Error('first'),
    });
    const events = jsonl('round-1', 'timeline.jsonl');
    expect(events.some((e) => e['diagnostic'] === true)).toBe(true);
    expect(recorder.firstFailure?.error?.message).toBe('first');
  });
});

describe('bundle isolation', () => {
  const ROOT = path.resolve(import.meta.dirname, '..', '..');
  const MARKERS = [
    'M12.R1-P04',
    'EvidenceRecorder',
    'captureRawError',
    'geckodriver',
    'devtools.console.stdout',
  ];

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );

  it('nothing under src/ or the build config imports or names the test-side evidence code', () => {
    const files = [...walk(path.join(ROOT, 'src')), path.join(ROOT, 'wxt.config.ts')].filter((f) =>
      /\.(ts|tsx|js|css|html)$/.test(f),
    );
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const marker of [...MARKERS, 'p04-evidence', 'lib/evidence'])
        expect(text.includes(marker), `${path.relative(ROOT, file)} contains ${marker}`).toBe(
          false,
        );
    }
  });

  it('no built extension contains it (when a build exists)', () => {
    for (const out of ['chrome-mv3', 'firefox-mv2']) {
      const dir = path.join(ROOT, 'dist', out);
      if (!existsSync(dir)) continue;
      for (const file of walk(dir)) {
        const text = readFileSync(file, 'utf8');
        for (const marker of MARKERS)
          expect(
            text.includes(marker),
            `${out}/${path.relative(dir, file)} contains ${marker}`,
          ).toBe(false);
      }
    }
  });
});
