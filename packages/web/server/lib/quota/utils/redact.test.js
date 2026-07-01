import { describe, expect, it } from 'vitest';

import {
  redactCookie,
  redactToken,
  redactApiKey,
  redactHeaders,
  redactObject,
} from './redact.js';

describe('redactCookie', () => {
  it('redacts cookie values while preserving names', () => {
    expect(redactCookie('session=abc123; token=xyz789')).toBe(
      'session=[REDACTED]; token=[REDACTED]'
    );
  });

  it('preserves spacing in cookie strings', () => {
    expect(redactCookie('a=1; b=2')).toBe('a=[REDACTED]; b=[REDACTED]');
  });

  it('preserves cookies without values', () => {
    expect(redactCookie('flag')).toBe('flag');
    expect(redactCookie('flag; session=abc')).toBe('flag; session=[REDACTED]');
  });

  it('handles empty and invalid input', () => {
    expect(redactCookie('')).toBe('');
    expect(redactCookie(null)).toBe('');
    expect(redactCookie(undefined)).toBe('');
    expect(redactCookie(123)).toBe('');
  });
});

describe('redactToken', () => {
  it('redacts sk- tokens preserving prefix and last 4 chars', () => {
    expect(redactToken('sk-abcdefghijklmnop')).toBe('sk-****mnop');
  });

  it('redacts non-sk tokens showing only last 4 chars', () => {
    expect(redactToken('abcdefghijklmnop')).toBe('****mnop');
  });

  it('returns **** for short tokens', () => {
    expect(redactToken('short')).toBe('****');
    expect(redactToken('sk-abc')).toBe('****');
  });

  it('returns **** for sk- tokens too short to safely preserve prefix', () => {
    // 8 chars: sk- + 5 chars — not enough to safely preserve sk- prefix
    expect(redactToken('sk-abcde')).toBe('****bcde');
  });

  it('handles empty and invalid input', () => {
    expect(redactToken('')).toBe('****');
    expect(redactToken(null)).toBe('****');
    expect(redactToken(undefined)).toBe('****');
    expect(redactToken(123)).toBe('****');
  });

  it('never returns the original token', () => {
    const token = 'sk-super-secret-token-value-1234';
    const redacted = redactToken(token);
    expect(redacted).not.toBe(token);
    expect(redacted).toContain('****');
    expect(redacted).not.toContain('super-secret');
  });
});

describe('redactApiKey', () => {
  it('redacts API keys showing first 4 and last 4', () => {
    expect(redactApiKey('1234567890123456')).toBe('1234****3456');
  });

  it('returns **** for short keys', () => {
    expect(redactApiKey('short')).toBe('****');
    expect(redactApiKey('12345678')).toBe('****');
    expect(redactApiKey('12345678901')).toBe('****');
  });

  it('handles keys exactly 12 chars', () => {
    expect(redactApiKey('123456789012')).toBe('1234****9012');
  });

  it('handles empty and invalid input', () => {
    expect(redactApiKey('')).toBe('****');
    expect(redactApiKey(null)).toBe('****');
    expect(redactApiKey(undefined)).toBe('****');
    expect(redactApiKey(123)).toBe('****');
  });

  it('never returns the original key', () => {
    const key = 'ak_super_secret_api_key_value_9999';
    const redacted = redactApiKey(key);
    expect(redacted).not.toBe(key);
    expect(redacted).toContain('****');
    expect(redacted).not.toContain('super_secret');
  });
});

describe('redactHeaders', () => {
  it('redacts Authorization header', () => {
    const result = redactHeaders({
      Authorization: 'Bearer secret',
      'Content-Type': 'json',
    });
    expect(result.Authorization).toBe('[REDACTED]');
    expect(result['Content-Type']).toBe('json');
  });

  it('redacts Cookie header', () => {
    const result = redactHeaders({
      Cookie: 'session=abc123',
      Accept: 'application/json',
    });
    expect(result.Cookie).toBe('[REDACTED]');
    expect(result.Accept).toBe('application/json');
  });

  it('redacts sensitive headers case-insensitively', () => {
    const result = redactHeaders({
      authorization: 'Bearer x',
      COOKIE: 'a=b',
      'X-API-KEY': 'key',
    });
    expect(result.authorization).toBe('[REDACTED]');
    expect(result.COOKIE).toBe('[REDACTED]');
    expect(result['X-API-KEY']).toBe('[REDACTED]');
  });

  it('preserves non-sensitive headers', () => {
    const result = redactHeaders({
      'Content-Type': 'application/json',
      Accept: 'text/html',
      'X-Request-Id': 'abc-123',
    });
    expect(result).toEqual({
      'Content-Type': 'application/json',
      Accept: 'text/html',
      'X-Request-Id': 'abc-123',
    });
  });

  it('handles empty and invalid input', () => {
    expect(redactHeaders(null)).toEqual({});
    expect(redactHeaders(undefined)).toEqual({});
    expect(redactHeaders({})).toEqual({});
    expect(redactHeaders('string')).toEqual({});
  });
});

describe('redactObject', () => {
  it('redacts sensitive keys recursively in nested objects', () => {
    const result = redactObject({
      username: 'alice',
      token: 'secret123',
      nested: {
        apiKey: 'key123',
        safe: 'value',
        deeply: {
          secret: 'hidden',
        },
      },
    });
    expect(result.username).toBe('alice');
    expect(result.token).toBe('[REDACTED]');
    expect(result.nested.apiKey).toBe('[REDACTED]');
    expect(result.nested.safe).toBe('value');
    expect(result.nested.deeply.secret).toBe('[REDACTED]');
  });

  it('handles arrays', () => {
    const result = redactObject([
      { token: 'a', safe: 'b' },
      { password: 'c' },
    ]);
    expect(result[0].token).toBe('[REDACTED]');
    expect(result[0].safe).toBe('b');
    expect(result[1].password).toBe('[REDACTED]');
  });

  it('redacts keys case-insensitively via substring match', () => {
    const result = redactObject({
      AccessToken: 'abc',
      refreshToken: 'def',
      api_key: 'ghi',
      safeField: 'ok',
    });
    expect(result.AccessToken).toBe('[REDACTED]');
    expect(result.refreshToken).toBe('[REDACTED]');
    expect(result.api_key).toBe('[REDACTED]');
    expect(result.safeField).toBe('ok');
  });

  it('accepts custom sensitive keys', () => {
    const result = redactObject(
      { custom: 'x', safe: 'y' },
      ['custom']
    );
    expect(result.custom).toBe('[REDACTED]');
    expect(result.safe).toBe('y');
  });

  it('handles empty and invalid input', () => {
    expect(redactObject(null)).toBeNull();
    expect(redactObject(undefined)).toBeUndefined();
    expect(redactObject('string')).toBe('string');
    expect(redactObject(42)).toBe(42);
    expect(redactObject(true)).toBe(true);
  });

  it('preserves Date and RegExp objects', () => {
    const date = new Date();
    const regex = /test/;
    expect(redactObject(date)).toBe(date);
    expect(redactObject(regex)).toBe(regex);
  });

  it('never returns original sensitive values', () => {
    const obj = { token: 'sk-super-secret', password: 'hunter2' };
    const result = redactObject(obj);
    expect(result.token).toBe('[REDACTED]');
    expect(result.password).toBe('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain('super-secret');
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });
});
