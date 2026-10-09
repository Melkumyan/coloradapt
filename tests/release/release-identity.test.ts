import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../../wxt.config';

/**
 * M13.R1 release identity: the permanent Firefox add-on id, the proprietary license and the static public pages. The id
 * cannot be changed after the first AMO upload, so a build-generation change must fail a test, not ship.
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

function firefoxManifest(): Record<string, any> {
  const make = config.manifest as (e: unknown) => Record<string, any>;
  return make({ browser: 'firefox', manifestVersion: 2, mode: 'production', command: 'build' });
}

describe('permanent Firefox add-on id', () => {
  it('is exactly coloradapt@melkumyan and valid for the signing flow', () => {
    const id = firefoxManifest()['browser_specific_settings'].gecko.id as string;
    expect(id).toBe('coloradapt@melkumyan');
    expect(id).toMatch(/^[a-z0-9-._]*@[a-z0-9-._]+$/);
  });

  it('is absent from the Chrome manifest', () => {
    const make = config.manifest as (e: unknown) => Record<string, any>;
    const chrome = make({ browser: 'chrome', manifestVersion: 3, mode: 'production', command: 'build' });
    expect(chrome['browser_specific_settings']).toBeUndefined();
  });

  it('leaves no trace of the old placeholder id in the sources', () => {
    const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\0')
      .filter((f) => f && existsSync(path.join(ROOT, f)) && !/\.(png|zip)$/.test(f));
    const old = ['coloradapt@coloradapt', 'invalid'].join('.');
    const hits = tracked.filter((f) => readFileSync(path.join(ROOT, f), 'utf8').includes(old));
    expect(hits).toEqual([]);
  });
});

describe('data-collection consent is bound to an explicit user action', () => {
  const sources = (dir: string): string[] =>
    execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', dir], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter((f) => /\.(ts|tsx)$/.test(f));

  it('permissions.request(data_collection) is reachable only from the audit hook, never from background or content', () => {
    const callers = sources('src').filter((f) => /requestWebsiteContentConsent/.test(read(f)));
    expect(callers.sort()).toEqual([
      'src/entrypoints/audit/use-semantic-assist.ts',
      'src/infrastructure/browser/data-consent.ts',
    ]);
    const raw = sources('src').filter((f) => /\.request\(\s*\{\s*data_collection/.test(read(f)));
    expect(raw).toEqual(['src/infrastructure/browser/data-consent.ts']);
    for (const f of sources('src/entrypoints').filter((x) => /entrypoints\/(background|content)/.test(x)))
      expect(read(f)).not.toMatch(/data-consent|requestWebsiteContentConsent/);
  });

  it('the single call site sits inside the handler of the explicit run action', () => {
    const hook = read('src/entrypoints/audit/use-semantic-assist.ts');
    const at = hook.indexOf('await requestWebsiteContentConsent()');
    expect(at).toBeGreaterThan(0);
    const before = hook.slice(0, at);
    // the nearest enclosing hook is the callback of the explicit run action, not an effect or a lifecycle callback
    const owner = [...before.matchAll(/(?:const (\w+) = )?use(Callback|Effect|Memo|LayoutEffect)\(/g)].pop();
    expect(owner?.[1]).toBe('run');
    expect(owner?.[2]).toBe('Callback');
    // and that action is invoked from exactly one place: the button's click handler
    const users = sources('src/entrypoints').filter((f) => /assist\.run\b/.test(read(f)));
    expect(users).toEqual(['src/entrypoints/audit/assist-components.tsx']);
    expect(read(users[0]!).match(/assist\.run\b/g)).toHaveLength(1);
    expect(read(users[0]!)).toMatch(/onClick=\{\(\) => void assist\.run\(\)\}/);
  });
});

describe('license', () => {
  it('is proprietary, all rights reserved, and invents no identity', () => {
    const text = read('LICENSE');
    expect(text).toMatch(/All Rights Reserved/i);
    expect(text).toMatch(/does not make the Software open source/);
    expect(text).toMatch(/THIRD_PARTY_NOTICES\.txt/);
    expect(text).not.toMatch(/\b(MIT|Apache|GPL|MPL|BSD)\b/);
    expect(text).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(JSON.parse(read('package.json')).license).toBe('UNLICENSED');
  });
});

describe('public pages', () => {
  it('are in sync with the canonical documents', () => {
    expect(() =>
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'release', 'public-site.mjs'), '--check'], {
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  for (const page of ['privacy', 'support']) {
    it(`${page} is pure static HTML/CSS with no active or third-party content`, () => {
      const html = read(`public-site/${page}/index.html`);
      expect(html).not.toMatch(/<script|<iframe|<form|<img|<link|<object|<embed|<video|<audio|<input|<button/i);
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html).not.toMatch(/@import|url\(|@font-face/i);
      // the only absolute links are plain anchors; nothing is loaded from a host
      const loads = [...html.matchAll(/\b(?:src|action|srcset|data)\s*=\s*"([^"]*)"/gi)];
      expect(loads).toEqual([]);
      expect(html).toContain("default-src 'none'");
      expect(html).toContain('name="viewport"');
      expect(html).toMatch(/<h1>/);
    });
  }

  it('privacy page states the optional-AI truth and makes no false absolute claim', () => {
    const text = read('public-site/privacy/index.html');
    for (const needle of ['loopback', 'websiteContent', 'no cloud AI fallback', 'disabled by default'])
      expect(text.toLowerCase()).toContain(needle.toLowerCase());
    expect(text).not.toMatch(
      /never (reads|transmits|sends)[^.]{0,40}(page|content)|no page (content|data) (ever )?leaves|does not (read|transmit) (any )?page/i,
    );
  });
});
