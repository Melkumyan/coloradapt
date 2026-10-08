/**
 * M12.R1-P04: failure-evidence capture for the real-browser restart test. TEST-SIDE ONLY: nothing here is imported by
 * `src/`, nothing is bundled into an extension, nothing is persisted by the product.
 *
 * The contract is to observe, record and preserve. It never retries, never waits for a result to change, never
 * turns a failure into a pass, and a failure of the diagnostics themselves is added as secondary evidence and
 * never replaces the original failure. Settings *values* are never recorded (key names and value types only);
 * text that came from a browser or a page is stored as data (JSON strings, escaped control characters) and
 * credential-looking text is redacted before it reaches a file.
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------------------------------------

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]*/gi,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token)\s*[:=]\s*[^\s,;&"']+/gi,
];

/** Removes credential-looking text and makes control characters visible; never throws. */
export function sanitizeText(text: string, max = 4000): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  let visible = '';
  for (const ch of out) {
    const c = ch.charCodeAt(0);
    const control =
      (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) ||
      c === 0x7f ||
      c === 0x2028 ||
      c === 0x2029;
    visible += control ? '\\u' + c.toString(16).padStart(4, '0') : ch;
  }
  out = visible;
  return out.length > max ? `${out.slice(0, max)}...[+${out.length - max} chars]` : out;
}

/** Text of any value without the "[object Object]" trap: strings as they are, other values as JSON. */
export function asText(value: unknown, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return `${value}`;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return safeJson(value);
}

/** JSON that cannot throw: cycles, bigint and getters that throw are replaced by a marker. */
export function safeJson(value: unknown, space?: number): string {
  const ancestors: object[] = [];
  try {
    return (
      JSON.stringify(
        value,
        function (this: unknown, _k: string, v: unknown) {
          if (typeof v === 'bigint') return `${v}n`;
          if (typeof v === 'object' && v !== null) {
            // only a value that contains itself is circular; the same object twice is not
            while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this)
              ancestors.pop();
            if (ancestors.includes(v)) return '[Circular]';
            ancestors.push(v);
          }
          return v;
        },
        space,
      ) ?? 'null'
    );
  } catch (e) {
    return JSON.stringify({ unserializable: String(e).slice(0, 200) });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Raw error capture (runs inside the extension page; self-contained, no closure, no regex)
// ---------------------------------------------------------------------------------------------------------

export interface RawError {
  readonly type: string;
  readonly name: string | null;
  readonly message: string | null;
  readonly stack: string | null;
  readonly code: string | number | null;
  readonly cause: RawError | null;
  /** Own enumerable properties with primitive values only (names and values of what the browser attached). */
  readonly properties: Record<string, string | number | boolean | null>;
  readonly string: string | null;
  readonly json: string | null;
}

export function captureRawError(value: unknown, depth = 0): RawError {
  const str = (v: unknown, max: number): string | null =>
    typeof v === 'string' ? v.slice(0, max) : null;
  let type = 'unknown';
  try {
    type = Object.prototype.toString.call(value);
    const ctor = (value as { constructor?: { name?: unknown } } | null)?.constructor?.name;
    if (typeof ctor === 'string') type = `${type} ${ctor}`;
  } catch {
    // keep what we have
  }
  const o = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const read = (key: string): unknown => {
    try {
      return o[key];
    } catch {
      return undefined;
    }
  };
  const properties: Record<string, string | number | boolean | null> = {};
  try {
    for (const key of Object.keys(o).slice(0, 30)) {
      const v = read(key);
      if (v === null || typeof v === 'number' || typeof v === 'boolean') properties[key] = v;
      else if (typeof v === 'string') properties[key] = v.slice(0, 500);
    }
  } catch {
    // keep what we have
  }
  let text: string | null = null;
  try {
    text = String(value).slice(0, 1000);
  } catch {
    // keep null
  }
  let json: string | null = null;
  try {
    json = JSON.stringify(value) ?? null;
    if (json !== null) json = json.slice(0, 2000);
  } catch {
    // keep null
  }
  const code = read('code');
  const cause = read('cause');
  return {
    type,
    name: str(read('name'), 200),
    message: str(read('message'), 2000),
    stack: str(read('stack'), 6000),
    code: typeof code === 'string' || typeof code === 'number' ? code : null,
    cause:
      depth < 2 && cause !== undefined && cause !== null ? captureRawError(cause, depth + 1) : null,
    properties,
    string: text,
    json,
  };
}

/** The function as source, to embed in a script that runs in an extension page. */
export const captureRawErrorSource: string = captureRawError.toString();

// ---------------------------------------------------------------------------------------------------------
// Line sink: a child-process stream to a file, sanitized, timestamped, durable
// ---------------------------------------------------------------------------------------------------------

export class LineSink {
  readonly #fd: number;
  #partial = '';
  #bytes = 0;
  #dropped = 0;
  readonly #cap: number;

  constructor(file: string, capBytes = 64 * 1024 * 1024) {
    this.#fd = openSync(file, 'a');
    this.#cap = capBytes;
  }

  write(chunk: Buffer | string): void {
    const text = this.#partial + chunk.toString('utf8');
    const lines = text.split('\n');
    this.#partial = lines.pop() ?? '';
    for (const line of lines) this.#line(line.replace(/\r$/, ''));
    if (this.#partial.length > 100_000) {
      this.#line(this.#partial);
      this.#partial = '';
    }
  }

  #line(line: string): void {
    const out = `${new Date().toISOString()} ${sanitizeText(line)}\n`;
    if (this.#bytes + out.length > this.#cap) {
      this.#dropped++;
      return;
    }
    this.#bytes += out.length;
    try {
      writeSync(this.#fd, out);
    } catch {
      // diagnostics never throw into the test
    }
  }

  end(): void {
    if (this.#partial) this.#line(this.#partial);
    this.#partial = '';
    if (this.#dropped)
      try {
        writeSync(
          this.#fd,
          `${new Date().toISOString()} [${this.#dropped} lines dropped: size cap]\n`,
        );
      } catch {
        // ignore
      }
    try {
      closeSync(this.#fd);
    } catch {
      // already closed
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------------------------------------

interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly commandLine: string;
  readonly workingSetBytes: number | null;
}

export interface ProcessSnapshot {
  readonly takenAt: string;
  readonly testRunnerPid: number;
  readonly processes: ProcessInfo[];
  readonly error: string | null;
}

/** Process tree of the test runner plus every geckodriver/firefox process, read-only (Windows: CIM; elsewhere: ps). */
export function snapshotProcesses(): ProcessSnapshot {
  const takenAt = new Date().toISOString();
  const base = { takenAt, testRunnerPid: process.pid };
  try {
    let all: ProcessInfo[] = [];
    if (process.platform === 'win32') {
      const run = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize | ConvertTo-Json -Compress',
        ],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
      );
      if (run.status !== 0) throw new Error(`process listing failed: ${run.stderr.slice(0, 300)}`);
      const parsed = JSON.parse(run.stdout) as
        Array<Record<string, unknown>> | Record<string, unknown>;
      all = (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
        pid: Number(p['ProcessId']),
        ppid: Number(p['ParentProcessId']),
        name: asText(p['Name']),
        commandLine: sanitizeText(asText(p['CommandLine']), 600),
        workingSetBytes: typeof p['WorkingSetSize'] === 'number' ? p['WorkingSetSize'] : null,
      }));
    } else {
      const run = spawnSync('ps', ['-eo', 'pid=,ppid=,rss=,comm=,args='], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      if (run.status !== 0) throw new Error(`process listing failed: ${run.stderr.slice(0, 300)}`);
      all = run.stdout
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(l);
          return {
            pid: Number(m?.[1]),
            ppid: Number(m?.[2]),
            name: m?.[4] ?? '',
            commandLine: sanitizeText(m?.[5] ?? '', 600),
            workingSetBytes: m ? Number(m[3]) * 1024 : null,
          };
        });
    }
    const keep = new Set<number>([process.pid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of all)
        if (!keep.has(p.pid) && keep.has(p.ppid)) {
          keep.add(p.pid);
          grew = true;
        }
    }
    const interesting = (p: ProcessInfo) =>
      keep.has(p.pid) || /^(geckodriver|firefox)(\.exe)?$/i.test(p.name);
    return { ...base, processes: all.filter(interesting), error: null };
  } catch (e) {
    return { ...base, processes: [], error: sanitizeText(String(e), 500) };
  }
}

export interface ProfileState {
  readonly path: string;
  readonly exists: boolean;
  readonly createdAt: string | null;
  /** `parent.lock` (Windows) / `lock` (Unix symlink): whether it exists and whether it can be opened for reading. */
  readonly lock: { file: string; exists: boolean; openable: boolean | null; error: string | null };
  readonly takenAt: string;
}

/** Read-only profile probe. Does not copy the profile, does not modify it. */
export function profileState(profileDir: string): ProfileState {
  const takenAt = new Date().toISOString();
  const exists = existsSync(profileDir);
  let createdAt: string | null = null;
  try {
    if (exists) createdAt = statSync(profileDir).birthtime.toISOString();
  } catch {
    // keep null
  }
  const lockFile = path.join(profileDir, process.platform === 'win32' ? 'parent.lock' : 'lock');
  const lockExists = existsSync(lockFile);
  let openable: boolean | null = null;
  let error: string | null = null;
  if (lockExists && process.platform === 'win32') {
    try {
      closeSync(openSync(lockFile, 'r'));
      openable = true;
    } catch (e) {
      openable = false;
      error = sanitizeText(String(e), 300);
    }
  }
  return {
    path: profileDir,
    exists,
    createdAt,
    lock: { file: path.basename(lockFile), exists: lockExists, openable, error },
    takenAt,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------------------------------------

export type EventKind =
  | 'round.begin'
  | 'round.end'
  | 'geckodriver.spawn'
  | 'geckodriver.ready'
  | 'session.create'
  | 'session.created'
  | 'bidi.connected'
  | 'addon.install'
  | 'extension.ready'
  | 'wd'
  | 'operation'
  | 'extension.error'
  | 'readiness'
  | 'session.delete'
  | 'process.kill'
  | 'diagnostic';

export interface OperationRecord {
  readonly name: string;
  readonly keys: ReadonlyArray<string>;
  readonly round: number | null;
  readonly sessionId: string;
  readonly extensionId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly outcome: 'success' | 'error';
  /** Value presence and type only, never the value. */
  readonly result: { present: boolean; type: string; keyCount?: number } | null;
  readonly rawError: RawError | null;
  readonly error: { name: string; message: string } | null;
}

export interface RecorderOptions {
  readonly root: string;
  readonly protocol: string;
  readonly browser: string;
  readonly extensionId: string;
  readonly label?: string | null;
  readonly runId?: string;
}

export class EvidenceRecorder {
  readonly dir: string;
  readonly runId: string;
  readonly #opts: RecorderOptions;
  readonly #t0 = Date.now();
  readonly #startedAt = new Date().toISOString();
  #round: number | null = null;
  #roundDir: string | null = null;
  #sessionId = '';
  #sinks: LineSink[] = [];
  #diagnosticMode = false;
  #lastRaw: RawError | null = null;
  #firstFailure: OperationRecord | null = null;
  readonly #operations: OperationRecord[] = [];
  readonly #secondary: Array<{ what: string; error: string }> = [];
  readonly #rounds: Array<Record<string, unknown>> = [];

  constructor(opts: RecorderOptions) {
    this.#opts = opts;
    this.runId = opts.runId ?? new Date().toISOString().replace(/[:.]/g, '-');
    this.dir = path.join(opts.root, this.runId);
    mkdirSync(this.dir, { recursive: true });
    this.#writeRun('RUNNING');
  }

  get round(): number | null {
    return this.#round;
  }

  get roundDir(): string {
    if (!this.#roundDir) throw new Error('no round is open');
    return this.#roundDir;
  }

  /** The raw value of the most recent extension-side rejection (any operation, including a recovered one). */
  get lastRawError(): RawError | null {
    return this.#lastRaw;
  }

  get firstFailure(): OperationRecord | null {
    return this.#firstFailure;
  }

  get secondary(): ReadonlyArray<{ what: string; error: string }> {
    return this.#secondary;
  }

  /** Milliseconds since this recorder was created, to correlate events across files. */
  elapsed(): number {
    return Date.now() - this.#t0;
  }

  beginRound(round: number, profileDir: string): void {
    this.#round = round;
    this.#sessionId = '';
    this.#roundDir = path.join(this.dir, `round-${round}`);
    mkdirSync(this.#roundDir, { recursive: true });
    const profile = profileState(profileDir);
    this.#rounds.push({ round });
    this.#writeJson('metadata.json', {
      round,
      beginAt: new Date().toISOString(),
      profileBefore: profile,
    });
    // created up front: an absent log would be ambiguous, an empty one says nothing was reported
    for (const file of ['bidi.log', 'timeline.jsonl'])
      writeFileSync(path.join(this.#roundDir, file), '', { flag: 'a' });
    this.event('round.begin', { round });
  }

  /** A stream of the geckodriver child (geckodriver's own log and the browser output it forwards). */
  sink(file: string): LineSink {
    const sink = new LineSink(path.join(this.roundDir, file));
    this.#sinks.push(sink);
    return sink;
  }

  setSession(sessionId: string): void {
    this.#sessionId = sessionId;
  }

  event(kind: EventKind, data: Record<string, unknown> = {}): void {
    if (!this.#roundDir) return;
    const line = safeJson({
      at: new Date().toISOString(),
      ms: this.elapsed(),
      round: this.#round,
      kind,
      diagnostic: this.#diagnosticMode || undefined,
      ...data,
    });
    try {
      appendFileSync(path.join(this.#roundDir, 'timeline.jsonl'), `${line}\n`);
    } catch (e) {
      this.noteSecondary('timeline write', e);
    }
  }

  /** A BiDi `log.entryAdded` payload, every level, stored as data. */
  bidi(params: unknown): void {
    if (!this.#roundDir) return;
    const p = (params ?? {}) as {
      level?: unknown;
      type?: unknown;
      text?: unknown;
      timestamp?: unknown;
      method?: unknown;
      source?: { realm?: unknown; context?: unknown };
      stackTrace?: { callFrames?: Array<Record<string, unknown>> };
    };
    const frames = (p.stackTrace?.callFrames ?? []).slice(0, 8).map((f) => ({
      functionName: sanitizeText(asText(f['functionName']), 200),
      url: sanitizeText(asText(f['url']), 300),
      line: f['lineNumber'],
      column: f['columnNumber'],
    }));
    const line = safeJson({
      at: new Date().toISOString(),
      ms: this.elapsed(),
      browserTimestamp: p.timestamp,
      level: p.level,
      type: p.type,
      method: p.method,
      text: sanitizeText(asText(p.text)),
      context: typeof p.source?.context === 'string' ? p.source.context : null,
      realm: typeof p.source?.realm === 'string' ? p.source.realm : null,
      frames,
    });
    try {
      appendFileSync(path.join(this.#roundDir, 'bidi.log'), `${line}\n`);
    } catch (e) {
      this.noteSecondary('bidi write', e);
    }
  }

  /** Called by the driver when a script in an extension page rejected, before it becomes a generic exception. */
  extensionError(raw: RawError | null, normalized: { name: string; message: string }): void {
    this.#lastRaw = raw;
    this.event('extension.error', { raw, normalized });
  }

  /** Runs `fn` as a named, recorded operation. The outcome is the outcome of `fn`: nothing is retried or swallowed. */
  async operation<T>(name: string, keys: ReadonlyArray<string>, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const startedAt = new Date().toISOString();
    this.#lastRaw = null;
    this.event('operation', { name, phase: 'start', keys });
    try {
      const value = await fn();
      this.#finishOperation({ name, keys, started, startedAt, outcome: 'success', value });
      return value;
    } catch (e) {
      this.#finishOperation({ name, keys, started, startedAt, outcome: 'error', error: e });
      throw e;
    }
  }

  #finishOperation(a: {
    name: string;
    keys: ReadonlyArray<string>;
    started: number;
    startedAt: string;
    outcome: 'success' | 'error';
    value?: unknown;
    error?: unknown;
  }): void {
    const err = a.error as { name?: unknown; message?: unknown } | undefined;
    const value = a.value;
    const record: OperationRecord = {
      name: a.name,
      keys: a.keys,
      round: this.#round,
      sessionId: this.#sessionId,
      extensionId: this.#opts.extensionId,
      startedAt: a.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - a.started,
      outcome: a.outcome,
      result:
        a.outcome === 'success'
          ? {
              present: value !== undefined && value !== null,
              type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
              ...(value !== null && typeof value === 'object'
                ? { keyCount: Object.keys(value).length }
                : {}),
            }
          : null,
      rawError: a.outcome === 'error' ? this.#lastRaw : null,
      error:
        a.outcome === 'error'
          ? {
              name: sanitizeText(asText(err?.name, 'Error'), 200),
              message: sanitizeText(asText(err?.message ?? a.error), 1000),
            }
          : null,
    };
    this.#operations.push(record);
    if (a.outcome === 'error' && !this.#diagnosticMode && !this.#firstFailure)
      this.#firstFailure = record;
    this.event('operation', { name: a.name, phase: 'finish', record });
  }

  /** From here on every event is marked as diagnostic; the primary failure stays the one already recorded. */
  enterDiagnosticMode(): void {
    this.#diagnosticMode = true;
  }

  noteSecondary(what: string, error: unknown): void {
    this.#secondary.push({ what, error: sanitizeText(String(error), 500) });
  }

  /** Runs one diagnostic probe; a failure of the probe is recorded as secondary evidence and returned as data. */
  async probe<T>(
    what: string,
    fn: () => Promise<T> | T,
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    try {
      const value = await fn();
      return { ok: true, value };
    } catch (e) {
      this.noteSecondary(what, e);
      return { ok: false, error: sanitizeText(String(e), 500) };
    }
  }

  writeProcessSnapshot(label: string, snapshot: ProcessSnapshot): void {
    this.#merge('process.json', { [label]: snapshot });
  }

  endRound(summary: Record<string, unknown> = {}): void {
    this.event('round.end', { round: this.#round, ...summary });
    for (const sink of this.#sinks) sink.end();
    this.#sinks = [];
  }

  writeFailure(failure: Record<string, unknown>): void {
    try {
      writeFileSync(
        path.join(this.dir, 'failure.json'),
        `${safeJson(
          {
            protocol: this.#opts.protocol,
            browser: this.#opts.browser,
            label: this.#opts.label ?? null,
            runId: this.runId,
            round: this.#round,
            sessionId: this.#sessionId,
            extensionId: this.#opts.extensionId,
            classification: 'UNCLASSIFIED',
            ...failure,
            secondaryEvidence: this.#secondary,
          },
          2,
        )}\n`,
      );
    } catch (e) {
      this.noteSecondary('failure.json write', e);
    }
  }

  finish(outcome: 'PASS' | 'FAIL', extra: Record<string, unknown> = {}): void {
    for (const sink of this.#sinks) sink.end();
    this.#sinks = [];
    this.#writeRun(outcome, { operations: this.#operations.length, ...extra });
  }

  #writeRun(outcome: 'RUNNING' | 'PASS' | 'FAIL', extra: Record<string, unknown> = {}): void {
    try {
      writeFileSync(
        path.join(this.dir, 'run.json'),
        `${safeJson(
          {
            protocol: this.#opts.protocol,
            browser: this.#opts.browser,
            label: this.#opts.label ?? null,
            runId: this.runId,
            startedAt: this.#startedAt,
            outcome,
            rounds: this.#rounds.length,
            ...extra,
          },
          2,
        )}\n`,
      );
    } catch {
      // diagnostics never throw into the test
    }
  }

  #writeJson(file: string, value: unknown): void {
    try {
      writeFileSync(path.join(this.roundDir, file), `${safeJson(value, 2)}\n`);
    } catch (e) {
      this.noteSecondary(`${file} write`, e);
    }
  }

  #merge(file: string, patch: Record<string, unknown>): void {
    const target = path.join(this.roundDir, file);
    let current: Record<string, unknown> = {};
    try {
      if (existsSync(target))
        current = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
    } catch {
      current = {};
    }
    this.#writeJson(file, { ...current, ...patch });
  }
}
