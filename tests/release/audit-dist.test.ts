import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * M12 (P13, P23): the release gate (scripts/release/audit-dist.mjs) fails when a build widens what the
 * extension may do or ships something it should not. The gate runs on a synthetic bundle here (the real
 * bundles are built after the tests in `pnpm verify`, and audited by `pnpm audit:dist`).
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const GOLDEN = JSON.parse(
  readFileSync(path.join(ROOT, 'docs', 'm12', 'permission-surface.json'), 'utf8'),
) as Record<string, Record<string, unknown>>;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function manifestFor(name: 'chrome-mv3' | 'firefox-mv2'): Record<string, unknown> {
  const g = GOLDEN[name]!;
  const scripts = g['content_scripts'] as Array<{ matches: string[] }>;
  return {
    manifest_version: g['manifest_version'],
    name: 'ColorAdapt',
    version: '0.1.0',
    permissions: g['permissions'],
    ...(name === 'chrome-mv3' ? { host_permissions: g['host_permissions'] } : {}),
    background: g['background'],
    content_security_policy: g['content_security_policy'],
    content_scripts: scripts.map((s) => ({
      matches: s.matches,
      js: ['content-scripts/content.js'],
    })),
  };
}

function bundle(
  mutate: (manifest: Record<string, unknown>, files: Map<string, string>) => void = () => undefined,
): string {
  const dist = mkdtempSync(path.join(tmpdir(), 'ca-dist-'));
  dirs.push(dist);
  const manifest = manifestFor('chrome-mv3');
  const files = new Map<string, string>([
    ['content-scripts/content.js', 'console.log("ok");'],
    ['background.js', 'export {};'],
    ['popup.html', '<!doctype html><script type="module" src="popup.js"></script>'],
  ]);
  mutate(manifest, files);
  mkdirSync(path.join(dist, 'chrome-mv3', 'content-scripts'), { recursive: true });
  writeFileSync(path.join(dist, 'chrome-mv3', 'manifest.json'), JSON.stringify(manifest));
  for (const [rel, text] of files) {
    writeFileSync(path.join(dist, 'chrome-mv3', rel), text);
  }
  return dist;
}

function gate(dist: string): { status: number | null; output: string } {
  const run = spawnSync(
    process.execPath,
    [
      path.join(ROOT, 'scripts', 'release', 'audit-dist.mjs'),
      '--dist',
      dist,
      '--require',
      'chrome-mv3',
    ],
    { encoding: 'utf8' },
  );
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe('release gate (audit-dist)', () => {
  it('passes a bundle that matches the frozen permission surface', () => {
    const result = gate(bundle());
    expect(result.output).toContain('ok   chrome-mv3');
    expect(result.status).toBe(0);
  });

  const widenings: Array<[string, Parameters<typeof bundle>[0]]> = [
    ['an added browser permission', (m) => (m['permissions'] = ['storage', 'tabs'])],
    ['<all_urls> as a host permission', (m) => (m['host_permissions'] = ['<all_urls>'])],
    ['a wider host permission', (m) => (m['host_permissions'] = ['*://*/*'])],
    [
      'a wider content-script match',
      (m) =>
        (m['content_scripts'] = [{ matches: ['<all_urls>'], js: ['content-scripts/content.js'] }]),
    ],
    [
      'content scripts in every frame',
      (m) =>
        (m['content_scripts'] = [
          {
            matches: ['http://*/*', 'https://*/*'],
            all_frames: true,
            js: ['content-scripts/content.js'],
          },
        ]),
    ],
    [
      'an exposed web-accessible resource',
      (m) => (m['web_accessible_resources'] = [{ resources: ['*'], matches: ['<all_urls>'] }]),
    ],
    ['externally_connectable', (m) => (m['externally_connectable'] = { matches: ['https://*/*'] })],
    [
      'a CSP override',
      (m) => (m['content_security_policy'] = { extension_pages: "script-src 'unsafe-eval'" }),
    ],
    [
      'a connect-src that reaches the internet',
      (m) =>
        (m['content_security_policy'] = {
          extension_pages: "script-src 'self'; object-src 'self'; connect-src 'self' https://*",
        }),
    ],
    [
      'a missing policy',
      (m) => {
        delete m['content_security_policy'];
      },
    ],
    [
      'unsafe-inline scripts',
      (m) =>
        (m['content_security_policy'] = {
          extension_pages:
            "script-src 'self' 'unsafe-inline'; object-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:*",
        }),
    ],
    ['an optional permission', (m) => (m['optional_permissions'] = ['history'])],
    ['an unknown manifest key', (m) => (m['commands'] = {})],
    [
      'an IPv6 loopback source the browsers cannot parse',
      (m) =>
        (m['content_security_policy'] = {
          extension_pages:
            "script-src 'self'; object-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:* http://[::1]:*",
        }),
    ],
  ];
  for (const [name, mutate] of widenings) {
    it(`fails on ${name}`, () => {
      const result = gate(bundle(mutate));
      expect(result.status).toBe(1);
    });
  }

  const unsafe: Array<[string, string, string]> = [
    ['a source map file', 'content-scripts/content.js.map', '{}'],
    ['a test file', 'content-scripts/thing.test.js', 'x'],
    ['a markdown note', 'NOTES.md', '# notes'],
    ['an image that is not an icon', 'screenshot-01.png', 'x'],
    ['a fake icon', 'icon-16.png', 'not a png'],
    ['eval', 'content-scripts/extra.js', 'eval("1")'],
    ['new Function', 'content-scripts/extra.js', 'new Function("return 1")'],
    ['a remote import', 'content-scripts/extra.js', 'import("https://cdn.example/x.js")'],
    ['a History API wrapper', 'content-scripts/extra.js', 'history.pushState = function () {};'],
    ['a source map reference', 'content-scripts/extra.js', '//# sourceMappingURL=x.js.map'],
    [
      'an absolute host path',
      'content-scripts/extra.js',
      'const p = "C:\\\\Users\\\\someone\\\\proj";',
    ],
    [
      'a network literal to an unlisted host',
      'content-scripts/extra.js',
      'const u = "https://telemetry.example/x";',
    ],
    ['a credential', 'content-scripts/extra.js', 'const k = "AKIAABCDEFGHIJKLMNOP";'],
    ['a remote script tag', 'page.html', '<script src="https://cdn.example/x.js"></script>'],
    ['an inline script', 'page.html', '<script>alert(1)</script>'],
  ];
  for (const [name, rel, text] of unsafe) {
    it(`fails on ${name}`, () => {
      const result = gate(bundle((_m, files) => files.set(rel, text)));
      expect(result.status).toBe(1);
    });
  }

  it('fails when a required bundle is missing', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'ca-dist-'));
    dirs.push(empty);
    expect(gate(empty).status).toBe(1);
  });

  describe('manifest parity between the browsers (P16)', () => {
    function both(mutateFirefox: (m: Record<string, unknown>) => void = () => undefined): string {
      const dist = bundle();
      const firefox = path.join(dist, 'firefox-mv2');
      mkdirSync(path.join(firefox, 'content-scripts'), { recursive: true });
      const manifest = manifestFor('firefox-mv2');
      manifest['name'] = 'ColorAdapt';
      manifest['browser_specific_settings'] = {
        gecko: {
          id: 'coloradapt@melkumyan',
          strict_min_version: '140.0',
          data_collection_permissions: { required: ['none'], optional: ['websiteContent'] },
        },
      };
      mutateFirefox(manifest);
      writeFileSync(path.join(firefox, 'manifest.json'), JSON.stringify(manifest));
      writeFileSync(path.join(firefox, 'content-scripts', 'content.js'), 'console.log("ok");');
      writeFileSync(path.join(firefox, 'background.js'), 'export {};');
      return dist;
    }
    const run = (dist: string) =>
      spawnSync(
        process.execPath,
        [path.join(ROOT, 'scripts', 'release', 'audit-dist.mjs'), '--dist', dist],
        {
          encoding: 'utf8',
        },
      );

    it('passes when only the platform differences exist', () => {
      const result = run(both());
      expect(result.stdout + result.stderr).toContain('manifest parity');
      expect(result.status).toBe(0);
    });

    it('fails when the browsers drift apart in a way the platforms do not require', () => {
      expect(run(both((m) => (m['description'] = 'something else'))).status).toBe(1);
      expect(run(both((m) => (m['options_ui'] = { page: 'other.html' }))).status).toBe(1);
      expect(run(both((m) => (m['homepage_url'] = 'https://example.test'))).status).toBe(1);
    });
  });
});
