#!/usr/bin/env node
/**
 * M12 production-artifact gate (docs/m12/protocol.md, criteria P13-P17, P29-P30).
 *
 * Reads the *built* bundles (`dist/chrome-mv3`, `dist/firefox-mv2`: whichever exist; `--require chrome-mv3,firefox-mv2`
 * makes a missing one a failure) and fails on:
 *  - a permission surface that differs from the frozen golden (docs/m12/permission-surface.json): browser
 *    permissions, host permissions, content-script matches, web-accessible resources, CSP, externally_connectable,
 *    and any manifest key that is not on the known list;
 *  - a file that should not ship (source maps, tests, fixtures, notes, env files, large blobs, anything not .js/.css/.html/.json);
 *  - code built from strings, a remote script, a remote import, `importScripts`, inline script in a page;
 *  - an absolute host path, a source-map reference, or a credential-looking string in a shipped file;
 *  - a network literal that is not on the allowlist (XML namespaces, React's error-message URL, loopback).
 *
 * Usage: node scripts/release/audit-dist.mjs [--require chrome-mv3,firefox-mv2] [--json out.json] [--dist <dir>]
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GOLDEN = JSON.parse(
  readFileSync(path.join(ROOT, 'docs', 'm12', 'permission-surface.json'), 'utf8'),
);
const TARGETS = ['chrome-mv3', 'firefox-mv2'];

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const required = (flag('--require') ?? '').split(',').filter(Boolean);
const jsonOut = flag('--json');
const DIST = path.resolve(flag('--dist') ?? path.join(ROOT, 'dist'));

const KNOWN_MANIFEST_KEYS = new Set([
  'manifest_version',
  'name',
  'description',
  'version',
  'permissions',
  'host_permissions',
  'background',
  'action',
  'browser_action',
  'options_ui',
  'content_scripts',
  'browser_specific_settings',
  'content_security_policy',
]);
const ALLOWED_EXTENSIONS = new Set(['.js', '.css', '.html', '.json']);
const MAX_FILE_BYTES = 600 * 1024;
const FORBIDDEN_NAME =
  /(\.map$|\.test\.|\.spec\.|fixture|scratch|probe|\.env|\.pem$|\.key$|\.log$|\.md$|\.ts$|\.tsx$|\.zip$|\.gguf$|\.onnx$|\.bin$)/i;

/** Network-looking literals that are not requests: XML namespaces, React's production error pointer. */
const ALLOWED_URL_HOSTS = ['www.w3.org', 'react.dev', '127.0.0.1', 'localhost', '[::1]'];

const CREDENTIAL_PATTERNS = [
  ['aws access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['github token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['anthropic/openai style key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}/],
  ['google api key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];
const HOST_PATH =
  /(?:[A-Za-z]:[\\/]+(?:Users|project|temp|Documents)[\\/]+|\/home\/[a-z]|\/Users\/[A-Za-z])/;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** The part of a manifest that grants authority or exposure; what the golden freezes. */
export function surfaceOf(manifest) {
  const scripts = manifest.content_scripts ?? [];
  return {
    manifest_version: manifest.manifest_version,
    permissions: [...(manifest.permissions ?? [])].sort(),
    optional_permissions: [...(manifest.optional_permissions ?? [])].sort(),
    host_permissions: [...(manifest.host_permissions ?? [])].sort(),
    content_scripts: scripts.map((s) => ({
      matches: [...(s.matches ?? [])].sort(),
      all_frames: s.all_frames ?? null,
      run_at: s.run_at ?? null,
      match_about_blank: s.match_about_blank ?? null,
      world: s.world ?? null,
    })),
    web_accessible_resources: manifest.web_accessible_resources ?? null,
    externally_connectable: manifest.externally_connectable ?? null,
    content_security_policy: manifest.content_security_policy ?? null,
    background: manifest.background ?? null,
    gecko_id: manifest.browser_specific_settings?.gecko?.id ?? null,
    data_collection: manifest.browser_specific_settings?.gecko?.data_collection_permissions ?? null,
  };
}

function auditBundle(name) {
  const dir = path.join(DIST, name);
  const failures = [];
  const info = { name, files: 0, bytes: 0, urls: {}, fetchSites: [] };
  const fail = (what) => failures.push(what);

  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  for (const key of Object.keys(manifest)) {
    if (!KNOWN_MANIFEST_KEYS.has(key)) fail(`manifest: unexpected key "${key}"`);
  }
  const surface = surfaceOf(manifest);
  const golden = GOLDEN[name];
  if (JSON.stringify(surface) !== JSON.stringify(golden)) {
    fail(
      `permission surface differs from docs/m12/permission-surface.json\n  built:  ${JSON.stringify(surface)}\n  frozen: ${JSON.stringify(golden)}`,
    );
  }
  const policy =
    typeof manifest.content_security_policy === 'object' &&
    manifest.content_security_policy !== null
      ? manifest.content_security_policy.extension_pages
      : manifest.content_security_policy;
  if (typeof policy !== 'string') {
    fail('manifest: no content_security_policy for extension pages');
  } else {
    if (
      /unsafe-eval|unsafe-inline|wasm-unsafe-eval|data:|blob:|https?:\/\/(?!127\.0\.0\.1|localhost|\[::1\])/.test(
        policy,
      )
    ) {
      fail(`content security policy allows more than self and the loopback: ${policy}`);
    }
    const script = /script-src ([^;]*)/.exec(policy)?.[1]?.trim();
    if (script !== "'self'") fail(`script-src must be 'self' only, is: ${script}`);
    const connect = /connect-src ([^;]*)/.exec(policy)?.[1]?.trim().split(/\s+/).sort();
    const allowed = ["'self'", 'http://127.0.0.1:*', 'http://[::1]:*', 'http://localhost:*'].sort();
    if (JSON.stringify(connect) !== JSON.stringify(allowed))
      fail(`connect-src must be self + loopback, is: ${connect}`);
  }
  if (
    manifest.permissions?.some((p) => p === '<all_urls>') ||
    surface.host_permissions.includes('<all_urls>')
  ) {
    fail('manifest: <all_urls> is not allowed');
  }

  for (const file of walk(dir)) {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    const size = statSync(file).size;
    info.files += 1;
    info.bytes += size;
    if (!ALLOWED_EXTENSIONS.has(path.extname(file)) || FORBIDDEN_NAME.test(rel)) {
      fail(`unexpected file in package: ${rel}`);
      continue;
    }
    if (size > MAX_FILE_BYTES) fail(`file larger than ${MAX_FILE_BYTES} bytes: ${rel} (${size})`);
    const text = readFileSync(file, 'utf8');
    if (text.includes('\u0000')) fail(`NUL byte in ${rel}`);
    if (/sourceMappingURL/.test(text)) fail(`source map reference in ${rel}`);
    if (HOST_PATH.test(text)) fail(`absolute host path in ${rel}: ${HOST_PATH.exec(text)[0]}`);
    for (const [label, pattern] of CREDENTIAL_PATTERNS) {
      if (pattern.test(text)) fail(`${label} pattern in ${rel}`);
    }

    if (file.endsWith('.js')) {
      if (/\beval\s*\(/.test(text)) fail(`eval( in ${rel}`);
      if (/\bnew\s+Function\s*\(/.test(text)) fail(`new Function( in ${rel}`);
      if (/\bimportScripts\s*\(/.test(text)) fail(`importScripts( in ${rel}`);
      if (/\b(pushState|replaceState)\b/.test(text))
        fail(`History API reference in ${rel} (ColorAdapt never wraps it)`);
      if (/\bimport\s*\(\s*["'`]https?:/.test(text)) fail(`remote dynamic import in ${rel}`);
      if (/\.src\s*=\s*["'`]https?:/.test(text)) fail(`remote script/src assignment in ${rel}`);
      if (/document\s*\.\s*write\s*\(/.test(text)) fail(`document.write in ${rel}`);
      const fetches = (text.match(/\bfetch\s*\(/g) ?? []).length;
      if (fetches > 0) info.fetchSites.push(`${rel}:${fetches}`);
    }
    if (file.endsWith('.html')) {
      if (/<script(?![^>]*\bsrc=)[^>]*>[^<]/i.test(text)) fail(`inline script in ${rel}`);
      if (/<script[^>]*\bsrc=["']https?:/i.test(text)) fail(`remote script in ${rel}`);
      if (/\son[a-z]+\s*=/i.test(text)) fail(`inline event handler in ${rel}`);
    }
    for (const match of text.matchAll(/https?:[/\\]+(\[[0-9a-f:]+\]|[A-Za-z0-9._-]+)/gi)) {
      const host = match[1].toLowerCase();
      info.urls[host] = (info.urls[host] ?? 0) + 1;
      if (!ALLOWED_URL_HOSTS.includes(host))
        fail(`network literal to unlisted host "${host}" in ${rel}`);
    }
  }
  info.permissionSurface = surface;
  return { info, failures };
}

const results = [];
let failed = false;
for (const name of TARGETS) {
  if (!existsSync(path.join(DIST, name, 'manifest.json'))) {
    if (required.includes(name)) {
      console.error(`FAIL ${name}: required bundle is not built`);
      failed = true;
    } else {
      console.log(`skip ${name}: not built`);
    }
    continue;
  }
  const { info, failures } = auditBundle(name);
  results.push({ ...info, failures });
  if (failures.length > 0) {
    failed = true;
    console.error(`FAIL ${name} (${info.files} files, ${info.bytes} bytes)`);
    for (const f of failures) console.error(`  - ${f}`);
  } else {
    console.log(
      `ok   ${name}: ${info.files} files, ${info.bytes} bytes, surface = golden, fetch sites ${info.fetchSites.length}, hosts ${Object.keys(info.urls).join(', ')}`,
    );
  }
}

/**
 * Manifest parity (P16): the two browsers differ where the platforms do (manifest version, where host patterns
 * are listed, background form, action key, the Firefox add-on id) and nowhere else: the same name, description,
 * version, host patterns, content-script matches and set of permissions.
 */
function parityFailures() {
  const read = (n) => JSON.parse(readFileSync(path.join(DIST, n, 'manifest.json'), 'utf8'));
  const [c, f] = [read('chrome-mv3'), read('firefox-mv2')];
  const hostsOf = (m) =>
    [
      ...(m.host_permissions ?? []),
      ...(m.permissions ?? []).filter((p) => /^https?:|^<all_urls>|^\*:/.test(p)),
    ].sort();
  const apiOf = (m) =>
    (m.permissions ?? []).filter((p) => !/^https?:|^<all_urls>|^\*:/.test(p)).sort();
  const out = [];
  for (const key of ['name', 'description', 'version']) {
    if (c[key] !== f[key]) out.push(`${key} differs: ${c[key]} / ${f[key]}`);
  }
  if (JSON.stringify(hostsOf(c)) !== JSON.stringify(hostsOf(f)))
    out.push('host patterns differ between browsers');
  if (JSON.stringify(apiOf(c)) !== JSON.stringify(apiOf(f)))
    out.push('API permissions differ between browsers');
  if (JSON.stringify(c.content_scripts) !== JSON.stringify(f.content_scripts))
    out.push('content_scripts differ between browsers');
  if (JSON.stringify(c.options_ui) !== JSON.stringify(f.options_ui))
    out.push('options_ui differs between browsers');
  // MV3 takes a policy per page type, Firefox's MV2 build one string: the effective policy for extension pages is
  // what must match
  const policyOf = (m) =>
    typeof m.content_security_policy === 'object' && m.content_security_policy !== null
      ? m.content_security_policy.extension_pages
      : m.content_security_policy;
  if (policyOf(c) !== policyOf(f)) out.push('extension page policy differs between browsers');
  const known = new Set([
    'content_security_policy',
    'manifest_version',
    'host_permissions',
    'permissions',
    'background',
    'action',
    'browser_action',
    'browser_specific_settings',
  ]);
  const keys = new Set([...Object.keys(c), ...Object.keys(f)]);
  for (const k of keys) {
    if (known.has(k)) continue;
    if (JSON.stringify(c[k]) !== JSON.stringify(f[k])) out.push(`unexpected difference in "${k}"`);
  }
  return out;
}
if (results.length === 2) {
  const parity = parityFailures();
  if (parity.length > 0) {
    failed = true;
    console.error('FAIL manifest parity');
    for (const p of parity) console.error(`  - ${p}`);
  } else {
    console.log(
      'ok   manifest parity: only the platform differences (manifest version, host list, background, action, gecko id)',
    );
  }
}
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(results, null, 2)}\n`);
process.exit(failed ? 1 : 0);
