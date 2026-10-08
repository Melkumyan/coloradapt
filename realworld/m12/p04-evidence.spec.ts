/**
 * Self-check of the P04 failure-evidence harness in the real Firefox (not a P04 gate, not part of the formal
 * sequence): a REAL extension-side rejection is provoked with an invalid `storage.local.get` argument, and the
 * evidence it leaves is checked. The product is not involved; the rejection is the browser's own.
 */
import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startFirefox } from '../lib/driver';
import { captureFailure, newP04Recorder } from './p04-evidence';

test('the harness preserves a real extension-side rejection and keeps it a failure', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'p04-selfcheck-'));
  const profile = mkdtempSync(path.join(tmpdir(), 'p04-selfcheck-profile-'));
  const recorder = newP04Recorder('firefox', root);
  recorder.beginRound(0, profile);
  const driver = await startFirefox({ profileDir: profile, evidence: recorder });
  let thrown: unknown;
  try {
    await recorder.operation('storage.local.get', ['(invalid argument)'], () =>
      driver.extensionEval(
        `(async () => { const api = globalThis.browser ?? globalThis.chrome; return await api.storage.local.get(12345); })()`,
      ),
    );
  } catch (e) {
    thrown = e;
    await captureFailure({ recorder, driver, profileDir: profile, error: e });
  } finally {
    await driver.close();
    recorder.endRound();
    recorder.finish('FAIL');
  }
  try {
    expect(thrown).toBeInstanceOf(Error); // still a failure
    const failure = JSON.parse(readFileSync(path.join(recorder.dir, 'failure.json'), 'utf8')) as {
      operation: string;
      classification: string;
      rawExtensionError: { type: string; message: string | null; json: string | null } | null;
      webdriverHealthy: boolean;
      extensionReachable: boolean;
      backgroundResponsive: boolean;
      storageProbe: { ok: boolean } | null;
      originalError: { message: string };
    };
    expect(failure.operation).toBe('storage.local.get');
    expect(failure.classification).toBe('UNCLASSIFIED');
    expect(failure.rawExtensionError).not.toBeNull();
    expect(failure.rawExtensionError?.type).toBeTruthy();
    expect(failure.originalError.message).toBe((thrown as Error).message);
    // the browser was healthy and the independent read worked: the rejection was the call's own
    expect(failure.webdriverHealthy).toBe(true);
    expect(failure.extensionReachable).toBe(true);
    expect(failure.backgroundResponsive).toBe(true);
    expect(failure.storageProbe?.ok).toBe(true);
    expect(
      readFileSync(path.join(recorder.dir, 'round-0', 'firefox.log'), 'utf8').length,
    ).toBeGreaterThan(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  }
});
