import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * M9.R1 architecture guards: things that must stay true of the repository, not of one feature.
 */
const ROOT = path.resolve(import.meta.dirname, '../../..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(?:ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe('the page’s History API is never hooked (frozen M4 rule, kept by the audit)', () => {
  it('no source file assigns to or wraps history.pushState / replaceState', () => {
    const offenders = sourceFiles(path.join(ROOT, 'src')).filter((file) => {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      return /(?:pushState|replaceState)\s*=[^=]|history\.(?:pushState|replaceState)\s*\(/.test(
        code,
      );
    });
    expect(offenders).toEqual([]);
  });
});

describe('known technical debt is not presented as a working audit feature', () => {
  it('the audit UI and exports never mention the per-site chart setting', () => {
    const files = [
      ...sourceFiles(path.join(ROOT, 'src/entrypoints/audit')),
      ...sourceFiles(path.join(ROOT, 'src/core/audit')),
    ];
    expect(files.filter((file) => /adaptCharts/.test(readFileSync(file, 'utf8')))).toEqual([]);
  });
});

describe('build configuration', () => {
  it('the E2E-only JSX setting does not touch the production build', async () => {
    const config = (await import('../../../wxt.config')).default as unknown as {
      vite: (env: { mode: string; command: string }) => Record<string, unknown>;
      manifest: { permissions?: string[]; host_permissions?: string[] };
    };
    const e2e = config.vite({ mode: 'e2e', command: 'build' });
    const production = config.vite({ mode: 'production', command: 'build' });
    expect(e2e.oxc).toEqual({ jsx: { development: false } });
    expect(e2e.define).toMatchObject({ 'process.env.NODE_ENV': '"production"' });
    expect(production.oxc).toBeUndefined();
    expect(production.define).toBeUndefined();
    // Both builds share the alias map.
    expect(Object.keys((production.resolve as { alias: object }).alias)).toEqual(
      Object.keys((e2e.resolve as { alias: object }).alias),
    );
  });

  it('the audit adds no permission and no host: storage and web hosts only', async () => {
    const config = (await import('../../../wxt.config')).default as unknown as {
      manifest: { permissions?: string[]; host_permissions?: string[] };
    };
    expect(config.manifest.permissions).toEqual(['storage']);
    expect(config.manifest.host_permissions).toEqual(['http://*/*', 'https://*/*']);
  });
});

describe('type checking stays strict', () => {
  const tsconfig = JSON.parse(readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: Record<string, unknown>;
    include: string[];
  };

  it('keeps the strict flags and does not relax them', () => {
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.noUncheckedIndexedAccess).toBe(true);
    expect(tsconfig.compilerOptions.noImplicitOverride).toBe(true);
    for (const relaxed of [
      'noImplicitAny',
      'strictNullChecks',
      'skipLibCheck',
      'allowJs',
      'checkJs',
    ]) {
      expect(tsconfig.compilerOptions[relaxed], relaxed).not.toBe(false);
    }
  });

  it('includes exactly one generated declaration file, and it declares no `any`', () => {
    expect(tsconfig.include.filter((entry) => entry.endsWith('.d.ts'))).toEqual(['.wxt/wxt.d.ts']);
    expect(tsconfig.include.some((entry) => /\*\*|node_modules|\.wxt\/?$/.test(entry))).toBe(false);
    const generated = path.join(ROOT, '.wxt/types');
    if (!existsSync(generated)) return; // produced by `wxt prepare` (postinstall)
    for (const name of readdirSync(generated)) {
      const text = readFileSync(path.join(generated, name), 'utf8');
      expect(text, name).not.toMatch(
        /:\s*any\b|\bas any\b|<any>|declare (?:var|let|const)\s+\w+\s*:\s*any/,
      );
    }
  });
});
