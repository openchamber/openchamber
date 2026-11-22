import { describe, expect, it } from 'vitest';
import { resolveAntigravityStoreAuth, isConfigured } from './auth.js';

describe('resolveAntigravityStoreAuth', () => {
  it('resolves the google OAuth credential with packed project context', () => {
    const auth = {
      google: { type: 'oauth', access: 'access-token', refresh: 'refresh-token|project-1|managed-1', expires: 1 }
    };
    expect(resolveAntigravityStoreAuth(auth)).toEqual({
      sourceId: 'antigravity',
      sourceLabel: 'Antigravity',
      refreshToken: 'refresh-token',
      projectId: 'project-1'
    });
  });

  it('falls back to the managed project when the packed project is empty', () => {
    const auth = { google: { type: 'oauth', refresh: 'refresh-token||managed-1' } };
    expect(resolveAntigravityStoreAuth(auth)?.projectId).toBe('managed-1');
  });

  it('resolves a bare refresh token without project context', () => {
    const auth = { google: { type: 'oauth', refresh: 'refresh-token' } };
    expect(resolveAntigravityStoreAuth(auth)).toEqual({
      sourceId: 'antigravity',
      sourceLabel: 'Antigravity',
      refreshToken: 'refresh-token',
      projectId: null
    });
  });

  it('accepts the google.oauth alias and an oauth-wrapped entry', () => {
    const auth = { 'google.oauth': { oauth: { refresh: 'refresh-token' } } };
    expect(resolveAntigravityStoreAuth(auth)?.refreshToken).toBe('refresh-token');
  });

  it('returns null for an API-key entry, which carries no refresh token', () => {
    expect(resolveAntigravityStoreAuth({ google: { type: 'api', key: 'api-key' } })).toBeNull();
  });

  it('returns null when no google login exists', () => {
    expect(resolveAntigravityStoreAuth({})).toBeNull();
    expect(resolveAntigravityStoreAuth(undefined)).toBeNull();
    expect(resolveAntigravityStoreAuth(null)).toBeNull();
  });
});

describe('isConfigured', () => {
  it('is true when the credential store holds a google OAuth login', () => {
    expect(isConfigured({ google: { type: 'oauth', refresh: 'refresh-token' } })).toBe(true);
  });
});
