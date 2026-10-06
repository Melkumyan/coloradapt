/**
 * One real page through the whole M10 measurement, in either browser. Everything is collected as plain data
 * (`PageResult`) so the judgements (FP/FN, privacy, source integrity, visual regression) can be made, repeated
 * and reviewed afterwards without touching the browser again.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AuditSnapshot } from '../../src/core/audit';
import { createAuditReport, renderAuditHtml, serializeAuditReport } from '../../src/core/audit';
import { compareBitmaps, decodePng, type VisualDiff } from './png';
import { resolveContrast, contrastTarget, toHex, type OracleStatus } from './color';
import {
  call,
  featureProbe,
  integrityProbe,
  oracleProbe,
  type FeatureProbe,
  type IntegrityProbe,
  type OracleElement,
} from './probe';
import { ROOT, type Driver, type LogEntry, type Tab } from './driver';
import { parseCsp } from './csp';
import {
  DOCUMENT_IDENTITY_SOURCE,
  parseDocumentIdentity,
  sameDocument,
  type DocumentIdentity,
} from './document-identity';

export const OFF_SETTINGS = {
  enabled: false,
  visionProfile: 'deuteranopia',
  adaptationStrength: 1,
  semanticCuesEnabled: true,
  adaptCharts: true,
  adaptSVG: true,
  adaptImages: false,
} as const;

export const ON_SETTINGS = { ...OFF_SETTINGS, enabled: true } as const;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface OracleRow {
  readonly path: string;
  readonly full: string;
  readonly tag: string;
  readonly status: OracleStatus;
  readonly ratio: number | null;
  readonly target: number;
  readonly flags: string;
  readonly chars: number;
  /** M10.R1: what the oracle used. `fg`/`bg` are the effective colors it computed (hex), null when unresolved. */
  readonly fg?: string | null;
  readonly bg?: string | null;
  readonly fontSizePx?: number;
  readonly fontWeight?: number;
  /** Product of the element's and its ancestors' `opacity`. */
  readonly opacity?: number;
  readonly occluded?: boolean | null;
  /** The product's own decision for this element, replayed in the page (`features/audit/trace.ts`). */
  readonly trace?: TraceCompact | null;
  /** The same decision with the selector as it was up to M10 (before M10.R1 widened discovery). */
  readonly traceLegacy?: TraceCompact | null;
}

export interface TraceCompact {
  readonly stage: string;
  readonly reason: string;
  readonly reported: boolean;
  readonly foreground: string | null;
  readonly background: string | null;
  readonly ratio: number | null;
  readonly target: number | null;
  readonly largeText: boolean | null;
  readonly fontSizePx: number | null;
  readonly fontWeight: string | null;
  readonly backgroundKind: string | null;
}

export interface AuditCompact {
  readonly ok: boolean;
  readonly error: string | null;
  readonly ms: number;
  readonly generation: number;
  readonly findings: Array<{
    id: string;
    rule: string;
    assessment: string;
    severity: string;
    confidence: string;
    count: number;
    profiles: string[];
    adaptation: string;
    sample: Array<{ path: string; tag: string; ratio: number | null; pair: string | null }>;
  }>;
  readonly coverage: AuditSnapshot['coverage'] | null;
  readonly summary: AuditSnapshot['summary'] | null;
  readonly pathname: string;
  readonly origin: string;
}

export interface PrivacyCheck {
  /** Secret-like strings of the page that were looked for in every audit output. */
  readonly secretsChecked: number;
  readonly leaks: string[];
  readonly jsonBytes: number;
  readonly htmlBytes: number;
}

export interface PageResult {
  readonly id: string;
  readonly browser: string;
  readonly browserVersion: string;
  readonly ranAt: string;
  readonly load: { loaded: boolean; error: string | null; finalOrigin: string; ms: number };
  readonly features: FeatureProbe | null;
  readonly mutationsIn2s: number;
  /** What the page's own response said (cached copy), and what the machine injected into it. */
  readonly network: {
    status: number | null;
    cspDirectives: string[];
    cspStyleInlineBlocked: boolean;
    injectedByAntivirus: boolean;
  } | null;
  readonly oracle: {
    rows: OracleRow[];
    truncated: boolean;
    resolved: number;
    unresolved: number;
  } | null;
  readonly auditOff: AuditCompact | null;
  readonly auditOn: AuditCompact | null;
  readonly adaptation: {
    ok: boolean;
    error: string | null;
    changes: number;
    ms: number;
    stylesheet: boolean;
    stylesheetRemovedAfterDisable: boolean;
    idleAfterMs: number;
    plan: { properties: Record<string, number>; statuses: Record<string, number> } | null;
  } | null;
  /** After adaptation: per element ratio change, judged with the same independent oracle. */
  readonly effect: {
    compared: number;
    improved: number;
    unchanged: number;
    worsened: number;
    vanished: string[];
    /** Up to 12 worsened elements (path, before->after ratio, flags) so a regression can be traced to a cause. */
    worsenedSamples: string[];
    belowTargetBefore: number;
    belowTargetAfter: number;
  } | null;
  readonly integrity: {
    /** Differences the extension could have caused: not explained by the page changing by itself (the noise control). */
    attributeDiffs: string[];
    /** Elements that changed between two probes taken before the extension did anything (the page's own activity). */
    noiseDiffCount: number;
    rawDiffCount: number;
    formValueChanges: number;
    elementCountDelta: number;
    titleChanged: boolean;
    urlChanged: boolean;
    historyLengthDelta: number;
    scrollChanged: boolean;
    layoutShifted: number;
    noiseLayoutShifted: number;
    layoutHeightDelta: number;
    /** After disabling again: the page is exactly what it was. */
    restoredAttributeDiffs: string[];
    restoredLayoutShifted: number;
  } | null;
  readonly visual: {
    noise: VisualDiff;
    adapted: VisualDiff;
    error: string | null;
  } | null;
  readonly sourceIdsStable: boolean | null;
  /** The document the measurement started on is the one it ended on (no navigation replaced it); null: not asked. */
  readonly documentStable?: boolean | null;
  /** Whether two audits with the extension doing nothing agree (false: the page itself changed between them). */
  readonly auditNoiseStable: boolean | null;
  readonly privacy: PrivacyCheck | null;
  readonly logs: LogEntry[];
  readonly timings: Record<string, number>;
}

function compactAudit(snapshot: AuditSnapshot, ms: number): AuditCompact {
  return {
    ok: true,
    error: null,
    ms,
    generation: snapshot.generation,
    pathname: snapshot.page.pathname,
    origin: snapshot.page.origin,
    coverage: snapshot.coverage,
    summary: snapshot.summary,
    findings: snapshot.findings.map((f) => ({
      id: f.id,
      rule: f.ruleId,
      assessment: f.assessment,
      severity: f.severity,
      confidence: f.confidence,
      count: f.affectedCount,
      profiles: [...f.visionProfiles],
      adaptation: f.adaptationStatus,
      sample: f.affected.slice(0, 60).map((a) => {
        const ratio = a.evidence.find((e) => e.key === 'contrast.ratio');
        const pair = a.evidence.find((e) => e.key === 'colors.pair');
        return {
          path: a.locator.path,
          tag: a.locator.tag,
          ratio: typeof ratio?.value === 'number' ? ratio.value : null,
          pair: pair ? JSON.stringify(pair.value).slice(0, 80) : null,
        };
      }),
    })),
  };
}

function failedAudit(error: string, ms: number): AuditCompact {
  return {
    ok: false,
    error,
    ms,
    generation: -1,
    findings: [],
    coverage: null,
    summary: null,
    pathname: '',
    origin: '',
  };
}

let traceBundleCache: string | null = null;

/** The injected debug trace (`realworld/tools/build-trace.mjs`), built on first use. */
function traceBundle(): string {
  if (traceBundleCache) return traceBundleCache;
  const file = path.join(ROOT, 'realworld', '.artifacts', 'trace.iife.js');
  execFileSync(process.execPath, [path.join(ROOT, 'realworld', 'tools', 'build-trace.mjs')], {
    stdio: 'ignore',
  });
  traceBundleCache = readFileSync(file, 'utf8');
  return traceBundleCache;
}

/**
 * The product's own decision (why is this element a CA-COLOR-001 finding, or why not) for the elements the
 * comparison needs, replayed inside the page by the same functions the audit uses. Read-only.
 */
export async function traceElements(
  tab: Tab,
  fulls: readonly string[],
): Promise<Record<string, { now: TraceCompact; legacy: TraceCompact } | null>> {
  if (fulls.length === 0) return {};
  // No regular expressions in this source: it travels as a template string, where backslashes are fragile.
  const source = `(function () {
    ${traceBundle()}
    const lib = __caTrace;
    const marker = ':nth-of-type(';
    const find = (full) => {
      const steps = full.split('>');
      let el = document.documentElement;
      for (let i = 1; i < steps.length; i++) {
        const at = steps[i].indexOf(marker);
        // html and body are written without an index
        const tag = at < 0 ? steps[i] : steps[i].slice(0, at);
        const nth = at < 0 ? 1 : Number(steps[i].slice(at + marker.length, steps[i].length - 1));
        let n = 0; let hit = null;
        for (const child of Array.from(el.children)) {
          if (child.localName === tag) { n++; if (n === nth) { hit = child; break; } }
        }
        if (!hit) return null;
        el = hit;
      }
      return el;
    };
    const compact = (t) => ({ stage: t.stage, reason: t.reason, reported: t.reported, foreground: t.foreground, background: t.background,
      ratio: t.ratio === null ? null : Math.round(t.ratio * 1e6) / 1e6, target: t.target, largeText: t.largeText,
      fontSizePx: t.fontSizePx === null ? null : Math.round(t.fontSizePx * 100) / 100, fontWeight: t.fontWeight, backgroundKind: t.backgroundKind });
    const out = {};
    for (const full of ${JSON.stringify(fulls)}) {
      const el = find(full);
      if (!el) { out[full] = null; continue; }
      out[full] = { now: compact(lib.traceTextElement(el)), legacy: compact(lib.traceTextElement(el, undefined, lib.CORE_ANALYZER_SELECTOR)) };
    }
    return out;
  })()`;
  return tab.evaluate<Record<string, { now: TraceCompact; legacy: TraceCompact } | null>>(source);
}

export function oracleRows(
  elements: OracleElement[],
  browser: 'chrome' | 'firefox' = 'chrome',
): OracleRow[] {
  return elements.map((e) => {
    const r = resolveContrast({
      color: e.color,
      chain: e.chain,
      darkCanvas: e.darkCanvas,
      darkCanvasRgb: browser === 'firefox' ? [28, 27, 34] : [18, 18, 18],
      effects: e.effects,
      clipText: e.clipText,
    });
    const flags = [
      e.visible ? '' : `hidden:${e.hiddenReason}`,
      e.visible && e.hiddenReason === 'offscreen' ? 'offscreen' : '',
      e.disabled ? 'disabled' : '',
      e.inert ? 'inert' : '',
      e.positioned ? 'positioned' : '',
      e.inSvg ? 'svg' : '',
      e.sensitive ? 'sensitive' : '',
      e.inShadow ? 'shadow' : '',
      e.interactive ? 'interactive' : '',
      e.displayContents ? 'contents' : '',
    ]
      .filter(Boolean)
      .join(',');
    const opacity = e.chain.reduce((product, entry) => product * entry.opacity, 1);
    return {
      path: e.path,
      full: e.full,
      tag: e.tag,
      status: r.status,
      ratio: r.ratio === null ? null : Math.round(r.ratio * 1e6) / 1e6,
      target: contrastTarget(e.fontSize, e.fontWeight),
      flags: e.textFillDiffers ? `${flags},textfill`.replace(/^,/, '') : flags,
      chars: e.textChars,
      fg: r.foreground ? toHex(r.foreground) : null,
      bg: r.background ? toHex(r.background) : null,
      fontSizePx: Math.round(e.fontSize * 100) / 100,
      fontWeight: e.fontWeight,
      opacity: Math.round(opacity * 1000) / 1000,
      occluded: e.occluded,
    };
  });
}

/** Strings that are the visitor's or the page's private data, as far as a harness can read them. */
async function collectSecrets(tab: Tab): Promise<string[]> {
  return tab.evaluate<string[]>(
    `(() => {
      const out = new Set();
      // Token-like values only (long, letters and digits): short words would collide with ordinary report text.
      const add = (v) => { if (typeof v === 'string' && v.length >= 10 && v.length <= 200 && /\\d/.test(v) && /[A-Za-z]/.test(v)) out.add(v); };
      const addAny = (v) => { if (typeof v === 'string' && v.length >= 6 && v.length <= 200) out.add(v); };
      for (const c of document.cookie.split(';')) add(c.split('=').slice(1).join('=').trim());
      if (location.search.length > 1) { add(location.search.slice(1)); for (const [, v] of new URLSearchParams(location.search)) add(v); }
      if (location.hash.length > 1) add(location.hash.slice(1));
      try { for (let i = 0; i < Math.min(localStorage.length, 30); i++) add(localStorage.getItem(localStorage.key(i))); } catch {}
      try { for (let i = 0; i < Math.min(sessionStorage.length, 30); i++) add(sessionStorage.getItem(sessionStorage.key(i))); } catch {}
      for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]),textarea')) addAny(el.value);
      for (const el of document.querySelectorAll('input[type=hidden]')) add(el.value);
      for (const el of document.querySelectorAll('[contenteditable]:not([contenteditable=false])')) addAny((el.textContent || '').trim());
      return [...out].slice(0, 200);
    })()`,
  );
}

function privacyCheck(snapshot: AuditSnapshot, secrets: string[], profile: string): PrivacyCheck {
  const report = createAuditReport(snapshot, Date.now());
  const json = serializeAuditReport(report);
  const html = renderAuditHtml(report);
  const everything = `${JSON.stringify(snapshot)}\n${json}\n${html}`;
  const leaks: string[] = [];
  // The page's own sanitized address (origin and path) is meant to be in a report: a hidden field that holds it is not a leak.
  const publicIdentity = [
    snapshot.page.origin,
    snapshot.page.pathname,
    `${snapshot.page.origin}${snapshot.page.pathname}`,
  ];
  for (const secret of secrets) {
    if (publicIdentity.some((identity) => identity.includes(secret))) continue;
    // A value that is also ordinary page text (a headline in a hidden field) is not a leak of private data by itself;
    // report every hit and let the review decide, but never print the secret: only its length and kind.
    const at = everything.indexOf(secret);
    if (at >= 0) {
      // where it sits, with the value itself masked: enough to tell page text from a real leak
      const around = `${everything.slice(Math.max(0, at - 40), at)}«secret»${everything.slice(at + secret.length, at + secret.length + 20)}`;
      leaks.push(`${secret.length}-char value near: ${around.replace(/\s+/g, ' ')}`);
    }
  }
  void profile;
  return { secretsChecked: secrets.length, leaks, jsonBytes: json.length, htmlBytes: html.length };
}

function diffDigests(before: string[], after: string[], limit = 12): string[] {
  const out: string[] = [];
  const n = Math.min(before.length, after.length);
  for (let i = 0; i < n && out.length < limit; i++) {
    if (before[i] !== after[i]) {
      const a = before[i]!.split('|');
      const b = after[i]!.split('|');
      const changed = [...new Set([...a, ...b])].filter((x) => !(a.includes(x) && b.includes(x)));
      out.push(`${a[0]}: ${changed.map((c) => c.split('=')[0]).join(',')}`);
    }
  }
  return out;
}

function shifted(a: number[][], b: number[][]): number {
  const n = Math.min(a.length, b.length);
  let moved = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1, w1, h1] = a[i]!;
    const [x2, y2, w2, h2] = b[i]!;
    if (
      Math.abs(x1! - x2!) > 2 ||
      Math.abs(y1! - y2!) > 2 ||
      Math.abs(w1! - w2!) > 2 ||
      Math.abs(h1! - h2!) > 2
    )
      moved++;
  }
  return moved + Math.abs(a.length - b.length);
}

export interface RunOptions {
  readonly settleMs?: number;
  readonly oracleLimit?: number;
  readonly screenshots?: boolean;
  readonly privacy?: boolean;
  /** Save the OFF and ON viewport screenshots here as `<id>-off.png` / `<id>-on.png` (for looking at a flagged page). */
  readonly shotsDir?: string;
}

export async function analyzePage(
  driver: Driver,
  tab: Tab,
  entry: { id: string; url: string },
  options: RunOptions = {},
): Promise<PageResult> {
  const settleMs = options.settleMs ?? 2500;
  const oracleLimit = options.oracleLimit ?? 3000;
  const timings: Record<string, number> = {};
  const logs: LogEntry[] = [];
  const mark = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      timings[name] = Date.now() - t;
    }
  };

  await driver.setSettings(OFF_SETTINGS);
  const opened = await mark('load', () => tab.open(entry.url));
  const finalOrigin = (() => {
    try {
      return new URL(opened.url).origin;
    } catch {
      return '';
    }
  })();
  const base = {
    id: entry.id,
    browser: driver.name,
    browserVersion: driver.version,
    ranAt: new Date().toISOString(),
    load: { loaded: opened.loaded, error: opened.error, finalOrigin, ms: timings['load']! },
  };
  const empty = {
    documentStable: null,
    features: null,
    mutationsIn2s: 0,
    network: null,
    oracle: null,
    auditOff: null,
    auditOn: null,
    adaptation: null,
    effect: null,
    integrity: null,
    visual: null,
    sourceIdsStable: null,
    auditNoiseStable: null,
    privacy: null,
  };
  if (!opened.url.startsWith('http')) {
    logs.push(...tab.drainLogs());
    return { ...base, ...empty, logs, timings };
  }
  await sleep(settleMs);
  // A slow page can still be "loading" after the settle time, and some pages replace themselves once
  // (a bot-check or consent interstitial that reloads into the real page): the content script of the first
  // document is gone and the second is not there yet. Wait (bounded) for a state that is complete, answered
  // by the content script and unchanged for 1.5 s. A page that never gets there is measured as before, and the
  // failed audit call then reports it.
  const stateOf = () =>
    tab.evaluate<string>(
      `document.readyState + '|' + location.href + '|' + document.getElementsByTagName('*').length`,
    );
  let lastWaitError = '';
  let ready = false;
  for (let waited = 0; waited < 25_000 && !ready; waited += 500) {
    try {
      const first = await stateOf();
      if (!first.startsWith('complete|')) throw new Error(`document is ${first.split('|')[0]}`);
      await tab.ext('GET_DYNAMIC_DIAGNOSTICS');
      await sleep(1500);
      const second = await stateOf();
      if (second !== first) throw new Error('document changed while waiting');
      await tab.ext('GET_DYNAMIC_DIAGNOSTICS');
      ready = true;
      if (waited > 0)
        logs.push({ level: 'harness', text: `page stable after ${waited} ms`, source: 'harness' });
    } catch (e) {
      lastWaitError = (e as Error).message;
      await sleep(500);
    }
  }
  if (!ready)
    logs.push({
      level: 'harness',
      text: `page never became stable: ${lastWaitError}`.slice(0, 200),
      source: 'harness',
    });
  logs.push(...tab.drainLogs());
  const identityAt = async (): Promise<DocumentIdentity> =>
    parseDocumentIdentity(await tab.evaluate<string>(DOCUMENT_IDENTITY_SOURCE));
  const identityStart = await identityAt().catch(() => null);

  let features: FeatureProbe | null = null;
  try {
    features = await mark('features', () => tab.evaluate<FeatureProbe>(call(featureProbe)));
  } catch (e) {
    logs.push({
      level: 'harness',
      text: `featureProbe: ${(e as Error).message}`.slice(0, 200),
      source: 'harness',
    });
  }
  let mutations = 0;
  try {
    mutations = await tab.evaluate<number>(
      `new Promise((resolve) => { let n = 0; const o = new MutationObserver((l) => { n += l.length; }); o.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); setTimeout(() => { o.disconnect(); resolve(n); }, 2000); })`,
    );
  } catch {
    // keep 0
  }

  let network: PageResult['network'] = null;
  try {
    // The page only reports raw strings; the policy is parsed here, in Node (see csp.ts for why).
    const raw = await tab.evaluate<{
      status: number | null;
      header: string;
      meta: string[];
      injectedByAntivirus: boolean;
    }>(
      `(async () => {
        let status = null; let header = '';
        try { const r = await fetch(location.href, { cache: 'force-cache', credentials: 'same-origin' }); status = r.status; header = r.headers.get('content-security-policy') || ''; r.body && r.body.cancel(); } catch (e) {}
        const meta = Array.from(document.querySelectorAll('meta[http-equiv]')).filter((m) => m.getAttribute('http-equiv').toLowerCase() === 'content-security-policy').map((m) => m.content);
        const all = (header + ';' + meta.join(';')).toLowerCase();
        return {
          status, header, meta,
          injectedByAntivirus: all.indexOf('kaspersky') >= 0 || document.querySelector('script[src*="kaspersky" i],link[href*="kaspersky" i]') !== null,
        };
      })()`,
    );
    network = {
      status: raw.status,
      ...parseCsp(raw.header, raw.meta),
      injectedByAntivirus: raw.injectedByAntivirus,
    };
  } catch {
    // unknown
  }

  let before: OracleElement[] = [];
  let oracleTruncated = false;
  let traces: Record<string, { now: TraceCompact; legacy: TraceCompact } | null> = {};
  try {
    const probe = await mark('oracle', () =>
      tab.evaluate<{ elements: OracleElement[]; truncated: boolean }>(
        call(oracleProbe, oracleLimit),
      ),
    );
    before = probe.elements;
    oracleTruncated = probe.truncated;
    // The product's own decision for the same elements, in the same moment as the oracle: a page that animates
    // (a fade-in, a carousel) must not be measured twice in two states.
    try {
      traces = await mark('trace', () =>
        traceElements(
          tab,
          before.filter((e) => e.textChars > 0 && !e.inSvg).map((e) => e.full),
        ),
      );
    } catch (e) {
      logs.push({
        level: 'harness',
        text: `trace: ${(e as Error).message}`.slice(0, 200),
        source: 'harness',
      });
    }
  } catch (e) {
    logs.push({
      level: 'harness',
      text: `oracleProbe: ${(e as Error).message}`.slice(0, 200),
      source: 'harness',
    });
  }
  const beforeRows = oracleRows(before, driver.name).map((row) =>
    row.full in traces
      ? {
          ...row,
          trace: traces[row.full]?.now ?? null,
          traceLegacy: traces[row.full]?.legacy ?? null,
        }
      : row,
  );

  let integrityBefore: IntegrityProbe | null = null;
  try {
    integrityBefore = await tab.evaluate<IntegrityProbe>(call(integrityProbe, 1500));
  } catch {
    // reported as missing integrity
  }

  const withShots = options.screenshots !== false;
  let off1: Buffer | null = null;
  let off2: Buffer | null = null;
  if (withShots) {
    try {
      off1 = await mark('shot', () => tab.screenshot());
      await sleep(400);
      off2 = await tab.screenshot();
    } catch {
      off1 = off2 = null;
    }
  }

  let secrets: string[] = [];
  if (options.privacy !== false) secrets = await collectSecrets(tab).catch(() => []);

  // -- audit with adaptation off ----------------------------------------------------------------------
  let auditOff: AuditCompact;
  let snapshotOff: AuditSnapshot | null = null;
  {
    const t = Date.now();
    try {
      snapshotOff = await tab.ext<AuditSnapshot>('AUDIT_RUN', { scope: 'auto' });
      auditOff = compactAudit(snapshotOff, Date.now() - t);
    } catch (e) {
      auditOff = failedAudit(String((e as Error).message).slice(0, 200), Date.now() - t);
    }
  }
  let privacy: PrivacyCheck | null = null;
  if (snapshotOff && options.privacy !== false) {
    try {
      privacy = privacyCheck(snapshotOff, secrets, driver.name);
    } catch (e) {
      logs.push({
        level: 'harness',
        text: `privacyCheck: ${(e as Error).message}`.slice(0, 200),
        source: 'harness',
      });
    }
  }
  logs.push(...tab.drainLogs());

  const identityEnd = await identityAt().catch(() => null);
  const documentStable =
    identityStart && identityEnd ? sameDocument(identityStart, identityEnd) : null;

  // -- noise control: the same probe and audit again, with the extension still doing nothing ---------------
  let integrityNoise: IntegrityProbe | null = null;
  let auditNoise: AuditCompact | null = null;
  try {
    integrityNoise = await tab.evaluate<IntegrityProbe>(call(integrityProbe, 1500));
    const snap = await tab.ext<AuditSnapshot>('AUDIT_RUN', { scope: 'auto' });
    auditNoise = compactAudit(snap, 0);
  } catch {
    // reported as not measured
  }

  // -- adaptation on ----------------------------------------------------------------------------------
  let adaptation: PageResult['adaptation'] = null;
  {
    const t = Date.now();
    try {
      await driver.setSettings(ON_SETTINGS);
      const plan = await tab.ext<{
        changes: Array<{ property: string; confidence: string }>;
      }>('ENABLE_ADAPTATION');
      const ms = Date.now() - t;
      // wait for the dynamic pipeline to settle (bounded; never a fixed sleep as the only signal)
      let idleAfterMs = 0;
      const t2 = Date.now();
      for (let i = 0; i < 30; i++) {
        const diag = await tab
          .ext<{ state: string }>('GET_DYNAMIC_DIAGNOSTICS')
          .catch(() => ({ state: 'ERR' }));
        if (diag.state === 'IDLE') break;
        await sleep(300);
      }
      idleAfterMs = Date.now() - t2;
      const properties: Record<string, number> = {};
      const statuses: Record<string, number> = {};
      for (const c of plan.changes) {
        properties[c.property] = (properties[c.property] ?? 0) + 1;
        statuses[c.confidence] = (statuses[c.confidence] ?? 0) + 1;
      }
      adaptation = {
        ok: true,
        error: null,
        changes: plan.changes.length,
        ms,
        stylesheet: await tab.evaluate<boolean>(
          `!!document.getElementById('coloradapt-stylesheet')`,
        ),
        stylesheetRemovedAfterDisable: false,
        idleAfterMs,
        plan: { properties, statuses },
      };
    } catch (e) {
      adaptation = {
        ok: false,
        error: String((e as Error).message).slice(0, 200),
        changes: 0,
        ms: Date.now() - t,
        stylesheet: false,
        stylesheetRemovedAfterDisable: false,
        idleAfterMs: 0,
        plan: null,
      };
    }
  }
  await sleep(800);
  logs.push(...tab.drainLogs());

  let afterRows: OracleRow[] = [];
  let integrityAfter: IntegrityProbe | null = null;
  let on1: Buffer | null = null;
  try {
    const probe = await tab.evaluate<{ elements: OracleElement[]; truncated: boolean }>(
      call(oracleProbe, oracleLimit),
    );
    afterRows = oracleRows(probe.elements, driver.name);
    integrityAfter = await tab.evaluate<IntegrityProbe>(call(integrityProbe, 1500));
    if (withShots) on1 = await tab.screenshot();
  } catch (e) {
    logs.push({
      level: 'harness',
      text: `after: ${(e as Error).message}`.slice(0, 200),
      source: 'harness',
    });
  }

  // -- audit with adaptation on (source findings must be unchanged) ---------------------------------------
  let auditOn: AuditCompact | null = null;
  {
    const t = Date.now();
    try {
      const snap = await tab.ext<AuditSnapshot>('AUDIT_RUN', { scope: 'auto' });
      auditOn = compactAudit(snap, Date.now() - t);
    } catch (e) {
      auditOn = failedAudit(String((e as Error).message).slice(0, 200), Date.now() - t);
    }
  }
  logs.push(...tab.drainLogs());

  // -- disable again: the page has to be what it was ----------------------------------------------------
  let restored: IntegrityProbe | null = null;
  try {
    await tab.ext('DISABLE_ADAPTATION');
    await sleep(500);
    if (adaptation) {
      adaptation = {
        ...adaptation,
        stylesheetRemovedAfterDisable: await tab.evaluate<boolean>(
          `!document.getElementById('coloradapt-stylesheet')`,
        ),
      };
    }
    restored = await tab.evaluate<IntegrityProbe>(call(integrityProbe, 1500));
  } catch (e) {
    logs.push({
      level: 'harness',
      text: `disable: ${(e as Error).message}`.slice(0, 200),
      source: 'harness',
    });
  }
  logs.push(...tab.drainLogs());
  await driver.setSettings(OFF_SETTINGS);

  // -- judgements ------------------------------------------------------------------------------------------
  const afterByPath = new Map(afterRows.map((r) => [r.full, r]));
  const effect: PageResult['effect'] = (() => {
    if (beforeRows.length === 0 || afterRows.length === 0) return null;
    let compared = 0;
    let improved = 0;
    let unchanged = 0;
    let worsened = 0;
    let belowBefore = 0;
    let belowAfter = 0;
    const vanished: string[] = [];
    const worsenedSamples: string[] = [];
    for (const r of beforeRows) {
      const a = afterByPath.get(r.full);
      if (
        !a ||
        r.status !== 'RESOLVED' ||
        a.status !== 'RESOLVED' ||
        r.ratio === null ||
        a.ratio === null
      )
        continue;
      if (r.flags.includes('hidden') || r.flags.includes('disabled')) continue;
      compared++;
      if (r.ratio < r.target) belowBefore++;
      if (a.ratio < a.target) belowAfter++;
      if (a.ratio > r.ratio + 0.05) improved++;
      else if (a.ratio < r.ratio - 0.05) {
        worsened++;
        if (worsenedSamples.length < 12)
          worsenedSamples.push(`${r.path} ${r.ratio}->${a.ratio} [${r.flags}] t${r.target}`);
        if (a.ratio < 1.5 && r.ratio >= 3) vanished.push(`${r.path} ${r.ratio}->${a.ratio}`);
      } else unchanged++;
    }
    return {
      compared,
      improved,
      unchanged,
      worsened,
      vanished: vanished.slice(0, 20),
      worsenedSamples,
      belowTargetBefore: belowBefore,
      belowTargetAfter: belowAfter,
    };
  })();

  const integrity: PageResult['integrity'] = (() => {
    if (!integrityBefore || !integrityAfter) return null;
    const changedAt = (x: string[], y: string[]): Set<number> => {
      const out = new Set<number>();
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) out.add(i);
      return out;
    };
    const noiseIdx = integrityNoise
      ? changedAt(integrityBefore.digests, integrityNoise.digests)
      : new Set<number>();
    const attributable = (other: IntegrityProbe): string[] => {
      const out: string[] = [];
      for (const i of changedAt(integrityBefore.digests, other.digests)) {
        if (noiseIdx.has(i)) continue;
        const [d] = diffDigests([integrityBefore.digests[i]!], [other.digests[i]!]);
        out.push(`${d ?? ''} @${i}`);
        if (out.length >= 12) break;
      }
      return out;
    };
    const noiseShifted = integrityNoise ? shifted(integrityBefore.rects, integrityNoise.rects) : 0;
    return {
      attributeDiffs: attributable(integrityAfter),
      noiseDiffCount: noiseIdx.size,
      rawDiffCount: changedAt(integrityBefore.digests, integrityAfter.digests).size,
      formValueChanges: integrityBefore.formValues.filter(
        (v, i) => v !== integrityAfter.formValues[i],
      ).length,
      elementCountDelta: integrityAfter.elementCount - integrityBefore.elementCount,
      titleChanged: integrityBefore.title !== integrityAfter.title,
      urlChanged: integrityBefore.href !== integrityAfter.href,
      historyLengthDelta: integrityAfter.historyLength - integrityBefore.historyLength,
      scrollChanged:
        integrityBefore.scrollX !== integrityAfter.scrollX ||
        integrityBefore.scrollY !== integrityAfter.scrollY,
      layoutShifted: Math.max(
        0,
        shifted(integrityBefore.rects, integrityAfter.rects) - noiseShifted,
      ),
      noiseLayoutShifted: noiseShifted,
      layoutHeightDelta: integrityAfter.scrollHeight - integrityBefore.scrollHeight,
      restoredAttributeDiffs: restored ? attributable(restored) : ['not measured'],
      restoredLayoutShifted: restored
        ? Math.max(0, shifted(integrityBefore.rects, restored.rects) - noiseShifted)
        : -1,
    };
  })();

  if (options.shotsDir && off1 && on1) {
    mkdirSync(options.shotsDir, { recursive: true });
    writeFileSync(path.join(options.shotsDir, `${entry.id}-off.png`), off1);
    writeFileSync(path.join(options.shotsDir, `${entry.id}-on.png`), on1);
  }
  let visual: PageResult['visual'] = null;
  if (off1 && off2 && on1) {
    try {
      const a = decodePng(off1);
      const b = decodePng(off2);
      const c = decodePng(on1);
      visual = { noise: compareBitmaps(a, b), adapted: compareBitmaps(a, c), error: null };
    } catch (e) {
      visual = null;
      logs.push({
        level: 'harness',
        text: `visual: ${(e as Error).message}`.slice(0, 200),
        source: 'harness',
      });
    }
  }

  const ids = (a: AuditCompact | null) =>
    a === null
      ? null
      : a.findings
          .filter((f) => f.rule !== 'CA-COLOR-003')
          .map((f) => f.id)
          .sort()
          .join(',');
  const sourceIdsStable =
    auditOn && auditOn.ok && auditOff.ok ? ids(auditOn) === ids(auditOff) : null;
  const auditNoiseStable =
    auditNoise && auditNoise.ok && auditOff.ok ? ids(auditNoise) === ids(auditOff) : null;

  return {
    ...base,
    features,
    mutationsIn2s: mutations,
    network,
    oracle: {
      rows: beforeRows,
      truncated: oracleTruncated,
      resolved: beforeRows.filter((r) => r.status === 'RESOLVED').length,
      unresolved: beforeRows.filter((r) => r.status !== 'RESOLVED').length,
    },
    auditOff,
    auditOn,
    adaptation,
    effect,
    integrity,
    visual,
    sourceIdsStable,
    documentStable,
    auditNoiseStable,
    privacy,
    logs,
    timings,
  };
}
