/**
 * M12.R1-P04: what is collected when the restart test fails. The failure stays the failure: this runs after the
 * original error, records, never retries `getSettings`, never touches the product's storage, and any probe that
 * fails is secondary evidence (it can neither replace the original error nor make the test pass).
 */
import path from 'node:path';
import { ROOT, FIREFOX_ID, type FirefoxDriver } from '../lib/driver';
import {
  EvidenceRecorder,
  asText,
  profileState,
  sanitizeText,
  snapshotProcesses,
  type RawError,
} from '../lib/evidence';

const P04_PROTOCOL = 'M12.R1-P04';
const P04_ARTIFACTS = path.join(ROOT, 'realworld', '.artifacts', 'm12-p04');

export function newP04Recorder(browser: string, root = P04_ARTIFACTS): EvidenceRecorder {
  return new EvidenceRecorder({
    root,
    protocol: P04_PROTOCOL,
    browser,
    extensionId: FIREFOX_ID,
    label: process.env['RW_LABEL'] ?? null,
  });
}

type Evalable = Pick<FirefoxDriver, 'extensionEval' | 'wd'>;

const EXTENSION_PROBE = `(async () => {
  const api = globalThis.browser ?? globalThis.chrome;
  return { id: typeof api.runtime.id === 'string' ? api.runtime.id : null,
           manifestVersion: api.runtime.getManifest().manifest_version,
           version: api.runtime.getManifest().version,
           page: location.pathname };
})()`;

// Value presence and type only: the settings themselves never leave the extension page.
const BACKGROUND_PROBE = `(async () => {
  const api = globalThis.browser ?? globalThis.chrome;
  const r = await api.runtime.sendMessage({ channel: 'coloradapt', type: 'GET_SETTINGS' });
  return { responded: true, type: r === null ? 'null' : Array.isArray(r) ? 'array' : typeof r,
           keyCount: r && typeof r === 'object' ? Object.keys(r).length : 0 };
})()`;

const STORAGE_PROBE = `(async () => {
  const api = globalThis.browser ?? globalThis.chrome;
  const all = await api.storage.local.get(null);
  const keys = {};
  for (const k of Object.keys(all)) {
    const v = all[k];
    keys[k] = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  }
  return { keys };
})()`;

export interface FailureInput {
  readonly recorder: EvidenceRecorder;
  /** Absent when the browser never started. */
  readonly driver: Evalable | undefined;
  readonly profileDir: string;
  readonly error: unknown;
}

/** Never throws. Writes `failure.json` and the failure-time round files. */
export async function captureFailure(input: FailureInput): Promise<void> {
  const { recorder, driver, profileDir, error } = input;
  const err = error as { name?: unknown; message?: unknown; stack?: unknown } | null;
  const original = {
    name: sanitizeText(asText(err?.name, 'Error'), 200),
    message: sanitizeText(asText(err?.message ?? error), 2000),
    stack: typeof err?.stack === 'string' ? sanitizeText(err.stack, 6000) : null,
  };
  // the primary failure is whatever failed first; everything below is marked diagnostic
  const primary = recorder.firstFailure;
  const lastRaw = recorder.lastRawError; // read before the probes below can overwrite it
  recorder.enterDiagnosticMode();
  recorder.event('diagnostic', { what: 'failure capture begins', original });

  const webdriver = driver
    ? await recorder.probe('webdriver health', () => driver.wd('GET', '/window/handles'))
    : null;
  const extension = driver
    ? await recorder.probe('extension page', () =>
        driver.extensionEval<Record<string, unknown>>(EXTENSION_PROBE),
      )
    : null;
  const background = driver
    ? await recorder.probe('background responds', () =>
        driver.extensionEval<Record<string, unknown>>(BACKGROUND_PROBE),
      )
    : null;
  const storage = driver
    ? await recorder.probe('storage independent read', () =>
        driver.extensionEval<{ keys: Record<string, string> }>(STORAGE_PROBE),
      )
    : null;
  const processes = await recorder.probe('process snapshot', () => {
    const snapshot = snapshotProcesses();
    recorder.writeProcessSnapshot('onFailure', snapshot);
    return snapshot.processes.length;
  });
  const profile = await recorder.probe('profile state', () => profileState(profileDir));

  const settled = <T>(p: { ok: true; value: T } | { ok: false; error: string } | null) =>
    p === null ? null : p.ok ? { ok: true, value: p.value } : { ok: false, error: p.error };

  const rawExtensionError: RawError | null = primary?.rawError ?? lastRaw;
  recorder.writeFailure({
    operation: primary?.name ?? 'unknown (not a recorded operation)',
    operationRecord: primary,
    originalError: original,
    rawExtensionError,
    // facts only; no root cause is recorded automatically
    webdriverHealthy: webdriver ? webdriver.ok : null,
    extensionReachable: extension ? extension.ok : null,
    backgroundResponsive: background ? background.ok : null,
    storageProbe: settled(storage),
    settingsKeyPresent: storage?.ok ? 'coloradapt:settings' in storage.value.keys : null,
    probes: {
      webdriver: settled(webdriver),
      extension: settled(extension),
      background: settled(background),
      processCount: settled(processes),
      profile: settled(profile),
    },
  });
}
