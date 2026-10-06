import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_SETTINGS } from '@domain/models';
import { parseUserSettings } from '@infrastructure/storage';

/**
 * M11 static guarantees (docs/AI_PRIVACY.md, docs/SECURITY.md): where the model runtime can be
 * reached from, what the AI code may import, and that nothing the user did not ask for switches on.
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const SOURCES = files(SRC).map((file) => ({
  file: path.relative(SRC, file).replace(/\\/g, '/'),
  text: readFileSync(file, 'utf8'),
}));
const AI = SOURCES.filter(({ file }) => file.startsWith('core/semantic-ai/'));
const find = (pattern: RegExp, among = SOURCES): string[] =>
  among.filter(({ text }) => pattern.test(text)).map(({ file }) => file);

describe('M11 network boundary', () => {
  it('makes a request from one place only, and that place refuses redirects and credentials', () => {
    expect(find(/\bfetch\s*\(/, AI)).toEqual(['core/semantic-ai/local-provider.ts']);
    const provider = AI.find(({ file }) => file === 'core/semantic-ai/local-provider.ts')!;
    expect(provider.text).toMatch(/redirect: 'error'/);
    expect(provider.text).toMatch(/credentials: 'omit'/);
    expect(provider.text).toMatch(/referrerPolicy: 'no-referrer'/);
    expect(provider.text).toMatch(/parseLoopbackEndpoint\(options\.endpoint\)/);
  });

  it('names no remote AI service and has no URL of its own to call', () => {
    expect(
      find(
        /openai\.com|anthropic\.com|googleapis\.com|generativelanguage|api\.cohere|mistral\.ai|huggingface\.co/i,
      ),
    ).toEqual([]);
    // The only URL literals in the AI code are the loopback default and its origin template, in endpoint.ts.
    const urls = AI.filter(({ file }) => file !== 'core/semantic-ai/endpoint.ts').flatMap(
      ({ file, text }) =>
        [...text.matchAll(/['"`](https?:\/\/[^'"`\s]+)['"`]/g)].map((m) => `${file}: ${m[1]}`),
    );
    expect(urls).toEqual([]);
  });

  it('keeps the provider and the engine out of every page-facing bundle', () => {
    const onlyAuditAndOptions =
      /\b(createSemanticProvider|LocalSemanticProvider|SemanticAssistEngine|MockSemanticProvider)\b/;
    const users = find(onlyAuditAndOptions).filter((file) => !file.startsWith('core/semantic-ai/'));
    expect(users).toEqual(['entrypoints/audit/use-semantic-assist.ts']);
  });

  it('adds no permission and no web-accessible resource', () => {
    const config = readFileSync(path.join(ROOT, 'wxt.config.ts'), 'utf8');
    expect(config).toMatch(/permissions: \['storage'\]/);
    expect(config).toMatch(/host_permissions: \['http:\/\/\*\/\*', 'https:\/\/\*\/\*'\]/);
    expect(config).not.toMatch(
      /optional_host_permissions|optional_permissions|web_accessible_resources/,
    );
    expect(config).not.toMatch(/unsafe-eval|unsafe-inline/);
  });
});

describe('M11 code boundary', () => {
  it('imports nothing from the browser, features or infrastructure layers', () => {
    const bad = AI.flatMap(({ file, text }) =>
      [...text.matchAll(/from '(@features|@infrastructure|wxt)[^']*'/g)].map(
        (m) => `${file}: ${m[0]}`,
      ),
    );
    expect(bad).toEqual([]);
  });

  it('is not imported by the deterministic audit core', () => {
    const audit = SOURCES.filter(({ file }) => file.startsWith('core/audit/'));
    expect(find(/@core\/semantic-ai|\.\.\/semantic-ai/, audit)).toEqual([]);
  });

  it('never stores, evaluates or touches the page', () => {
    expect(find(/\b(localStorage|sessionStorage|indexedDB|document|window)\b/, AI)).toEqual([]);
    expect(find(/\bbrowser\s*\./, AI)).toEqual([]);
    expect(find(/\beval\s*\(|new\s+Function\s*\(|innerHTML|insertAdjacentHTML/, AI)).toEqual([]);
  });

  it('does not let the model name a DOM, CSS or navigation action', () => {
    // The output schema has no field for one: pinned by output.test.ts (unknown fields are model errors).
    const output = AI.find(({ file }) => file === 'core/semantic-ai/output.ts')!;
    expect(output.text).toMatch(/unknown-field/);
    expect(
      find(/setAttribute|classList|style\.|querySelector|dispatchEvent|location\./, AI),
    ).toEqual([]);
  });

  it('keeps the audit page the only reader of the setting that turns the review on', () => {
    const readers = find(/semanticAIEnabled/).filter(
      (file) =>
        !file.startsWith('domain/') &&
        !file.startsWith('infrastructure/storage/') &&
        file !== 'entrypoints/options/App.tsx',
    );
    expect(readers).toEqual(['entrypoints/audit/use-semantic-assist.ts']);
  });
});

describe('M11 defaults', () => {
  it('is off, local and on the default Ollama loopback address', () => {
    expect(DEFAULT_USER_SETTINGS.semanticAIEnabled).toBe(false);
    expect(DEFAULT_USER_SETTINGS.semanticAIProvider).toBe('local-ollama');
    expect(DEFAULT_USER_SETTINGS.semanticAIEndpoint).toBe('http://127.0.0.1:11434');
    expect(DEFAULT_USER_SETTINGS.semanticAIModel).toBe('');
  });

  it('does not switch on after an upgrade from settings that never had the fields', () => {
    const old = { enabled: true, visionProfile: 'deuteranopia', adaptImages: true };
    const parsed = parseUserSettings(old);
    expect(parsed.semanticAIEnabled).toBe(false);
    expect(parsed.visionProfile).toBe('deuteranopia');
  });

  it('keeps only a loopback endpoint from storage and replaces anything else by the default', () => {
    for (const endpoint of [
      'https://api.example.com',
      'http://localhost.evil.com:8080',
      'http://127.0.0.1@evil.com:8080',
      'http://192.168.0.5:8080',
      42,
      null,
    ]) {
      const parsed = parseUserSettings({ semanticAIEnabled: true, semanticAIEndpoint: endpoint });
      expect(parsed.semanticAIEndpoint).toBe(DEFAULT_USER_SETTINGS.semanticAIEndpoint);
    }
    expect(parseUserSettings({ semanticAIEndpoint: 'http://[::1]:1234/' }).semanticAIEndpoint).toBe(
      'http://[::1]:1234',
    );
  });

  it('accepts only the known providers and plain model names', () => {
    expect(parseUserSettings({ semanticAIProvider: 'openai' }).semanticAIProvider).toBe(
      'local-ollama',
    );
    expect(parseUserSettings({ semanticAIProvider: 'local-http' }).semanticAIProvider).toBe(
      'local-http',
    );
    expect(parseUserSettings({ semanticAIModel: 'llama3.2:3b' }).semanticAIModel).toBe(
      'llama3.2:3b',
    );
    expect(parseUserSettings({ semanticAIModel: 'x'.repeat(200) }).semanticAIModel).toBe('');
    expect(parseUserSettings({ semanticAIModel: '<script>' }).semanticAIModel).toBe('');
  });

  it('gives a site no way to touch the AI settings', () => {
    const parsed = parseUserSettings({
      siteOverrides: { 'a.test': { enabled: true, semanticAIEnabled: true } },
    });
    expect(parsed.semanticAIEnabled).toBe(false);
    expect(Object.keys(parsed.siteOverrides['a.test'] ?? {})).not.toContain('semanticAIEnabled');
  });
});
