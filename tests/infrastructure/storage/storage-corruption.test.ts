import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_USER_SETTINGS } from '@domain/models';
import { SettingsStore, parseUserSettings, type StorageBackend } from '@infrastructure/storage';

/**
 * M12 (production hardening, docs/m12/report.md "Storage"): whatever is found under the settings key, the
 * extension starts with valid settings, keeps what is recoverable, never widens behavior, and a failing storage
 * area yields a defined state. There is no schema version: the parser is the schema (field by field), so
 * "migration" is reading old shapes (pinned in schema.test.ts) and "future version" is an unknown extra field.
 */
const KEY = 'coloradapt:settings';

function backendWith(
  value: unknown,
  failures: { get?: boolean; set?: boolean } = {},
): StorageBackend {
  const data = new Map<string, unknown>(value === undefined ? [] : [[KEY, value]]);
  return {
    get: <T>(key: string) =>
      failures.get ? Promise.reject(new Error('read failed')) : Promise.resolve(data.get(key) as T),
    set: (key, v) => {
      if (failures.set) return Promise.reject(new Error('quota'));
      data.set(key, v);
      return Promise.resolve();
    },
    remove: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
    onChange: () => () => undefined,
  };
}

const MALFORMED: ReadonlyArray<[string, unknown]> = [
  ['a string (invalid JSON text stored as text)', '{"enabled": tru'],
  ['a number', 42],
  ['null', null],
  ['an array', [1, 2, 3]],
  ['an empty object (partial write)', {}],
  [
    'wrong types everywhere',
    { enabled: 'yes', visionProfile: 7, adaptationStrength: 'high', siteOverrides: 5 },
  ],
  ['an unknown enum', { visionProfile: 'superhuman', semanticAIProvider: 'cloud-gpt' }],
  ['out-of-range numbers', { adaptationStrength: 9e99 }],
  ['non-finite numbers', { adaptationStrength: Number.NaN }],
  ['a remote AI endpoint', { semanticAIEndpoint: 'https://evil.example/v1' }],
  [
    'a schema version from the future',
    { schemaVersion: 99, enabled: false, someNewThing: { a: 1 } },
  ],
  [
    'site overrides of the wrong shape',
    { siteOverrides: { 'a.test': 'x', 'b.test': null, 'c.test': [] } },
  ],
];

describe('storage corruption', () => {
  for (const [name, stored] of MALFORMED) {
    it(`${name}: loads valid settings and never turns anything on that defaults keep off`, async () => {
      const settings = await new SettingsStore(backendWith(stored)).get();
      expect(settings.adaptationStrength).toBeGreaterThanOrEqual(0);
      expect(settings.adaptationStrength).toBeLessThanOrEqual(1);
      expect(Number.isFinite(settings.adaptationStrength)).toBe(true);
      // opt-in layers stay at their defaults unless explicitly, validly stored
      expect(settings.adaptImages).toBe(DEFAULT_USER_SETTINGS.adaptImages);
      expect(settings.semanticAIEnabled).toBe(DEFAULT_USER_SETTINGS.semanticAIEnabled);
      expect(settings.semanticAIEndpoint).toBe(DEFAULT_USER_SETTINGS.semanticAIEndpoint);
      expect(settings.semanticAIProvider).toBe(DEFAULT_USER_SETTINGS.semanticAIProvider);
      expect(JSON.parse(JSON.stringify(settings))).toEqual(settings);
    });
  }

  it('keeps every recoverable field of a partly corrupt blob', async () => {
    const settings = await new SettingsStore(
      backendWith({
        enabled: false,
        visionProfile: 'tritanopia',
        adaptationStrength: 'oops',
        adaptSVG: 3,
      }),
    ).get();
    expect(settings.enabled).toBe(false);
    expect(settings.visionProfile).toBe('tritanopia');
    expect(settings.adaptationStrength).toBe(DEFAULT_USER_SETTINGS.adaptationStrength);
    expect(settings.adaptSVG).toBe(DEFAULT_USER_SETTINGS.adaptSVG);
  });

  it('a future-version blob keeps what it shares with this version; unknown fields are not kept on the next write', async () => {
    const backend = backendWith({
      enabled: false,
      visionProfile: 'protanopia',
      schemaVersion: 99,
      extra: 1,
    });
    const store = new SettingsStore(backend);
    const next = await store.update({ showWarnings: false });
    expect(next.enabled).toBe(false);
    expect(next.visionProfile).toBe('protanopia');
    const stored = (await backend.get<Record<string, unknown>>(KEY))!;
    expect(stored).not.toHaveProperty('schemaVersion');
    expect(stored).not.toHaveProperty('extra');
  });

  it('a write is sanitized: a patch cannot store a shape the schema rejects', async () => {
    const backend = backendWith(undefined);
    const store = new SettingsStore(backend);
    const next = await store.update({
      adaptationStrength: 12,
      semanticAIEndpoint: 'http://attacker.example',
      visionProfile: 'nonsense' as never,
      ...({ injected: '<script>' } as object),
    });
    expect(next.adaptationStrength).toBe(1);
    expect(next.semanticAIEndpoint).toBe(DEFAULT_USER_SETTINGS.semanticAIEndpoint);
    expect(next.visionProfile).toBe(DEFAULT_USER_SETTINGS.visionProfile);
    expect(await backend.get<object>(KEY)).not.toHaveProperty('injected');
  });

  it('a read failure rejects (the router answers undefined; the pages fail closed), a write failure stores nothing', async () => {
    await expect(new SettingsStore(backendWith({}, { get: true })).get()).rejects.toThrow(
      'read failed',
    );
    const backend = backendWith({ enabled: false }, { set: true });
    await expect(new SettingsStore(backend).update({ enabled: true })).rejects.toThrow('quota');
    expect((await backend.get<{ enabled: boolean }>(KEY))!.enabled).toBe(false);
  });

  it('parsing is idempotent and deterministic', () => {
    for (const [, stored] of MALFORMED) {
      const once = parseUserSettings(stored);
      expect(parseUserSettings(once)).toEqual(once);
      expect(parseUserSettings(stored)).toEqual(once);
    }
  });

  it('every dangerous or malformed AI endpoint form falls back to the loopback default (P53)', () => {
    const forms = [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///C:/Windows/win.ini',
      'ftp://127.0.0.1:21',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html',
      'moz-extension://5d1c9a3e-7b2f-4c11-9a55-0d6f3e8b1a42/popup.html',
      'blob:http://127.0.0.1/abc',
      '//evil.example',
      'http://[::1',
      'http://',
      'localhost:11434',
      '',
      'http://127.0.0.1.evil.example',
      'http://localhost.evil.example:11434',
      'http://0x7f.0.0.1',
      'http://2130706433',
      'http://user:pw@127.0.0.1:11434',
      42,
      null,
      { href: 'http://127.0.0.1' },
    ];
    for (const endpoint of forms) {
      expect(
        parseUserSettings({ semanticAIEndpoint: endpoint }).semanticAIEndpoint,
        JSON.stringify(endpoint),
      ).toBe(DEFAULT_USER_SETTINGS.semanticAIEndpoint);
    }
  });

  describe('diagnostics (P44, P45)', () => {
    const warn = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const recovered = (spy: ReturnType<typeof warn>) =>
      spy.mock.calls.filter((c) => String(c[0]).includes('storage-recovered'));

    it('reports which stored fields were unusable, by name only, once per distinct damage', async () => {
      const spy = warn();
      const store = new SettingsStore(
        backendWith({
          visionProfile: 'superhuman',
          adaptationStrength: 'SECRET-VALUE',
          enabled: true,
        }),
      );
      await store.get();
      await store.get();
      const calls = recovered(spy);
      expect(calls).toHaveLength(1);
      expect(calls[0]![1]).toBe('visionProfile,adaptationStrength');
      expect(JSON.stringify(spy.mock.calls)).not.toContain('SECRET-VALUE');
      spy.mockRestore();
    });

    it('is silent for a fresh install and for settings an older version stored (absent fields are not damage)', async () => {
      const spy = warn();
      await new SettingsStore(backendWith(undefined)).get();
      await new SettingsStore(backendWith({ enabled: false, visionProfile: 'tritanopia' })).get();
      expect(recovered(spy)).toHaveLength(0);
      spy.mockRestore();
    });

    it('reports a blob that is not an object', async () => {
      const spy = warn();
      await new SettingsStore(backendWith('{"enabled": tru')).get();
      expect(recovered(spy)[0]![1]).toBe('settings');
      spy.mockRestore();
    });
  });
});
