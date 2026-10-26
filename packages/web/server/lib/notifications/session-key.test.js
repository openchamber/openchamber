import { describe, expect, it } from 'vitest';
import { sessionKeyFor, withHashedSessionKeys } from './session-key.js';

describe('push store session keys', () => {
  it('never keeps the session token itself', () => {
    const key = sessionKeyFor('eyJhbGciOiJIUzI1NiJ9.session');
    expect(key).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(key).not.toContain('eyJ');
    expect(sessionKeyFor(key)).toBe(key);
  });

  it('rehashes a file written with raw tokens and merges into existing hashed entries', () => {
    const hashed = sessionKeyFor('token-a');
    const result = withHashedSessionKeys({
      'token-a': [{ endpoint: 'old' }],
      [hashed]: [{ endpoint: 'new' }],
    });
    expect(result.changed).toBe(true);
    expect(Object.keys(result.bySession)).toEqual([hashed]);
    expect(result.bySession[hashed]).toHaveLength(2);
  });

  it('reports no change for a file that is already hashed', () => {
    const hashed = sessionKeyFor('token-a');
    expect(withHashedSessionKeys({ [hashed]: [] }).changed).toBe(false);
  });
});
