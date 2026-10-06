import { describe, expect, it } from 'vitest';
import { DEFAULT_ENDPOINT, isSameLoopbackOrigin, parseLoopbackEndpoint } from '@core/semantic-ai';

describe('parseLoopbackEndpoint', () => {
  it.each([
    ['http://127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['http://127.0.0.1:11434/', 'http://127.0.0.1:11434'],
    ['http://localhost:8080', 'http://localhost:8080'],
    ['http://[::1]:1234', 'http://[::1]:1234'],
    [DEFAULT_ENDPOINT, 'http://127.0.0.1:11434'],
  ])('accepts %s', (input, origin) => {
    const parsed = parseLoopbackEndpoint(input);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.origin).toBe(origin);
  });

  const hostile = [
    'http://localhost.evil.com:8080',
    'http://127.0.0.1.evil.com:8080',
    'http://127.0.0.1@evil.com:8080',
    'http://evil.com@127.0.0.1:8080',
    'http://user:pw@127.0.0.1:8080',
    'http://127.0.0.1:8080@evil.com',
    'http://2130706433:8080',
    'http://0x7f000001:8080',
    'http://0x7f.0.0.1:8080',
    'http://017700000001:8080',
    'http://127.1:8080',
    'http://127.0.0.2:8080',
    'http://127.255.255.254:8080',
    'http://0.0.0.0:8080',
    'http://0:8080',
    'http://192.168.1.10:8080',
    'http://10.0.0.5:8080',
    'http://172.16.0.1:8080',
    'http://8.8.8.8:8080',
    'https://127.0.0.1:8080',
    'https://example.com',
    'http://[::ffff:127.0.0.1]:8080',
    'http://[0:0:0:0:0:0:0:1]:8080',
    'http://[::]:8080',
    'http://[fe80::1]:8080',
    'http://LOCALHOST:8080',
    'http://localhost.:8080',
    'http://localhost:8080/path',
    'http://localhost:8080/?x=1',
    'http://localhost:8080/#x',
    'http://localhost:8080//evil.com',
    'http://localhost',
    'http://127.0.0.1',
    'http://127.0.0.1:80',
    'http://127.0.0.1:443',
    'http://127.0.0.1:0',
    'http://127.0.0.1:99999',
    'http://127.0.0.1:08080',
    'http://127.0.0.1:+8080',
    'http://127.0.0.1:8080 ',
    ' http://127.0.0.1:8080',
    'http://127.0.0.1:8080\n',
    'http://127.0.0.1:8080\\@evil.com',
    'ftp://127.0.0.1:8080',
    'file:///etc/passwd',
    'javascript:alert(1)',
    '//127.0.0.1:8080',
    '127.0.0.1:8080',
    'localhost:8080',
    '',
  ];
  it.each(hostile)('rejects %j', (input) => {
    expect(parseLoopbackEndpoint(input).ok).toBe(false);
  });

  it('rejects non-strings', () => {
    for (const value of [undefined, null, 8080, {}, ['http://127.0.0.1:8080']]) {
      expect(parseLoopbackEndpoint(value).ok).toBe(false);
    }
  });
});

describe('isSameLoopbackOrigin', () => {
  it('compares origins exactly', () => {
    expect(isSameLoopbackOrigin('http://127.0.0.1:8080/api/chat', 'http://127.0.0.1:8080')).toBe(
      true,
    );
    expect(isSameLoopbackOrigin('https://example.com/', 'http://127.0.0.1:8080')).toBe(false);
    expect(isSameLoopbackOrigin('http://127.0.0.1:8081/', 'http://127.0.0.1:8080')).toBe(false);
    expect(isSameLoopbackOrigin('not a url', 'http://127.0.0.1:8080')).toBe(false);
  });
});
