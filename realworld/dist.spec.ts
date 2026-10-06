/**
 * Static checks of the *production bundles* that ship (no browser): what each manifest asks for, that neither
 * bundle needs `unsafe-eval` or builds code from strings, never wraps the History API, and that the Firefox
 * bundle reaches the extension API only through the standard `browser` namespace (with WXT's `chrome` fallback),
 * never through a Chrome-only API. Run after `pnpm build` and `pnpm build:firefox`.
 */
import { expect, test } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/driver';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

const BUNDLES = {
  chrome: path.join(ROOT, 'dist', 'chrome-mv3'),
  firefox: path.join(ROOT, 'dist', 'firefox-mv2'),
} as const;

for (const [name, dir] of Object.entries(BUNDLES)) {
  test.describe(`bundle ${name}`, () => {
    test.skip(!existsSync(dir), `${dir} not built`);
    const manifest = () =>
      JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    const js = () =>
      files(dir)
        .filter((f) => f.endsWith('.js'))
        .map((f) => ({ file: path.relative(dir, f), text: readFileSync(f, 'utf8') }));

    test('asks for the least it needs', () => {
      const m = manifest();
      const permissions = m['permissions'] as string[];
      // MV2 lists host patterns among the permissions; MV3 has `host_permissions`
      const nonHost = permissions.filter((p) => !/^https?:\/\//.test(p));
      expect(nonHost).toEqual(['storage']);
      const hosts =
        (m['host_permissions'] as string[] | undefined) ??
        permissions.filter((p) => /^https?:\/\//.test(p));
      expect([...hosts].sort()).toEqual(['http://*/*', 'https://*/*']);
      expect(m['content_security_policy']).toBeUndefined(); // no override of the extension CSP
      expect(m['web_accessible_resources']).toBeUndefined(); // no page can load our files
      expect(m['externally_connectable']).toBeUndefined(); // no page can message us
      const scripts = m['content_scripts'] as Array<Record<string, unknown>>;
      expect(scripts).toHaveLength(1);
      expect(scripts[0]!['all_frames']).toBeUndefined(); // top frame only: the documented iframe limit
      expect(scripts[0]!['matches']).toEqual(['http://*/*', 'https://*/*']);
      expect(scripts[0]!['run_at']).toBeUndefined();
    });

    test('has no code built from strings and no History API wrapper', () => {
      for (const { file, text } of js()) {
        expect(text, file).not.toMatch(/\beval\s*\(/);
        expect(text, file).not.toMatch(/new\s+Function\s*\(/);
        expect(text, file).not.toMatch(/\b(pushState|replaceState)\b/);
        expect(text, file).not.toMatch(/\b(XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/);
        expect(text, file).not.toMatch(/document\s*\.\s*write\s*\(/);
        expect(text, file).not.toMatch(/\b(localStorage|sessionStorage|indexedDB)\b/);
      }
    });

    test('network use is the module preload helper, the page-image reader and the loopback model client only', () => {
      const where = js()
        .flatMap(({ file, text }) =>
          (text.match(/\bfetch\s*\(/g) ?? []).map(() =>
            file
              .split(path.sep)
              .join('/')
              .replace(/-[\w-]{8}\.js$/, '.js'),
          ),
        )
        .sort();
      // one preload helper in the shared chunk (named after whichever module the bundler put it with), the M8
      // raster reader (page images only) in the content script, and the M11 local-model client, which lives in
      // the audit page's chunk and nowhere else.
      expect(where.filter((w) => w !== 'chunks/audit.js')).toEqual([
        where.find((w) => /^chunks\/(?!audit\.js)/.test(w)),
        'content-scripts/content.js',
      ]);
      expect(where.filter((w) => w === 'chunks/audit.js')).toHaveLength(1);
    });

    test('the model client is in the audit page only, and refuses redirects and credentials', () => {
      for (const { file, text } of js()) {
        const isAudit = /^chunks\/audit-/.test(file.split(path.sep).join('/'));
        if (isAudit) {
          expect(text, file).toMatch(/redirect:\s*["'`]error["'`]/);
          expect(text, file).toMatch(/credentials:\s*["'`]omit["'`]/);
          expect(text, file).toMatch(/referrerPolicy:\s*["'`]no-referrer["'`]/);
        } else {
          // no page-facing script, and not the background, can reach a model runtime
          expect(text, file).not.toMatch(/\/v1\/semantic|\/api\/chat|v1\/health|api\/tags/);
        }
      }
    });
  });
}

test('the Firefox bundle uses only the standard extension namespace', () => {
  const dir = BUNDLES.firefox;
  test.skip(!existsSync(dir), 'firefox bundle not built');
  const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  expect(m['manifest_version']).toBe(2);
  const gecko = (
    m['browser_specific_settings'] as {
      gecko: { id: string; data_collection_permissions: unknown };
    }
  ).gecko;
  expect(gecko.id).toMatch(/^[\w.-]+@[\w.-]+$/);
  expect(gecko.data_collection_permissions).toEqual({ required: ['none'] });
  expect(m['browser_action']).toBeDefined(); // not the Chrome-only `action`
  expect(m['action']).toBeUndefined();
  for (const file of files(dir).filter((f) => f.endsWith('.js'))) {
    const text = readFileSync(file, 'utf8');
    // every direct `chrome.` use is WXT's `browser ?? chrome` fallback; none of these are Firefox-less APIs
    expect(text, file).not.toMatch(
      /\bchrome\.(action|scripting|declarativeNetRequest|sidePanel|offscreen|userScripts)\b/,
    );
    expect(text, file).not.toMatch(/\bchrome\.(runtime|tabs|storage)\./);
  }
});
