import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLoopbackEndpoint } from '@core/semantic-ai';
import config from '../../wxt.config';
// @ts-expect-error plain .mjs data module shared with the release scripts
import * as store from '../../scripts/release/store-data.mjs';

/**
 * M13 store-policy gates on the manifest GENERATORS (the built bundles are audited by `pnpm audit:dist` and the
 * release archives by `pnpm release:validate`): what the source would put into each store package, checked before
 * anything is built, so a policy regression fails `pnpm test`.
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..');

type Manifest = Record<string, any>;

function manifestFor(browser: 'chrome' | 'firefox'): Manifest {
  const make = config.manifest;
  if (typeof make !== 'function') throw new Error('the manifest is expected to be a function');
  const env = {
    browser,
    manifestVersion: browser === 'chrome' ? 3 : 2,
    mode: 'production',
    command: 'build',
  };
  return (make as (e: typeof env) => Manifest)(env);
}

const chrome = manifestFor('chrome');
const firefox = manifestFor('firefox');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  version: string;
};
const policyOf = (m: Manifest): string => {
  const policy: unknown = m['content_security_policy'];
  return typeof policy === 'string' ? policy : (policy as { extension_pages: string }).extension_pages;
};

describe('store manifests (generated)', () => {
  it('the release version is one value', () => {
    expect(pkg.version).toBe(store.RELEASE_VERSION);
  });

  it('names and describes the product within the Chrome limit, identically for both browsers', () => {
    expect(chrome['name']).toBe('ColorAdapt');
    expect(firefox['name']).toBe('ColorAdapt');
    expect(chrome['description']).toBe(firefox['description']);
    expect(chrome['description'].length).toBeGreaterThan(0);
    expect(chrome['description'].length).toBeLessThanOrEqual(store.PRODUCT.maxDescription);
  });

  it('keeps the minimum permission set: storage and the two web host patterns', () => {
    for (const m of [chrome, firefox]) {
      expect(m['permissions']).toEqual(['storage']);
      expect(m['host_permissions']).toEqual(['http://*/*', 'https://*/*']);
      expect(m['optional_permissions']).toBeUndefined();
      expect(m['optional_host_permissions']).toBeUndefined();
      expect(m['externally_connectable']).toBeUndefined();
      expect(m['web_accessible_resources']).toBeUndefined();
    }
  });

  it('justifies every permission and every justification has a permission', () => {
    const declared = new Set([...chrome['permissions'], ...chrome['host_permissions']]);
    expect([...declared].sort()).toEqual(Object.keys(store.PERMISSIONS).sort());
    for (const entry of Object.values<Record<string, unknown>>(store.PERMISSIONS)) {
      expect(entry['feature']).toBeTruthy();
      expect(entry['why']).toBeTruthy();
      expect(entry['review']).toBeTruthy();
    }
  });

  it('does not set a Chrome-only or Firefox-only key on the wrong package', () => {
    expect(chrome['browser_specific_settings']).toBeUndefined();
    expect(chrome['minimum_chrome_version']).toBeUndefined();
    expect(firefox['browser_specific_settings']?.gecko).toBeDefined();
  });

  it('Firefox: id, minimum version and data collection are the decided ones', () => {
    const gecko = firefox['browser_specific_settings'].gecko;
    expect(typeof gecko.id).toBe('string');
    expect(gecko.id.length).toBeGreaterThan(0);
    expect(gecko.strict_min_version).toBe(store.FIREFOX.strictMinVersion);
    expect(gecko.data_collection_permissions).toEqual(store.FIREFOX.dataCollection);
    // nothing broader than the one category the optional AI review needs
    const all = [
      ...gecko.data_collection_permissions.required,
      ...gecko.data_collection_permissions.optional,
    ];
    expect(all.sort()).toEqual(['none', 'websiteContent']);
  });

  it('declares the extension-page CSP once, with no remote, wildcard or IPv6 source', () => {
    for (const m of [chrome, firefox]) {
      const policy = policyOf(m);
      expect(policy).toBe(store.EXTENSION_PAGES_CSP);
      expect(policy).not.toMatch(
        /\[|unsafe-eval|unsafe-inline|wasm-unsafe-eval|https?:(?!\/\/(127\.0\.0\.1|localhost):\*)/,
      );
      expect(policy).not.toMatch(/(^|[\s;])(\*|http:|https:|data:|blob:)([\s;]|$)/);
      expect(/script-src ([^;]*)/.exec(policy)?.[1]).toBe("'self'");
    }
  });

  it('the CSP connect sources and the endpoint parser accept exactly the same hosts', () => {
    const connect = /connect-src ([^;]*)/.exec(store.EXTENSION_PAGES_CSP)![1]!.split(/\s+/);
    const cspHosts = connect
      .filter((s) => s !== "'self'")
      .map((s) => /^http:\/\/([^:/]+):\*$/.exec(s)?.[1])
      .sort();
    expect(cspHosts.every(Boolean)).toBe(true);
    const candidates = [
      '127.0.0.1',
      'localhost',
      '[::1]',
      '127.0.0.2',
      '0.0.0.0',
      '[::]',
      'LOCALHOST',
      '10.0.0.1',
    ];
    const accepted = candidates.filter((h) => parseLoopbackEndpoint(`http://${h}:11434`).ok).sort();
    expect(accepted).toEqual(cspHosts);
    // every accepted endpoint is covered by a CSP source, with its port
    for (const h of accepted) expect(connect).toContain(`http://${h}:*`);
  });
});

describe('icons', () => {
  it('ships real PNG icons of the declared sizes', () => {
    for (const size of [16, 32, 48, 96, 128]) {
      const file = path.join(ROOT, 'public', `icon-${size}.png`);
      expect(existsSync(file), `icon-${size}.png`).toBe(true);
      const bytes = readFileSync(file);
      expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(bytes.readUInt32BE(16)).toBe(size);
      expect(bytes.readUInt32BE(20)).toBe(size);
    }
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}
const SRC = sourceFiles(path.join(ROOT, 'src')).map((f) => readFileSync(f, 'utf8'));
const used = (rx: RegExp): boolean => SRC.some((text) => rx.test(text));

describe('permission to code', () => {
  it('`storage` is used: the settings backend calls browser.storage', () => {
    expect(used(/browser\.storage\.local/)).toBe(true);
  });

  it('every extension API the code touches needs no permission the manifest lacks', () => {
    const namespaces = new Set<string>();
    for (const text of SRC)
      for (const m of text.matchAll(/\b(?:browser|chrome)\.([a-zA-Z]+)\b/g)) namespaces.add(m[1]!);
    // namespaces that need no manifest permission, or that the manifest has
    const allowed = new Set(['runtime', 'storage', 'tabs', 'permissions']);
    expect([...namespaces].filter((n) => !allowed.has(n))).toEqual([]);
    // `tabs` used without the `tabs` permission: only messaging and create/query of tabs, never `url`/`title` reads
    // from arbitrary tabs beyond host-permission matches
    expect(
      used(/\bchrome\.(scripting|webRequest|cookies|history|downloads|alarms|notifications)\b/),
    ).toBe(false);
  });

  it('the host patterns are used: one content script on exactly those patterns', () => {
    const content = SRC.find((t) => /defineContentScript/.test(t))!;
    expect(content).toBeDefined();
    expect(content).toMatch(/matches:\s*\[\s*'http:\/\/\*\/\*'\s*,\s*'https:\/\/\*\/\*'\s*\]/);
  });

  it('no dynamic code, no remote import, no beacon, no socket in the sources', () => {
    expect(used(/\beval\s*\(|\bnew\s+Function\s*\(/)).toBe(false);
    expect(used(/\bimport\s*\(\s*['"`]https?:/)).toBe(false);
    expect(used(/\b(sendBeacon|XMLHttpRequest|WebSocket|EventSource|importScripts)\b/)).toBe(false);
  });
});
