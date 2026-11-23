import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { resolveAntigravityStoreAuth, isConfigured, resolveAntigravityAuth, parseAntigravityKeyringCredential, resolveAntigravityKeyringAuth, configureAntigravityKeyringSources } from './auth.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANTIGRAVITY_ACCOUNTS_PATHS } from '../../utils/index.js';


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

describe('parseAntigravityKeyringCredential', () => {
  it('resolves the agy token record with packed project context', () => {
    const raw = JSON.stringify({ token: { access_token: 'agy-access', refresh_token: 'keyring-refresh|project-1|managed-1', expiry: '2030-01-01T00:00:00Z' } });
    expect(parseAntigravityKeyringCredential(raw)).toEqual({
      sourceId: 'antigravity',
      sourceLabel: 'Antigravity',
      refreshToken: 'keyring-refresh',
      projectId: 'project-1'
    });
  });

  it('falls back to the managed project when the packed project is empty', () => {
    const raw = JSON.stringify({ token: { refresh_token: 'keyring-refresh||managed-1' } });
    expect(parseAntigravityKeyringCredential(raw)?.projectId).toBe('managed-1');
  });

  it('resolves a bare refresh token without project context', () => {
    const raw = JSON.stringify({ token: { refresh_token: 'keyring-refresh' } });
    expect(parseAntigravityKeyringCredential(raw)).toEqual({
      sourceId: 'antigravity',
      sourceLabel: 'Antigravity',
      refreshToken: 'keyring-refresh',
      projectId: null
    });
  });

  it('returns null for absent, malformed and refresh-less records', () => {
    for (const raw of [
      undefined,
      '',
      'not json',
      '{}',
      '{"token":{}}',
      '{"token":{"access_token":"agy-access"}}',
      '{"token":{"refresh_token":"   "}}',
      '{"token":{"refresh_token":42}}',
      '{"token":"token-as-string"}'
    ]) {
      expect(parseAntigravityKeyringCredential(raw)).toBeNull();
    }
  });
});

describe('resolveAntigravityKeyringAuth', () => {
  afterEach(() => {
    configureAntigravityKeyringSources(null);
  });

  it('reads the gemini/antigravity entry through the configured lookup', async () => {
    const seen = [];
    configureAntigravityKeyringSources({
      lookupSecretService: async (service, username) => {
        seen.push([service, username]);
        return JSON.stringify({ token: { refresh_token: 'keyring-refresh' } });
      }
    });
    await expect(resolveAntigravityKeyringAuth()).resolves.toMatchObject({ refreshToken: 'keyring-refresh' });
    expect(seen).toEqual([['gemini', 'antigravity']]);
  });

  it('resolves to null when the lookup finds nothing or fails', async () => {
    configureAntigravityKeyringSources({ lookupSecretService: async () => undefined });
    await expect(resolveAntigravityKeyringAuth()).resolves.toBeNull();
    configureAntigravityKeyringSources({
      lookupSecretService: async () => {
        throw new Error('no session bus');
      }
    });
    await expect(resolveAntigravityKeyringAuth()).resolves.toBeNull();
  });
});

describe('isConfigured', () => {
  beforeEach(() => {
    ANTIGRAVITY_ACCOUNTS_PATHS.splice(0, ANTIGRAVITY_ACCOUNTS_PATHS.length);
    configureAntigravityKeyringSources({ lookupSecretService: async () => undefined });
  });

  afterEach(() => {
    ANTIGRAVITY_ACCOUNTS_PATHS.splice(0, ANTIGRAVITY_ACCOUNTS_PATHS.length, ...originalPaths);
    configureAntigravityKeyringSources(null);
  });

  it('is true when the credential store holds a google OAuth login', async () => {
    await expect(isConfigured({ google: { type: 'oauth', refresh: 'refresh-token' } })).resolves.toBe(true);
  });

  it('is true when only the agy keyring login exists', async () => {
    configureAntigravityKeyringSources({
      lookupSecretService: async () => JSON.stringify({ token: { refresh_token: 'keyring-refresh' } })
    });
    await expect(isConfigured({})).resolves.toBe(true);
  });

  it('is false when no source holds a login', async () => {
    await expect(isConfigured({})).resolves.toBe(false);
  });
});

// ---- upstream tests ----

const originalPaths = [...ANTIGRAVITY_ACCOUNTS_PATHS];
let directory;
let firstPath;
let secondPath;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'antigravity-auth-'));
  firstPath = join(directory, 'first.json');
  secondPath = join(directory, 'second.json');
  ANTIGRAVITY_ACCOUNTS_PATHS.splice(0, ANTIGRAVITY_ACCOUNTS_PATHS.length, firstPath, secondPath);
});

afterEach(() => {
  ANTIGRAVITY_ACCOUNTS_PATHS.splice(0, ANTIGRAVITY_ACCOUNTS_PATHS.length, ...originalPaths);
  rmSync(directory, { recursive: true, force: true });
});

describe('Antigravity accounts file boundary', () => {
  it('skips absent, primitive and empty accounts files', () => {
    for (const value of [null, false, 3, 'text', [], {}, { accounts: [] }, { accounts: 'constructor' }]) {
      writeFileSync(firstPath, JSON.stringify(value));
      expect(resolveAntigravityAuth()).toBeNull();
    }
  });

  it('keeps active-account fallback and packed project context', () => {
    writeFileSync(firstPath, JSON.stringify({
      activeIndex: '99',
      accounts: [{ refreshToken: 'token|packed-project|managed-project', email: 42 }],
    }));
    expect(resolveAntigravityAuth()).toEqual({
      sourceId: 'antigravity',
      sourceLabel: 'Antigravity',
      refreshToken: 'token',
      projectId: 'packed-project',
      email: 42,
    });
  });

  it('keeps a truthy non-string refresh token configured with a null parsed token', () => {
    writeFileSync(firstPath, JSON.stringify({ accounts: [{ refreshToken: 42 }] }));
    expect(resolveAntigravityAuth()).toEqual({
      sourceId: 'antigravity',
      sourceLabel: 'Antigravity',
      refreshToken: null,
      projectId: null,
      email: undefined,
    });
  });

  it('continues to the next file when the selected account has no token', () => {
    writeFileSync(firstPath, JSON.stringify({ accounts: [null, { refreshToken: 'unused' }] }));
    writeFileSync(secondPath, JSON.stringify({ accounts: [{ refreshToken: 'selected', managedProjectId: 'managed' }] }));
    expect(resolveAntigravityAuth()?.projectId).toBe('managed');
  });
});
